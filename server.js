/* server.js — Prompt-driven voice agent (transport + thin tools only)
   - JS streams audio, calls the model, and executes tool HTTP calls verbatim.
   - No business rules in JS. All policy lives in the prompt/config.
   - Keeps CAL_* payloads and endpoints unchanged for Replit integration.
*/

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

dotenv.config();

/* ===== Env / Config (fail fast) ===== */
const PORT = process.env.PORT || 5000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_CALLER_ID   = process.env.TWILIO_CALLER_ID   || "";
const OWNER_PHONE        = process.env.OWNER_PHONE        || "";

const DASH_BIZ    = process.env.DASH_BIZ || "The Victory Team";
const DASH_SOURCE = process.env.DASH_SOURCE || "voice";
const BIZ_TZ      = process.env.BIZ_TZ || "America/New_York";

const PRE_CONNECT_GREETING = process.env.PRE_CONNECT_GREETING || "";

const URLS = {
  CAL_READ:     process.env.REPLIT_READ_URL     || process.env.DASH_CAL_READ_URL     || "",
  CAL_CREATE:   process.env.REPLIT_CREATE_URL   || process.env.DASH_CAL_CREATE_URL   || "",
  CAL_DELETE:   process.env.REPLIT_DELETE_URL   || process.env.DASH_CAL_CANCEL_URL   || "",
  LEAD_UPSERT:  process.env.REPLIT_LEAD_URL     || process.env.DASH_LEAD_UPSERT_URL  || "",
  FAQ_LOG:      process.env.REPLIT_FAQ_URL      || process.env.DASH_CALL_LOG_URL     || "",
  CALL_LOG:     process.env.DASH_CALL_LOG_URL   || "",
  CALL_SUMMARY: process.env.DASH_CALL_SUMMARY_URL || "",
  PROMPT_FETCH: process.env.PROMPT_FETCH_URL    || ""
};

