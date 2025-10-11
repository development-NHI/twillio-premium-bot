/* server.js — Prompt-driven voice agent (transport + thin tools only)
   - Streams audio, calls the model, and executes tool HTTP calls verbatim.
   - No business rules in JS. All policy lives in the prompt/config.
   - CAL_* endpoints kept compatible with Replit/Render integrations.
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
const TWILIO_CALLER_ID   = process.env.TWILIO_CALLER_ID || "";
const OWNER_PHONE        = process.env.OWNER_PHONE || "";

const DASH_SOURCE = process.env.DASH_SOURCE || "voice";
const BIZ_TZ      = process.env.BIZ_TZ || "America/New_York";

const PRE_CONNECT_GREETING = process.env.PRE_CONNECT_GREETING || "";

const URLS = {
  CAL_READ:     process.env.REPLIT_READ_URL     || process.env.DASH_CAL_READ_URL     || "",
  CAL_CREATE:   process.env.REPLIT_CREATE_URL   || process.env.DASH_CAL_CREATE_URL   || "",
  CAL_DELETE:   process.env.REPLIT_DELETE_URL   || process.env.DASH_CAL_CANCEL_URL   || "",
  LEAD_UPSERT:  process.env.REPLIT_LEAD_URL     || process.env.DASH_LEAD_UPSERT_URL  || "",
  FAQ_LOG:      process.env.REPLIT_FAQ_URL      || process.env.DASH_FAQ_URL          || "",
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

/* ===== Logging knobs ===== */
const DEBUG_HTTP  = (process.env.DEBUG_HTTP  ?? "true")  === "true";
const DEBUG_MEDIA = (process.env.DEBUG_MEDIA ?? "false") === "true";

/* ===== HTTP helpers ===== */
function rid(){ return Math.random().toString(36).slice(2,8); }
function preview(obj, max=320){
  try {
    const s = typeof obj==="string"?obj:JSON.stringify(obj);
    return s.length>max? s.slice(0,max)+"…" : s;
  } catch { return ""; }
}
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
function localEndOffsetISO(dateISO, h, m, tz) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12:false, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit"
  });
  const parts = fmt.formatToParts(d).reduce((a,x)=> (a[x.type]=x.value,a),{});
  const local = `${parts.year}-${parts.month}-${parts.day}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`;
  const tzName = new Date(`${local}`).toLocaleTimeString('en-US',{ timeZone: tz, timeZoneName:'shortOffset' });
  const off = tzName.match(/[+-]\d{2}:\d{2}/)?.[0] || "Z";
  return `${local}${off}`;
}
function dayWindowLocal(dateISO, tz) {
  return {
    start_local: `${dateISO} 00:00`,
    end_local:   `${dateISO} 23:59`,
    start_utc:   localEndOffsetISO(dateISO, 0,   0, tz),
    end_utc:     localEndOffsetISO(dateISO, 23, 59, tz),
    timezone:    tz
  };
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
  const statusCbAttr = process.env.STATUS_CALLBACK_URL ? ` statusCallback="${process.env.STATUS_CALLBACK_URL}"` : "";
  res.send(`
    <Response>
      ${optSay}
      <Connect>
        <Stream url="wss://${host}" track="inbound_track"${statusCbAttr}>
          <Parameter name="from" value="${from}"/>
          <Parameter name="CallSid" value="${callSid}"/>
          <Parameter name="callSid" value="${callSid}"/>
        </Stream>
      </Connect>
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
  console.log("[INIT] TENANT", { DASH_SOURCE, BIZ_TZ });
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
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });
  dg.on("open", ()=> console.log(JSON.stringify({ evt:"DG_OPEN" })));
  dg.on("close", (c,r)=> console.log(JSON.stringify({ evt:"DG_CLOSE", code:c, reason:r?.toString?.() })));
  dg.on("error", (e)=> console.warn(JSON.stringify({ evt:"DG_ERROR", message:e.message })));
  dg.on("message", (data)=>{
    try{
      const ev = JSON.parse(data.toString());
      const alt = ev.channel?.alternatives?.[0];
      const text = (alt?.transcript || "").trim();
      if (!text) return;
      if (ev.is_final || ev.speech_final) onFinal?.(text);
    }catch(err){
      console.warn(JSON.stringify({ evt:"DG_PARSE_ERR", err: String(err) }));
    }
  });
  return dg;
}

/* ===== ElevenLabs TTS (μ-law passthrough) ===== */
// never speak tool names, code, ISO blobs, or full phone numbers
function sanitizeSpoken(raw=""){
  let s = String(raw);
  s = s.replace(/`{1,3}[\s\S]*?`{1,3}/g, " "); // code fences
  s = s.replace(/\b(read_availability|book_appointment|cancel_appointment|find_customer_events|transfer|end_call)\b[\s\S]*/i, " ");
  s = s.replace(/\+?\d[\d\-\s().]{7,}/g, "[number saved]");
  s = s.replace(/[A-Z]{2,}\d{2,}[-:T.\dZ+]*\)?/g, " ");
  s = s.replace(/\[(.*?)\]\((.*?)\)/g,"$1");
  s = s.replace(/\s{2,}/g," ").trim();
  if (!s) s = "One moment.";
  return s;
}
async function speakULaw(ws, text){
  if (!text || !ws.__streamSid || ws.__ended) return;
  const clean = sanitizeSpoken(text);
  try{
    console.log(JSON.stringify({ evt:"TTS_START", chars: clean.length, preview: clean.slice(0,80) }));
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await httpPost(url, { text: clean }, { headers:{ "xi-api-key":ELEVENLABS_API_KEY, acceptStream:true }, timeout:20000, tag:"TTS_STREAM" });
    let bytes = 0;
    resp.data.on("data", chunk => {
      if (ws.readyState !== WebSocket.OPEN) return;
      bytes += chunk.length;
      const b64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event:"media", streamSid:ws.__streamSid, media:{ payload:b64 } }));
    });
    resp.data.on("end", ()=> console.log(JSON.stringify({ evt:"TTS_END", bytes })));
  } catch(e){ console.error(JSON.stringify({ evt:"TTS_ERROR", message:e.message })); }
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
      startISO:{type:"string"}, endISO:{type:"string"}, notes:{type:"string"},
      meeting_type:{type:"string"}, location:{type:"string"}
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
  const id = rid(); const t = Date.now();
  console.log(JSON.stringify({ evt:"LLM_REQ", id, msg_count: messages.length }));
  const { data } = await httpPost("https://api.openai.com/v1/chat/completions", body, { headers, timeout:30000, tag:"OPENAI_CHAT" });
  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  console.log(JSON.stringify({
    evt:"LLM_RES",
    id,
    ms: Date.now()-t,
    has_content: !!(msg.content && msg.content.trim()),
    tool_calls: (msg.tool_calls||[]).map(tc => tc.function?.name)
  }));
  return choice;
}

/* ===== ISO timezone validation helper ===== */
function hasTZ(s){ return typeof s==="string" && (/[Zz]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)); }

/* ===== Tool implementations (thin wrappers, no logic) ===== */
const Tools = {
  async read_availability({ dateISO, startISO, endISO, name, phone }) {
    if (!URLS.CAL_READ) return { ok:false, error:"CAL_READ_URL_MISSING" };
    if (startISO && !hasTZ(startISO)) return { ok:false, error:"ISO_MISSING_TZ_START" };
    if (endISO   && !hasTZ(endISO))   return { ok:false, error:"ISO_MISSING_TZ_END"   };

    let windowObj;
    if (startISO && endISO) windowObj = { start_utc:startISO, end_utc:endISO };
    else if (dateISO) windowObj = dayWindowLocal(dateISO, BIZ_TZ);
    else windowObj = dayWindowLocal(todayISOInTZ(BIZ_TZ), BIZ_TZ);

    const payload = { intent:"READ", source:DASH_SOURCE, timezone:BIZ_TZ, window:windowObj, contact_name:name, contact_phone:phone };
    try {
      const t0 = Date.now();
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000, tag:"CAL_READ" });
      console.log(JSON.stringify({ evt:"CAL_READ_OK", ms: Date.now()-t0, window: windowObj, count: data?.count, events_len: data?.events?.length }));
      return { ok:true, data };
    } catch(e){
      console.log(JSON.stringify({ evt:"CAL_READ_FAIL" }));
      return { ok:false, status:e.response?.status||0, error:"READ_FAILED", body: e.response?.data };
    }
  },

  async book_appointment({ name, phone, service, startISO, endISO, notes, meeting_type, location }) {
    if (!URLS.CAL_CREATE) return { ok:false, error:"CAL_CREATE_URL_MISSING" };
    if (!hasTZ(startISO)) return { ok:false, error:"ISO_MISSING_TZ_START" };
    if (!hasTZ(endISO))   return { ok:false, error:"ISO_MISSING_TZ_END"   };

    const startLocal = isoToLocalYYYYMMDDHHmm(startISO, BIZ_TZ);
    const endLocal   = isoToLocalYYYYMMDDHHmm(endISO,   BIZ_TZ);
    const payload = {
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
      Notes: notes||service||"",
      Meeting_Type: meeting_type||"",
      Location: location||""
    };
    try {
      const t0 = Date.now();
      const { data } = await httpPost(URLS.CAL_CREATE, payload, { timeout:12000, tag:"CAL_CREATE" });
      console.log(JSON.stringify({ evt:"CAL_CREATE_OK", ms: Date.now()-t0, startISO, endISO }));
      return { ok:true, data };
    } catch(e){
      console.log(JSON.stringify({ evt:"CAL_CREATE_FAIL" }));
      return { ok:false, status:e.response?.status||0, error:"CREATE_FAILED", body:e.response?.data };
    }
  },

  async cancel_appointment({ event_id, name, phone, dateISO }) {
    if (!URLS.CAL_DELETE) return { ok:false, error:"CAL_DELETE_URL_MISSING" };
    try {
      const t0 = Date.now();
      const { data, status } = await httpPost(URLS.CAL_DELETE, {
        intent:"DELETE", source:DASH_SOURCE, event_id, name, phone, dateISO
      }, { timeout:12000, tag:"CAL_DELETE" });
      const ok = (status>=200&&status<300) || data?.ok === true || data?.deleted === true || data?.cancelled === true;
      console.log(JSON.stringify({ evt:"CAL_DELETE_DONE", ms: Date.now()-t0, ok }));
      return { ok, data };
    } catch(e){
      console.log(JSON.stringify({ evt:"CAL_DELETE_FAIL" }));
      return { ok:false, status:e.response?.status||0, error:"DELETE_FAILED", body:e.response?.data };
    }
  },

  async find_customer_events({ name, phone, days=30 }) {
    if (!URLS.CAL_READ) return { ok:false, error:"CAL_READ_URL_MISSING", events:[] };
    const base = todayISOInTZ(BIZ_TZ);
    const w = dayWindowLocal(base, BIZ_TZ);
    const payload = { intent:"READ", source:DASH_SOURCE, timezone:BIZ_TZ, window:w, contact_name:name, contact_phone:phone, days };
    try {
      const t0 = Date.now();
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000, tag:"CAL_READ_FIND" });
      console.log(JSON.stringify({ evt:"CAL_FIND_OK", ms: Date.now()-t0, events: data?.events?.length }));
      return { ok:true, events: data?.events || [], data };
    } catch(e){
      console.log(JSON.stringify({ evt:"CAL_FIND_FAIL" }));
      return { ok:false, status:e.response?.status||0, error:"FIND_FAILED", events:[], body:e.response?.data };
    }
  },

  async lead_upsert({ name, phone, intent, notes }) {
    if (!URLS.LEAD_UPSERT) return { ok:false, error:"LEAD_URL_MISSING" };
    try {
      const t0 = Date.now();
      const { data } = await httpPost(URLS.LEAD_UPSERT, { source:DASH_SOURCE, name, phone, intent, notes }, { timeout:8000, tag:"LEAD_UPSERT" });
      console.log(JSON.stringify({ evt:"LEAD_OK", ms: Date.now()-t0 }));
      return { ok:true, data };
    } catch(e){
      console.log(JSON.stringify({ evt:"LEAD_FAIL" }));
      return { ok:false, status:e.response?.status||0, error:"LEAD_FAILED", body:e.response?.data };
    }
  },

  async faq({ topic, service }) {
    try {
      if (URLS.FAQ_LOG) {
        const t0 = Date.now();
        await httpPost(URLS.FAQ_LOG, { source:DASH_SOURCE, topic, service }, { timeout:8000, tag:"FAQ_LOG" });
        console.log(JSON.stringify({ evt:"FAQ_LOG_OK", ms: Date.now()-t0 }));
      }
    } catch(e){
      console.log(JSON.stringify({ evt:"FAQ_LOG_FAIL", message: e.message }));
    }
    return { ok:true };
  },

  async transfer({ reason, callSid }) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OWNER_PHONE || !callSid) return { ok:false, error:"TRANSFER_CONFIG_MISSING" };
    try {
      const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
      const handoffUrl = `https://${host}/handoff`;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Url: handoffUrl, Method:"POST" });
      const t0 = Date.now();
      await httpPost(url, params, { auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN }, timeout:10000, tag:"TWILIO_REDIRECT", headers:{ "Content-Type":"application/x-www-form-urlencoded" } });
      console.log(JSON.stringify({ evt:"TRANSFER_OK", ms: Date.now()-t0 }));
      return { ok:true };
    } catch(e){
      console.log(JSON.stringify({ evt:"TRANSFER_FAIL", message:e.message }));
      return { ok:false, error:"TRANSFER_FAILED", status:e.response?.status||0, body:e.response?.data };
    }
  },

  async end_call({ callSid, reason }) {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return { ok:false, error:"HANGUP_CONFIG_MISSING" };
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Status:"completed" });
      const t0 = Date.now();
      await httpPost(url, params, { auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN }, timeout:8000, tag:"TWILIO_HANGUP", headers:{ "Content-Type":"application/x-www-form-urlencoded" } });
      console.log(JSON.stringify({ evt:"HANGUP_OK", ms: Date.now()-t0, reason: reason||"" }));
      return { ok:true };
    } catch(e){
      console.log(JSON.stringify({ evt:"HANGUP_FAIL", message:e.message }));
      return { ok:false, error:"HANGUP_FAILED", status:e.response?.status||0, body:e.response?.data };
    }
  }
};