function requireEnv(name, val) {
  if (!val) { console.error(`[ENV] Missing ${name}`); process.exit(1); }
}
requireEnv("OPENAI_API_KEY", OPENAI_API_KEY);
requireEnv("DEEPGRAM_API_KEY", DEEPGRAM_API_KEY);
requireEnv("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);
requireEnv("ELEVENLABS_VOICE_ID", ELEVENLABS_VOICE_ID);
// Calendar URLs optional. Warn if missing:
["CAL_READ","CAL_CREATE","CAL_DELETE"].forEach(k => { if (!URLS[k]) console.warn(`[WARN] ${k} not set`); });

/* ===== HTTP helpers ===== */
const DEBUG_HTTP = (process.env.DEBUG_HTTP ?? "true") === "true";
function rid(){ return Math.random().toString(36).slice(2,8); }
function preview(obj, max=320){ try { const s = typeof obj==="string"?obj:JSON.stringify(obj); return s.length>max? s.slice(0,max)+"…" : s; } catch { return ""; } }
async function httpPost(url, data, { headers={}, timeout=12000, auth, tag } = {}) {
  const id = rid(), t = Date.now();
  if (DEBUG_HTTP) console.log(JSON.stringify({ evt:"HTTP_REQ", id, tag, method:"POST", url, timeout, payload_len: Buffer.byteLength(preview(data, 1<<20),"utf8") }));
  try {
    const resp = await axios.post(url, data, { headers, timeout, auth, responseType: headers.acceptStream ? "stream" : undefined });
    if (DEBUG_HTTP) console.log(JSON.stringify({ evt:"HTTP_RES", id, tag, method:"POST", url, status:resp.status, ms:Date.now()-t, resp_preview: headers.acceptStream ? "[stream]" : preview(resp.data) }));
    return resp;
  } catch(e){
    const status = e.response?.status || 0;
    const bodyPrev = e.response ? preview(e.response.data) : "";
    console.warn(JSON.stringify({ evt:"HTTP_ERR", id, tag, method:"POST", url, status, ms:Date.now()-t, message:e.message, resp_preview: bodyPrev }));
    throw e;
  }
}
async function httpGet(url, { headers={}, timeout=12000, params, auth, tag } = {}) {
  const id = rid(), t = Date.now();
  if (DEBUG_HTTP) console.log(JSON.stringify({ evt:"HTTP_REQ", id, tag, method:"GET", url, timeout, params }));
  try {
    const resp = await axios.get(url, { headers, timeout, params, auth });
    if (DEBUG_HTTP) console.log(JSON.stringify({ evt:"HTTP_RES", id, tag, method:"GET", url, status:resp.status, ms:Date.now()-t, resp_preview: preview(resp.data) }));
    return resp;
  } catch(e){
    const status = e.response?.status || 0;
    const bodyPrev = e.response ? preview(e.response.data) : "";
    console.warn(JSON.stringify({ evt:"HTTP_ERR", id, tag, method:"GET", url, status, ms:Date.now()-t, message:e.message, resp_preview: bodyPrev }));
    throw e;
  }
}

/* ===== Minimal TZ helpers ===== */
function todayISOInTZ(tz){
  const f = new Intl.DateTimeFormat("en-CA",{ timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = f.formatToParts(new Date()).reduce((a,x)=> (a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function dayWindowLocal(dateISO, tz) {
  const start_utc = new Date(`${dateISO}T00:00:00`).toISOString();
  const end_utc   = new Date(`${dateISO}T23:59:00`).toISOString();
  return { start_local: `${dateISO} 00:00`, end_local: `${dateISO} 23:59`, start_utc, end_utc, timezone: tz };
}
function isoToLocalYYYYMMDDHHmm(iso, tz) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12:false
  });
  const p = f.formatToParts(d).reduce((a,x)=> (a[x.type]=x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/* ===== App / TwiML ===== */
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

app.get("/", (_req,res) => res.status(200).send("OK: Prompt-driven Voice Agent"));
app.get("/healthz", (_req,res) => res.status(200).send("ok"));

function escapeXml(s=""){ return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":"&apos;"}[c])); }

app.post("/twiml", (req,res) => {
  const from = req.body?.From || "";
  const callSid = req.body?.CallSid || "";
  res.set("Content-Type","text/xml");
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
  const optSay = PRE_CONNECT_GREETING ? `<Say>${escapeXml(PRE_CONNECT_GREETING)}</Say>` : "";
  const statusCb = process.env.STATUS_CALLBACK_URL ? `<StatusCallback url="${process.env.STATUS_CALLBACK_URL}" />` : "";
  res.send(`
    <Response>
      ${optSay}
      <Connect>
        <Stream url="wss://${host}" track="inbound_track">
          <Parameter name="from" value="${from}"/>
          <Parameter name="CallSid" value="${callSid}"/>
          <Parameter name="callSid" value="${callSid}"/>
        </Stream>
      </Connect>
      ${statusCb}
    </Response>
  `.trim());
});

app.post("/handoff", (_req,res) => {
  const from = TWILIO_CALLER_ID || "";
  res.type("text/xml").send(`
    <Response>
      <Dial callerId="${from}">
        <Number>${OWNER_PHONE}</Number>
      </Dial>
    </Response>
  `.trim());
});

const server = app.listen(PORT, () => {
  console.log(`[INIT] listening on ${PORT}`);
  console.log("[INIT] URLS", URLS);
  console.log("[INIT] TENANT", { DASH_BIZ, DASH_SOURCE, BIZ_TZ });
});

/* ===== WS server (singleton) ===== */
let wss = globalThis.__victory_wss;
if (!wss) {
  wss = new WebSocketServer({ server, perMessageDeflate:false });
  globalThis.__victory_wss = wss;
}

/* ===== Transport state ===== */
const CALLS = new Map();

/* ===== Deepgram (single connection) ===== */
function newDeepgram(onFinal) {
  const url = "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2-phonecall&interim_results=true&smart_format=true&endpointing=900";
  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }, // "Token" is expected by Deepgram
    perMessageDeflate: false
  });
  dg.on("message", (data)=>{
    try{
      const ev = JSON.parse(data.toString());
      const alt = ev.channel?.alternatives?.[0];
      const text = (alt?.transcript || "").trim();
      if (!text) return;
      if (ev.is_final || ev.speech_final) onFinal?.(text);
    }catch{}
  });
  dg.on("error", (e)=> console.warn("[Deepgram error]", e.message));
  return dg;
}

/* ===== ElevenLabs TTS (μ-law passthrough) ===== */
function cleanTTS(s=""){
  return String(s)
    .replace(/\*\*(.*?)\*\*/g,"$1")
    .replace(/`{1,3}[^`]*`{1,3}/g,"")
    .replace(/\[(.*?)\]\((.*?)\)/g,"$1")
    .replace(/\s{2,}/g," ")
    .trim();
}
async function speakULaw(ws, text){
  if (!text || !ws.__streamSid) return;
  const clean = cleanTTS(text);
  try{
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await httpPost(url, { text: clean }, { headers:{ "xi-api-key":ELEVENLABS_API_KEY, acceptStream:true }, timeout:20000, tag:"TTS_STREAM" });
    resp.data.on("data", chunk => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const b64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event:"media", streamSid:ws.__streamSid, media:{ payload:b64 } }));
    });
  } catch(e){ console.error("[TTS ERROR]", e.message); }
}

/* ===== LLM ===== */
const toolSchema = [
  { type:"function", function:{
    name:"read_availability",
    description:"Read calendar availability within a window. If only dateISO is supplied, the whole local day is returned.",
    parameters:{ type:"object", properties:{
      dateISO:{type:"string", description:"YYYY-MM-DD in business timezone"},
      startISO:{type:"string"}, endISO:{type:"string"},
      name:{type:"string"}, phone:{type:"string"}
    }, required:[] }
  }},
  { type:"function", function:{
    name:"book_appointment",
    description:"Create a calendar event. The model must pass the exact startISO/endISO it wants.",
    parameters:{ type:"object", properties:{
      name:{type:"string"}, phone:{type:"string"}, service:{type:"string"},
      startISO:{type:"string"}, endISO:{type:"string"}, notes:{type:"string"}
    }, required:["service","startISO","endISO"] }
  }},
  { type:"function", function:{
    name:"cancel_appointment",
    description:"Cancel a calendar event. Prefer event_id. If not provided, backend may return candidates.",
    parameters:{ type:"object", properties:{
      event_id:{type:"string"}, name:{type:"string"}, phone:{type:"string"}, dateISO:{type:"string"}
    }, required:[] }
  }},
  { type:"function", function:{
    name:"find_customer_events",
    description:"Find upcoming events for a contact over a horizon. Pure pass-through.",
    parameters:{ type:"object", properties:{
      name:{type:"string"}, phone:{type:"string"}, days:{type:"number"}
    }, required:[] }
  }},
  { type:"function", function:{
    name:"lead_upsert",
    description:"Create or update a lead/contact.",
    parameters:{ type:"object", properties:{
      name:{type:"string"}, phone:{type:"string"}, intent:{type:"string"}, notes:{type:"string"}
    }, required:["name","phone"] }
  }},
  { type:"function", function:{
    name:"faq",
    description:"Log FAQs for analytics.",
    parameters:{ type:"object", properties:{ topic:{type:"string"}, service:{type:"string"} }, required:[] }
  }},
  { type:"function", function:{
    name:"transfer",
    description:"Transfer the caller to a human.",
    parameters:{ type:"object", properties:{ reason:{type:"string"}, callSid:{type:"string"} }, required:[] }
  }},
  { type:"function", function:{
    name:"end_call",
    description:"Hang up the call when the caller is done.",
    parameters:{ type:"object", properties:{ callSid:{type:"string"}, reason:{type:"string"} }, required:[] }
  }}
];

async function openaiChat(messages, options={}){
  const headers = { Authorization:`Bearer ${OPENAI_API_KEY}` };
  const body = { model:"gpt-4o-mini", temperature:0.3, messages, tools:toolSchema, tool_choice:"auto", response_format:{ type:"text" }, ...options };
  const { data } = await httpPost("https://api.openai.com/v1/chat/completions", body, { headers, timeout:30000, tag:"OPENAI_CHAT" });
  return data.choices?.[0];
}

/* ===== Tool implementations (thin wrappers, no logic) ===== */
const Tools = {
  async read_availability({ dateISO, startISO, endISO, name, phone }) {
    if (!URLS.CAL_READ) return { ok:false, error:"CAL_READ_URL_MISSING" };
    let windowObj;
    if (startISO && endISO) windowObj = { start_utc:startISO, end_utc:endISO };
    else if (dateISO) windowObj = dayWindowLocal(dateISO, BIZ_TZ);
    else windowObj = dayWindowLocal(todayISOInTZ(BIZ_TZ), BIZ_TZ);

    const payload = { intent:"READ", biz:DASH_BIZ, source:DASH_SOURCE, timezone:BIZ_TZ, window:windowObj, contact_name:name, contact_phone:phone };
    try {
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000, tag:"CAL_READ" });
      return { ok:true, data };
    } catch(e){ return { ok:false, status:e.response?.status||0, error:"READ_FAILED", body: e.response?.data }; }
  },

  async book_appointment({ name, phone, service, startISO, endISO, notes }) {
    if (!URLS.CAL_CREATE) return { ok:false, error:"CAL_CREATE_URL_MISSING" };
    const startLocal = isoToLocalYYYYMMDDHHmm(startISO, BIZ_TZ);
    const endLocal   = isoToLocalYYYYMMDDHHmm(endISO,   BIZ_TZ);
    const payload = {
      biz: DASH_BIZ,
      source: DASH_SOURCE,
      Event_Name: `${service||"Appointment"} (${name||"Guest"})`,
      Timezone: BIZ_TZ,
      Start_Time_Local: startLocal,
      End_Time_Local:   endLocal,
      Start_Time_UTC:   startISO,
      End_Time_UTC:     endISO,
      Customer_Name: name||"",
      Customer_Phone: phone||"",
      Customer_Email: "",
      Notes: notes||service||""
    };
    try {
      const { data } = await httpPost(URLS.CAL_CREATE, payload, { timeout:12000, tag:"CAL_CREATE" });
      return { ok:true, data };
    } catch(e){ return { ok:false, status:e.response?.status||0, error:"CREATE_FAILED", body:e.response?.data }; }
  },

  async cancel_appointment({ event_id, name, phone, dateISO }) {
    if (!URLS.CAL_DELETE) return { ok:false, error:"CAL_DELETE_URL_MISSING" };
    try {
      const { data, status } = await httpPost(URLS.CAL_DELETE, {
        intent:"DELETE", biz:DASH_BIZ, source:DASH_SOURCE, event_id, name, phone, dateISO
      }, { timeout:12000, tag:"CAL_DELETE" });
      const ok = (status>=200&&status<300) || data?.ok === true || data?.deleted === true || data?.cancelled === true;
      return { ok, data };
    } catch(e){ return { ok:false, status:e.response?.status||0, error:"DELETE_FAILED", body:e.response?.data }; }
  },

  async find_customer_events({ name, phone, days=30 }) {
    if (!URLS.CAL_READ) return { ok:false, error:"CAL_READ_URL_MISSING", events:[] };
    const base = todayISOInTZ(BIZ_TZ);
    const w = dayWindowLocal(base, BIZ_TZ);
    const payload = { intent:"READ", biz:DASH_BIZ, source:DASH_SOURCE, timezone:BIZ_TZ, window:w, contact_name:name, contact_phone:phone, days };
    try {
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000, tag:"CAL_READ_FIND" });
      return { ok:true, events: data?.events || [], data };
    } catch(e){ return { ok:false, status:e.response?.status||0, error:"FIND_FAILED", events:[], body:e.response?.data }; }
  },

  async lead_upsert({ name, phone, intent, notes }) {
    if (!URLS.LEAD_UPSERT) return { ok:false, error:"LEAD_URL_MISSING" };
    try {
      const { data } = await httpPost(URLS.LEAD_UPSERT, { biz:DASH_BIZ, source:DASH_SOURCE, name, phone, intent, notes }, { timeout:8000, tag:"LEAD_UPSERT" });
      return { ok:true, data };
    } catch(e){ return { ok:false, status:e.response?.status||0, error:"LEAD_FAILED", body:e.response?.data }; }
  },

  async faq({ topic, service }) {
    try {
      if (URLS.FAQ_LOG) await httpPost(URLS.FAQ_LOG, { biz:DASH_BIZ, source:DASH_SOURCE, topic, service }, { timeout:8000, tag:"FAQ_LOG" });
    } catch {}
    return { ok:true };
  },

  async transfer({ reason, callSid }) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OWNER_PHONE || !callSid) return { ok:false, error:"TRANSFER_CONFIG_MISSING" };
    try {
      const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
      const handoffUrl = `https://${host}/handoff`;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Url: handoffUrl, Method:"POST" });
      await httpPost(url, params, { auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN }, timeout:10000, tag:"TWILIO_REDIRECT", headers:{ "Content-Type":"application/x-www-form-urlencoded" } });
      return { ok:true };
    } catch(e){ return { ok:false, error:"TRANSFER_FAILED", status:e.response?.status||0, body:e.response?.data }; }
  },

  async end_call({ callSid, reason }) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return { ok:false, error:"HANGUP_CONFIG_MISSING" };
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Status:"completed" });
      await httpPost(url, params, { auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN }, timeout:8000, tag:"TWILIO_HANGUP", headers:{ "Content-Type":"application/x-www-form-urlencoded" } });
      return { ok:true };
    } catch(e){ return { ok:false, error:"HANGUP_FAILED", status:e.response?.status||0, body:e.response?.data }; }
  }
};