/* ===== Prompt sourcing (RENDER_PROMPT preferred) ===== */
const FALLBACK_PROMPT = `
[Prompt-Version: 2025-10-11 baseline, no-biz-var]

You are the AI phone receptionist.
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
  if (RENDER_PROMPT) return RENDER_PROMPT;
  if (URLS.PROMPT_FETCH) {
    try {
      const { data } = await httpGet(URLS.PROMPT_FETCH, { timeout:8000, tag:"PROMPT_FETCH" });
      if (data?.prompt) return data.prompt;
    } catch(e){
      console.log(JSON.stringify({ evt:"PROMPT_FETCH_FAIL", message: e.message }));
    }
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

/* ===== Deterministic status lines (no model) ===== */
function statusLineForTool(name){
  if (name === "read_availability") return "One sec, checking that time.";
  if (name === "book_appointment")  return "Got it, booking now.";
  if (name === "cancel_appointment")return "Cancelling now.";
  return "One moment.";
}

/* ===== Force a spoken reply when tools are disabled ===== */
async function forceNaturalReply(messages) {
  const choice = await openaiChat(messages, { tool_choice:"none" });
  const msg = choice?.message || {};
  return (msg.content || "").trim();
}

/* ===== Generic tool runner with mutex and pinned-window echo ===== */
async function runTools(ws, baseMessages) {
  if (ws.__llmBusy) { ws.__queued = baseMessages; console.log(JSON.stringify({ evt:"RUNTOOLS_QUEUE" })); return ""; }
  ws.__llmBusy = true;

  try {
    let messages = baseMessages.slice();
    console.log(JSON.stringify({ evt:"RUNTOOLS_BEGIN", hops:0, mem_len: ws.__mem?.length||0 }));

    for (let hops=0; hops<8; hops++){
      const choice = await openaiChat(messages);
      const msg = choice?.message || {};
      const calls = msg.tool_calls || [];

      if (!calls.length) {
        const out = msg.content?.trim() || "";
        console.log(JSON.stringify({ evt:"RUNTOOLS_NO_TOOLS", has_text: !!out, text_preview: out.slice(0,80) }));

        // status-no-tool guard: enforce same-turn tool call
        if (out && /\b(checking|booking|cancelling|canceling)\b/i.test(out)) {
          console.log(JSON.stringify({ evt:"STATUS_NO_TOOL_GUARD", preview: out.slice(0,64) }));
          messages = [
            ...messages,
            msg,
            { role: "system",
              content: "You just said a status line. Now, in THIS SAME TURN, call the appropriate tool using the exact intended ISO window. Do NOT reply with text only." }
          ];
          continue;
        }

        // goodbye-without-tool guard → force end_call in same turn
        if (out && /\b(bye|goodbye|that('?| )is it|we('re| are) good|that('ll| will) be it|nothing else)\b/i.test(out)) {
          messages = [
            ...messages,
            msg,
            { role:"system",
              content:"You just ended the conversation. In THIS SAME TURN, call end_call(callSid) immediately after a brief goodbye." }
          ];
          continue;
        }

        if (out) return out;

        const forced = await forceNaturalReply(messages);
        console.log(JSON.stringify({ evt:"RUNTOOLS_FORCED_REPLY", has_text: !!forced, text_preview: (forced||"").slice(0,80) }));
        if (forced) return forced;
        return "";
      }

      // Speak deterministic status line per first tool, never tool text
      const first = calls[0]?.function?.name || "";
      await speakULaw(ws, statusLineForTool(first));

      console.log(JSON.stringify({
        evt:"LLM_TOOL_CALLS",
        count: calls.length,
        names: calls.map(c => c.function?.name)
      }));

      // Execute tools
      for (const tc of calls) {
        const name = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { console.log(JSON.stringify({ evt:"TOOL_ARGS_PARSE_FAIL", name })); }

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
        console.log(JSON.stringify({ evt:"TOOL_START", name, args_keys: Object.keys(args) }));
        let result = {};
        try { result = await (impl ? impl(args) : { ok:false, error:"TOOL_NOT_FOUND" }); }
        catch(e){ result = { ok:false, error:e.message||"TOOL_ERR" }; }
        console.log(JSON.stringify({ evt:"TOOL_DONE", name, ok: result?.ok !== false, err: result?.error || null }));

        // Attach tool result
        messages = [...messages, msg, { role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) }];

        // Pinned-window echo after successful availability read
        if (name === "read_availability") {
          try {
            const r = result;
            const pinStart = r?.data?.window?.start_utc;
            const pinEnd   = r?.data?.window?.end_utc;
            if (r?.ok === true && pinStart && pinEnd) {
              messages.push({
                role:"system",
                content:`You just verified availability for start=${pinStart} end=${pinEnd}. If you intend to book, call book_appointment using the same startISO and endISO exactly.`
              });
              console.log(JSON.stringify({ evt:"PINNED_WINDOW", start: pinStart, end: pinEnd }));
            }
          } catch(err){ console.log(JSON.stringify({ evt:"PINNED_WINDOW_ERR", err: String(err) })); }
        }

        // Booking success/fail guard → prevent false “booked” claims
        if (name === "book_appointment") {
          if (result?.ok) {
            messages.push({
              role:"system",
              content:"Booking succeeded. Confirm weekday, full date, time, meeting type, and location. Then ask if anything else."
            });
          } else {
            messages.push({
              role:"system",
              content:"Booking failed. Do NOT say it was booked. Say a short outcome using the error text if helpful, then offer 2–3 nearby in-hours options and ask one question."
            });
          }
        }

        // end_call guard to stop further speech
        if (name === "end_call" && result?.ok) {
          ws.__ended = true;
        }
      }

      console.log(JSON.stringify({ evt:"NEXT_HOP", hop: hops+1 }));
    }

    const guidance = { role:"system", content: "You seem stuck. Ask one concise clarifying question to move forward." };
    console.log(JSON.stringify({ evt:"HOP_LIMIT_GUIDANCE" }));
    return await forceNaturalReply([...baseMessages, guidance]);
  } finally {
    ws.__llmBusy = false;
    if (ws.__queued) {
      const q = ws.__queued; ws.__queued = null;
      console.log(JSON.stringify({ evt:"RUNTOOLS_DEQUEUE" }));
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

async function postSummary(ws, reason = "normal") {
  if (ws.__summarized) return;
  ws.__summarized = true;

  const trace = {
    convoId: ws.__convoId || "",
    callSid: ws.__callSid || "",
    from: ws.__from || ""
  };

  const payload = {
    source: DASH_SOURCE,
    ...trace,
    summary: ws.__summary || "",
    transcript: transcriptFromMem(ws.__mem || []),
    ended_reason: reason || ""
  };

  try { if (URLS.CALL_LOG)     await httpPost(URLS.CALL_LOG,     payload, { timeout:10000, tag:"CALL_LOG" }); } catch(e){ console.log(JSON.stringify({ evt:"CALL_LOG_FAIL", message:e.message })); }
  try { if (URLS.CALL_SUMMARY) await httpPost(URLS.CALL_SUMMARY, payload, { timeout: 8000, tag:"CALL_SUMMARY" }); } catch(e){ console.log(JSON.stringify({ evt:"CALL_SUMMARY_FAIL", message:e.message })); }
}

/* ===== Call loop ===== */
wss.on("connection", (ws) => {
  let dg = null;
  let pendingULaw = [];
  const BATCH = 6;
  let tailTimer = null;
  let FLUSH_COUNT = 0;

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
  ws.__ended = false;

  console.log(JSON.stringify({ evt:"WS_CONN" }));

  const flushULaw = () => {
    if (!pendingULaw.length || !dg || dg.readyState !== WebSocket.OPEN) return;
    const chunk = Buffer.concat(pendingULaw);
    pendingULaw = [];
    try {
      dg.send(chunk);
      if (DEBUG_MEDIA && (++FLUSH_COUNT % 50 === 0)) {
        console.log(JSON.stringify({ evt:"DG_AUDIO_FLUSH", bytes: chunk.length, n: FLUSH_COUNT }));
      }
    } catch(err){
      console.log(JSON.stringify({ evt:"DG_AUDIO_FLUSH_ERR", message: String(err) }));
    }
  };

  ws.on("message", async raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { console.log(JSON.stringify({ evt:"WS_PARSE_ERR" })); return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      const cp = msg.start?.customParameters || {};
      ws.__from    = cp.from || "";
      ws.__callSid = cp.CallSid || cp.callSid || "";
      ws.__convoId = rid();
      CALLS.set(ws.__callSid, ws);
      console.log(JSON.stringify({ evt:"CALL_START", streamSid: ws.__streamSid, callSid: ws.__callSid, from: ws.__from }));

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
      console.log(JSON.stringify({ evt:"CALL_STOP" }));
      try { flushULaw(); } catch {}
      try { dg?.close(); } catch {}
      await postSummary(ws, "twilio_stop");
      try { ws.close(); } catch {}
      CALLS.delete(ws.__callSid);
      return;
    }
  });

  ws.on("close", async ()=> {
    console.log(JSON.stringify({ evt:"WS_CLOSE" }));
    try { dg?.close(); } catch {}
    await postSummary(ws, "ws_close");
    CALLS.delete(ws.__callSid);
  });

  ws.on("error", async (err)=> {
    console.log(JSON.stringify({ evt:"WS_ERROR", message: err?.message || String(err) }));
    await postSummary(ws, "ws_error");
  });
});