/* ===== Prompt sourcing (RENDER_PROMPT preferred) ===== */
const FALLBACK_PROMPT = `
[Prompt-Version: 2025-10-11 baseline]

You are the AI phone receptionist for ${DASH_BIZ}.
Timezone: ${BIZ_TZ}. Be concise and human-like. Ask one question at a time.

Rules:
- Scheduling logic is yours. Use tools exactly as needed.
- When you check a time, pin that exact start/end in your booking call.
- Don’t hang up unless caller ends or you choose to end; then call end_call.
- Include name, phone, service, and notes when booking if available.
- Keep confirmations short and natural.
`;

const RENDER_PROMPT = process.env.RENDER_PROMPT || "";

async function fetchTenantPrompt() {
  if (RENDER_PROMPT) return RENDER_PROMPT; // prefer env
  if (URLS.PROMPT_FETCH) {
    try {
      const { data } = await httpGet(URLS.PROMPT_FETCH, { timeout:8000, tag:"PROMPT_FETCH", params:{ biz:DASH_BIZ } });
      if (data?.prompt) return data.prompt;
    } catch {}
  }
  return FALLBACK_PROMPT;
}

function systemMessages(tenantPrompt) {
  const today = todayISOInTZ(BIZ_TZ);
  return [
    { role:"system", content: `Today is ${today}. Business timezone: ${BIZ_TZ}. Resolve relative dates in this timezone.` },
    { role:"system", content: tenantPrompt || FALLBACK_PROMPT }
  ];
}

/* ===== Force a spoken reply after tools (only when no tools are used) ===== */
async function forceNaturalReply(messages) {
  const choice = await openaiChat(messages, { tool_choice:"none" });
  const msg = choice?.message || {};
  return (msg.content || "").trim();
}

/* ===== Prompt-driven status speech when model returns only tools ===== */
async function speakStatus(ws, messages, hint) {
  const guidance = {
    role: "system",
    content: `Say one short status line about "${hint}". Keep it under 8 words.`
  };
  const line = await forceNaturalReply([...messages, guidance]);
  if (line) {
    console.log(JSON.stringify({ evt:"STATUS_SAY", line }));
    await speakULaw(ws, line);
  }
}

/* ===== Generic tool runner with mutex and no premature return ===== */
async function runTools(ws, baseMessages) {
  if (ws.__llmBusy) { ws.__queued = baseMessages; return ""; }
  ws.__llmBusy = true;

  try {
    let messages = baseMessages.slice();

    for (let hops=0; hops<8; hops++){
      const choice = await openaiChat(messages);
      const msg = choice?.message || {};
      const calls = msg.tool_calls || [];

      if (!calls.length) {
        const out = msg.content?.trim() || "";
        if (out) return out;

        const forced = await forceNaturalReply(messages);
        if (forced) return forced;
        return "";
      }

      // Speak a status line once per hop before executing tools
      const said = (msg.content || "").trim();
      if (said) {
        console.log(JSON.stringify({ evt:"STATUS_MODEL_TEXT", said }));
        await speakULaw(ws, said);
      } else {
        const first = calls[0]?.function?.name || "";
        const hint =
          first === "read_availability" ? "checking that time" :
          first === "book_appointment"  ? "booking now" :
          first === "cancel_appointment"? "cancelling now" :
          "one moment";
        await speakStatus(ws, messages, hint);
      }

      console.log(JSON.stringify({
        evt:"LLM_TOOL_CALLS",
        count: calls.length,
        names: calls.map(c => c.function?.name)
      }));

      // Execute tools
      for (const tc of calls) {
        const name = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}

        if ((name === "transfer" || name === "end_call") && !args.callSid) args.callSid = ws.__callSid || "";

        if (name === "book_appointment") {
          const k = `${args.startISO||""}|${args.endISO||""}`;
          const now = Date.now();
          ws.__bookKeys = ws.__bookKeys || new Map();
          const last = ws.__bookKeys.get(k) || 0;
          if (now - last < 60000) {
            console.log(JSON.stringify({ evt:"BOOK_DEDUP_SUPPRESS", key:k }));
            messages = [...messages, msg, { role:"tool", tool_call_id: tc.id, content: JSON.stringify({ ok:false, error:"DUPLICATE_BOOKING_SUPPRESSED" }) }];
            continue;
          }
          ws.__bookKeys.set(k, now);
        }

        const impl = Tools[name];
        console.log(JSON.stringify({ evt:"TOOL_START", name, argsPreview: Object.keys(args) }));
        let result = {};
        try { result = await (impl ? impl(args) : { ok:false, error:"TOOL_NOT_FOUND" }); }
        catch(e){ result = { ok:false, error:e.message||"TOOL_ERR" }; }
        console.log(JSON.stringify({ evt:"TOOL_DONE", name, ok: result?.ok !== false }));

        messages = [...messages, msg, { role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) }];
      }

      console.log(JSON.stringify({ evt:"NEXT_HOP" }));
      // Next hop lets the model confirm or issue the next tool call
    }

    const guidance = { role:"system", content: "You seem stuck. Ask one concise clarifying question to move forward." };
    return await forceNaturalReply([...baseMessages, guidance]);
  } finally {
    ws.__llmBusy = false;
    if (ws.__queued) {
      const q = ws.__queued; ws.__queued = null;
      runTools(ws, q).then(async (reply) => { if (reply) await speakULaw(ws, reply); });
    }
  }
}

/* ===== Call summary ===== */
function transcriptFromMem(mem){
  return mem.map(m => {
    if (m.role === "user") return `Caller: ${m.content}`;
    if (m.role === "assistant") return `AI: ${m.content}`;
    return "";
  }).filter(Boolean).join("\n");
}

// === Schema-compatible postSummary (no hardcoded phrasing) ===
async function postSummary(ws, reason = "normal") {
  if (ws.__summarized) return;
  ws.__summarized = true;

  const trace = {
    convoId: ws.__convoId || "",
    callSid: ws.__callSid || "",
    from: ws.__from || ""
  };

  const payload = {
    biz: DASH_BIZ,
    source: DASH_SOURCE,
    ...trace,
    summary: ws.__summary || "",
    transcript: transcriptFromMem(ws.__mem || []),
    ended_reason: reason || ""
  };

  try { if (URLS.CALL_LOG)     await httpPost(URLS.CALL_LOG,     payload, { timeout:10000, tag:"CALL_LOG" }); } catch {}
  try { if (URLS.CALL_SUMMARY) await httpPost(URLS.CALL_SUMMARY, payload, { timeout: 8000, tag:"CALL_SUMMARY" }); } catch {}
}

/* ===== Call loop ===== */
wss.on("connection", (ws) => {
  let dg = null;
  let pendingULaw = [];
  const BATCH = 6;
  let tailTimer = null;

  ws.__mem = [];
  ws.__tenantPrompt = "";
  ws.__streamSid = "";
  ws.__callSid = "";
  ws.__from = "";
  ws.__convoId = "";
  ws.__llmBusy = false;
  ws.__queued = null;
  ws.__bookKeys = new Map();
  ws.__summarized = false;

  const flushULaw = () => {
    if (!pendingULaw.length || !dg || dg.readyState !== WebSocket.OPEN) return;
    const chunk = Buffer.concat(pendingULaw);
    pendingULaw = [];
    try { dg.send(chunk); } catch {}
  };

  ws.on("message", async raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      const cp = msg.start?.customParameters || {};
      ws.__from    = cp.from || "";
      ws.__callSid = cp.CallSid || cp.callSid || "";
      ws.__convoId = rid();
      CALLS.set(ws.__callSid, ws);

      ws.__tenantPrompt = await fetchTenantPrompt();

      // Proactive AI greeting (prompt-driven)
      const boot = [
        ...systemMessages(ws.__tenantPrompt),
        ...ws.__mem.slice(-12),
        { role:"user", content:"<CALL_START>" }
      ];
      const hello = await runTools(ws, boot);
      if (hello) {
        await speakULaw(ws, hello);
        ws.__mem.push({ role:"user", content:"<CALL_START>" }, { role:"assistant", content:hello });
      }

      // Start Deepgram once
      const dgSock = newDeepgram(async (text) => {
        const base = [
          ...systemMessages(ws.__tenantPrompt),
          ...ws.__mem.slice(-12),
          { role:"user", content: text }
        ];
        const reply = await runTools(ws, base);
        if (reply) {
          await speakULaw(ws, reply);
          ws.__mem.push({ role:"user", content:text }, { role:"assistant", content:reply });
        }
      });
      dg = dgSock;

      return;
    }

    if (msg.event === "media") {
      const ulaw = Buffer.from(msg.media?.payload || "", "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= BATCH) flushULaw();
      clearTimeout(tailTimer);
      tailTimer = setTimeout(flushULaw, 80);
      return;
    }

    if (msg.event === "stop") {
      try { flushULaw(); } catch {}
      try { dg?.close(); } catch {}
      await postSummary(ws, "twilio_stop");
      try { ws.close(); } catch {}
      CALLS.delete(ws.__callSid);
      return;
    }
  });

  ws.on("close", async ()=> {
    try { dg?.close(); } catch {}
    await postSummary(ws, "ws_close");
    CALLS.delete(ws.__callSid);
  });

  ws.on("error", async ()=> {
    await postSummary(ws, "ws_error");
  });
});
