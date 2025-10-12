/* server.js — Prompt-driven voice agent (transport only)
   - Model decides everything via tools; JS executes verbatim
   - μ-law passthrough: Twilio → Deepgram, ElevenLabs TTS → Twilio
   - Robustness: singleton WS, serialized TTS, single-flight LLM, slim deps
   - Trimmed, structured logs with previews (no spam)
*/

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

dotenv.config();

/* ===== Env ===== */
const PORT = process.env.PORT || 5000;

const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || "";
const DEEPGRAM_API_KEY    = process.env.DEEPGRAM_API_KEY || "";
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_CALLER_ID   = process.env.TWILIO_CALLER_ID   || "";
const OWNER_PHONE        = process.env.OWNER_PHONE        || "";

const BIZ_TZ   = process.env.BIZ_TZ   || "America/New_York";
const DASH_BIZ = process.env.DASH_BIZ || "The Victory Team";
const DASH_SRC = process.env.DASH_SOURCE || "voice";

const URLS = {
  CAL_READ:     process.env.REPLIT_READ_URL     || process.env.DASH_CAL_READ_URL     || "",
  CAL_CREATE:   process.env.REPLIT_CREATE_URL   || process.env.DASH_CAL_CREATE_URL   || "",
  CAL_DELETE:   process.env.REPLIT_DELETE_URL   || process.env.DASH_CAL_CANCEL_URL   || "",
  LEAD_UPSERT:  process.env.REPLIT_LEAD_URL     || process.env.DASH_LEAD_UPSERT_URL  || "",
  FAQ_LOG:      process.env.REPLIT_FAQ_URL      || process.env.DASH_CALL_LOG_URL     || "",
  PROMPT_FETCH: process.env.PROMPT_FETCH_URL    || ""
};

const PRE_CONNECT_GREETING = process.env.PRE_CONNECT_GREETING || "";
const RENDER_PROMPT        = process.env.RENDER_PROMPT || "";

/* ===== Minimal utils ===== */
const DEBUG = (process.env.DEBUG || "true") === "true";
const MAX_PREVIEW = Number(process.env.LOG_PREVIEW || 240);
const ts = () => new Date().toISOString().replace('T',' ').replace('Z','');
const preview = (v, n=MAX_PREVIEW) => {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > n ? (s.slice(0, n) + "…") : s;
  } catch { return ""; }
};
const jlog = (obj) => { if (DEBUG) console.log(JSON.stringify({ t: ts(), ...obj })); };
const log = (...a)=>{ if (DEBUG) console.log(ts(), ...a); };
async function httpPost(url, data, cfg={}){ return axios.post(url, data, cfg); }
async function httpGet(url, cfg={}){ return axios.get(url, cfg); }
function escapeXml(s=""){ return s.replace(/[<>&'"]/g,c=>({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":"&apos;" }[c])); }

/* ===== App / TwiML ===== */
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());
app.get("/", (_req,res)=>res.status(200).send("OK"));
app.get("/healthz", (_req,res)=>res.status(200).send("ok"));

app.post("/twiml", (req,res)=>{
  const from = req.body?.From || "";
  const callSid = req.body?.CallSid || "";
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
  const say = PRE_CONNECT_GREETING ? `<Say>${escapeXml(PRE_CONNECT_GREETING)}</Say>` : "";
  res.type("text/xml").send(`
    <Response>
      ${say}
      <Connect>
        <Stream url="wss://${host}" track="inbound_track">
          <Parameter name="from" value="${from}"/>
          <Parameter name="CallSid" value="${callSid}"/>
          <Parameter name="callSid" value="${callSid}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim());
});

app.post("/handoff", (_req,res)=>{
  res.type("text/xml").send(`
    <Response>
      <Dial callerId="${TWILIO_CALLER_ID}">
        <Number>${OWNER_PHONE}</Number>
      </Dial>
    </Response>
  `.trim());
});

const server = app.listen(PORT, ()=> jlog({ evt:"INIT", port: PORT, biz:DASH_BIZ, tz:BIZ_TZ }));

/* ===== Singleton WS ===== */
let wss = globalThis.__wss_singleton;
if (!wss) {
  wss = new WebSocketServer({ server, perMessageDeflate:false });
  globalThis.__wss_singleton = wss;
  jlog({ evt:"WSS_READY" });
}

/* ===== Deepgram: single connection per call ===== */
function newDeepgram(onFinal){
  const url = "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2-phonecall&interim_results=true&smart_format=true";
  const dg = new WebSocket(url, { headers:{ Authorization:`Token ${DEEPGRAM_API_KEY}` }, perMessageDeflate:false });
  dg.on("open", ()=> jlog({ evt:"DG_OPEN" }));
  dg.on("close", (c,r)=> jlog({ evt:"DG_CLOSE", code:c, reason: String(r||"") }));
  dg.on("error", e=> jlog({ evt:"DG_ERR", msg: e?.message||String(e) }));
  dg.on("message", buf=>{
    try {
      const ev = JSON.parse(buf.toString());
      const t = ev?.channel?.alternatives?.[0]?.transcript?.trim();
      if (t && (ev.is_final || ev.speech_final)) {
        jlog({ evt:"DG_FINAL", text_preview: preview(t, 120) });
        onFinal(t);
      }
    } catch (e) {
      jlog({ evt:"DG_PARSE_ERR", msg: String(e) });
    }
  });
  return dg;
}

/* ===== ElevenLabs TTS: serialized to avoid overlap ===== */
function cleanTTS(s=""){
  return String(s)
    .replace(/```[\s\S]*?```/g,"")
    .replace(/\[(.*?)\]\((.*?)\)/g,"$1")
    .replace(/\s{2,}/g," ")
    .trim();
}
async function speakULaw(ws, text){
  if (!text || !ws.__streamSid) return;
  const clean = cleanTTS(text);
  ws.__ttsQ = ws.__ttsQ || Promise.resolve();
  ws.__ttsQ = ws.__ttsQ.then(async ()=>{
    jlog({ evt:"TTS_START", chars: clean.length, preview: preview(clean, 100) });
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await httpPost(url, { text: clean }, {
      headers:{ "xi-api-key":ELEVENLABS_API_KEY, acceptStream:true },
      responseType:"stream", timeout:20000
    });

    let bytes = 0;
    await new Promise((resolve,reject)=>{
      resp.data.on("data", chunk=>{
        if (ws.readyState !== WebSocket.OPEN) return;
        bytes += chunk.length;
        ws.send(JSON.stringify({
          event:"media",
          streamSid: ws.__streamSid,
          media:{ payload: Buffer.from(chunk).toString("base64") }
        }));
      });
      resp.data.on("end", resolve);
      resp.data.on("error", reject);
    });
    jlog({ evt:"TTS_END", bytes });
  }).catch(e=> jlog({ evt:"TTS_ERR", msg: e?.message||String(e) }));
  return ws.__ttsQ;
}

/* ===== LLM with tools ===== */
const toolSchema = [
  { type:"function", function:{ name:"read_availability",
    description:"Read calendar availability. Pass through exactly what you intend.",
    parameters:{ type:"object", properties:{
      dateISO:{type:"string"}, startISO:{type:"string"}, endISO:{type:"string"},
      name:{type:"string"}, phone:{type:"string"}
    }, required:[] } } },
  { type:"function", function:{ name:"book_appointment",
    description:"Book with the exact startISO/endISO you confirmed.",
    parameters:{ type:"object", properties:{
      name:{type:"string"}, phone:{type:"string"}, service:{type:"string"},
      startISO:{type:"string"}, endISO:{type:"string"},
      notes:{type:"string"}, meeting_type:{type:"string"}, location:{type:"string"}
    }, required:["service","startISO","endISO"] } } },
  { type:"function", function:{ name:"cancel_appointment",
    description:"Cancel an event. Prefer event_id.",
    parameters:{ type:"object", properties:{
      event_id:{type:"string"}, name:{type:"string"}, phone:{type:"string"}, dateISO:{type:"string"}
    }, required:[] } } },
  { type:"function", function:{ name:"find_customer_events",
    description:"Find upcoming events for a contact over a horizon.",
    parameters:{ type:"object", properties:{
      name:{type:"string"}, phone:{type:"string"}, days:{type:"number"}
    }, required:[] } } },
  { type:"function", function:{ name:"lead_upsert",
    description:"Create/update a lead.",
    parameters:{ type:"object", properties:{
      name:{type:"string"}, phone:{type:"string"}, intent:{type:"string"}, notes:{type:"string"}
    }, required:["name","phone"] } } },
  { type:"function", function:{ name:"faq",
    description:"Log FAQ.",
    parameters:{ type:"object", properties:{ topic:{type:"string"}, service:{type:"string"} }, required:[] } } },
  { type:"function", function:{ name:"transfer",
    description:"Transfer caller to a human and stop.",
    parameters:{ type:"object", properties:{ reason:{type:"string"}, callSid:{type:"string"} }, required:[] } } },
  { type:"function", function:{ name:"end_call",
    description:"End the call.",
    parameters:{ type:"object", properties:{ callSid:{type:"string"}, reason:{type:"string"} }, required:[] } } }
];

async function openaiChat(messages, opts={}){
  const body = { model:"gpt-4o-mini", temperature:0.3, messages, tools:toolSchema, tool_choice:"auto", ...opts };
  const t0 = Date.now();
  jlog({ evt:"LLM_REQ", msgs: messages.length, last_user: preview(messages[messages.length-1], 160) });
  const { data } = await httpPost("https://api.openai.com/v1/chat/completions", body, {
    headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }, timeout:30000
  });
  const choice = data?.choices?.[0] || {};
  const tc = choice?.message?.tool_calls?.map(c=>c.function?.name) || [];
  jlog({ evt:"LLM_RES", ms: Date.now()-t0, has_text: !!(choice?.message?.content?.trim()), tools: tc });
  return choice;
}

/* ===== Prompt sourcing (prompt owns all rules) ===== */
const FALLBACK_PROMPT = `
[Prompt-Version: 2025-10-12T02:20Z • confirm-before-book • include-meeting-type+location • same-turn end_call • status+tool pairing • single-flight • pinned-ISO • no-tool-speech]

You are the AI phone receptionist for ${DASH_BIZ} (VictoryTeamSells.com) — Maryland real estate.
Timezone: ${BIZ_TZ}. Hours: Mon–Fri 09:00–17:00.

Brand
- Friendly, concise, confident, local.
- Office: 1316 E Churchville Rd, Bel Air MD 21014. Main: 833-888-1754.
- Services: buyer consults and tours; seller/listing consults (mention 1.75% if asked); investors; general Q&A.

Opening
- Say: “Thanks for calling The Victory Team. How can I help today?”

Core Interaction Rules
- Prompt-driven only. Transport executes exactly the tool calls you request.
- One question at a time. ≤15 words unless reading back details.
- Respect barge-in. No repeats. Check your scratchpad before asking.

Scratchpad
- Name, Phone (+1XXXXXXXXXX normalized), Role, Service, Property/MLS, Date, Time, Meeting Type, Location, Notes.

Identity and Numbers
- Use caller ID if they say “this number.” Never speak full phone numbers. If pressed, confirm only the last two digits.

Status/Tool Pairing Contract
- A status line MUST be followed by the matching tool call in the SAME turn.
- After the tool result, say one short outcome line, then ask one question.
- Single-flight: never call the same tool twice for the same ISO window; dedupe by “startISO|endISO.”
- Never say function names, arguments, or ISO strings.

Required Fields BEFORE any read_availability or book_appointment
- You MUST have: service, name, phone, meeting type (in-person or virtual), and location (if in-person).
- If any are missing, ask exactly one question to get the next missing item.

Confirm-Then-Book (strict)
1) Propose the time and get an explicit “yes.”
2) Encode the exact local hour in ${BIZ_TZ} with correct offset, e.g., 2025-10-13T15:00:00-04:00 to 16:00:00-04:00.
3) Call read_availability(startISO,endISO) in the SAME turn.
4) If free → outcome “That hour is open.” Then call book_appointment in the SAME turn with the SAME startISO/endISO. Include meeting_type and location, and copy them into Notes.
5) If busy or booking fails → outcome line (≤12 words). Offer 2–3 nearby in-hours options and ask one question.
6) After booking, confirm weekday + full date, time, meeting type, location, and notes. Then ask if they need anything else.

Reschedule / Cancel
- Use find_customer_events(name, phone, days=30). If one future match, capture event_id.
- Reschedule: verify new hour via read_availability → cancel_appointment(event_id) → book_appointment with the verified ISOs.
- Cancel: cancel_appointment(event_id). Outcome line. Ask if they want to rebook.

Transfer / End
- If caller asks for a human, call transfer(reason, callSid) and stop.
- When the caller declines more help or says goodbye, say “Thanks for calling The Victory Team. Have a great day. Goodbye.” and in the SAME TURN call end_call(callSid).

Latency / Failure
- If a tool will run, first say one short status line, then call the tool in the same turn.
- If a tool fails, give a 5–10 word outcome and propose one concrete next step.

Tools you may call
- read_availability(dateISO?, startISO?, endISO?, name?, phone?)
- book_appointment(name, phone, service, startISO, endISO, notes?, meeting_type?, location?)
- cancel_appointment(event_id?, name?, phone?, dateISO?)
- find_customer_events(name?, phone?, days?)
- lead_upsert(name, phone, intent?, notes?)
- faq(topic?, service?)
- transfer(reason?, callSid?)
- end_call(callSid?, reason?)

Turn Template When Acting
1) Status line (≤6 words)
2) Tool call(s)
3) One short outcome line
4) One question
`;

async function getPrompt(){
  if (RENDER_PROMPT) return RENDER_PROMPT;
  if (URLS.PROMPT_FETCH) {
    try {
      const { data } = await httpGet(URLS.PROMPT_FETCH, { params:{ biz:DASH_BIZ }, timeout:8000 });
      if (data?.prompt) return data.prompt;
    } catch(e){
      jlog({ evt:"PROMPT_FETCH_ERR", msg: e?.message||String(e) });
    }
  }
  return FALLBACK_PROMPT;
}

function systemMessages(prompt){
  const parts = new Intl.DateTimeFormat("en-CA",{ timeZone:BIZ_TZ, year:"numeric", month:"2-digit", day:"2-digit" })
    .formatToParts(new Date()).reduce((a,x)=> (a[x.type]=x.value,a),{});
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return [
    { role:"system", content:`Today is ${today}. Business timezone: ${BIZ_TZ}. Resolve relative dates in this timezone.` },
    { role:"system", content: prompt }
  ];
}

/* ===== Thin tools (pure pass-through) ===== */
const Tools = {
  async read_availability(args){
    if (!URLS.CAL_READ) return { ok:false, error:"CAL_READ_URL_MISSING" };
    try {
      const { dateISO, startISO, endISO, name, phone } = args || {};
      let windowObj;
      if (startISO && endISO) {
        windowObj = { start_utc: startISO, end_utc: endISO };
      } else if (dateISO) {
        windowObj = { start_local: `${dateISO} 00:00`, end_local: `${dateISO} 23:59` };
      }
      const payload = {
        intent: "READ",
        biz: DASH_BIZ,
        source: DASH_SRC,
        timezone: BIZ_TZ,   // lowercase variant
        Timezone: BIZ_TZ,   // uppercase variant
        window: windowObj,
        contact_name: name,
        contact_phone: phone
      };
      jlog({ evt:"CAL_READ_REQ", payload_preview: preview(payload) });
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000 });
      jlog({ evt:"CAL_READ_OK", count: data?.count, events_len: data?.events?.length });
      return { ok:true, data };
    } catch(e){
      jlog({ evt:"CAL_READ_ERR", status: e?.response?.status||0, body_preview: preview(e?.response?.data) });
      return { ok:false, status:e.response?.status||0, error:"READ_FAILED", body:e.response?.data };
    }
  },
  async book_appointment(args){
    if (!URLS.CAL_CREATE) return { ok:false, error:"CAL_CREATE_URL_MISSING" };
    try {
      const payload = { biz:DASH_BIZ, source:DASH_SRC, Timezone:BIZ_TZ, ...args };
      jlog({ evt:"CAL_CREATE_REQ", payload_preview: preview(payload) });
      const { data } = await httpPost(URLS.CAL_CREATE, payload, { timeout:12000 });
      jlog({ evt:"CAL_CREATE_OK", id_preview: preview(data?.id || data, 60) });
      return { ok:true, data };
    } catch(e){
      jlog({ evt:"CAL_CREATE_ERR", status: e?.response?.status||0, body_preview: preview(e?.response?.data) });
      return { ok:false, status:e.response?.status||0, error:"CREATE_FAILED", body:e.response?.data };
    }
  },
  async cancel_appointment(args){
    if (!URLS.CAL_DELETE) return { ok:false, error:"CAL_DELETE_URL_MISSING" };
    try {
      const payload = { intent:"DELETE", biz:DASH_BIZ, source:DASH_SRC, ...args };
      jlog({ evt:"CAL_DELETE_REQ", payload_preview: preview(payload) });
      const { data, status } = await httpPost(URLS.CAL_DELETE, payload, { timeout:12000 });
      const ok = (status>=200&&status<300) || data?.ok || data?.deleted || data?.cancelled;
      jlog({ evt:"CAL_DELETE_DONE", ok: !!ok });
      return { ok: !!ok, data };
    } catch(e){
      jlog({ evt:"CAL_DELETE_ERR", status: e?.response?.status||0, body_preview: preview(e?.response?.data) });
      return { ok:false, status:e.response?.status||0, error:"DELETE_FAILED", body:e.response?.data };
    }
  },
  async find_customer_events(args){
    if (!URLS.CAL_READ) return { ok:false, error:"CAL_READ_URL_MISSING", events:[] };
    try {
      const payload = { intent:"READ", biz:DASH_BIZ, source:DASH_SRC, timezone:BIZ_TZ, ...args };
      jlog({ evt:"CAL_FIND_REQ", payload_preview: preview(payload) });
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000 });
      jlog({ evt:"CAL_FIND_OK", events: data?.events?.length||0 });
      return { ok:true, events: data?.events||[], data };
    } catch(e){
      jlog({ evt:"CAL_FIND_ERR", status: e?.response?.status||0, body_preview: preview(e?.response?.data) });
      return { ok:false, status:e.response?.status||0, error:"FIND_FAILED", events:[], body:e.response?.data };
    }
  },
  async lead_upsert(args){
    if (!URLS.LEAD_UPSERT) return { ok:false, error:"LEAD_URL_MISSING" };
    try {
      const payload = { biz:DASH_BIZ, source:DASH_SRC, ...args };
      jlog({ evt:"LEAD_REQ", payload_preview: preview(payload) });
      const { data } = await httpPost(URLS.LEAD_UPSERT, payload, { timeout:8000 });
      jlog({ evt:"LEAD_OK" });
      return { ok:true, data };
    } catch(e){
      jlog({ evt:"LEAD_ERR", status: e?.response?.status||0, body_preview: preview(e?.response?.data) });
      return { ok:false, status:e.response?.status||0, error:"LEAD_FAILED", body:e.response?.data };
    }
  },
  async faq(args){
    try {
      if (URLS.FAQ_LOG) {
        const payload = { biz:DASH_BIZ, source:DASH_SRC, ...args };
        jlog({ evt:"FAQ_REQ", payload_preview: preview(payload) });
        await httpPost(URLS.FAQ_LOG, payload, { timeout:8000 });
        jlog({ evt:"FAQ_OK" });
      }
    } catch(e){
      jlog({ evt:"FAQ_ERR", msg: e?.message||String(e) });
    }
    return { ok:true };
  },
  async transfer(args){
    const callSid = args.callSid || "";
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OWNER_PHONE || !callSid) return { ok:false, error:"TRANSFER_CONFIG_MISSING" };
    try {
      const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
      const handoffUrl = `https://${host}/handoff`;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Url: handoffUrl, Method:"POST" });
      jlog({ evt:"XFER_REQ" });
      await httpPost(url, params, { auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN }, headers:{ "Content-Type":"application/x-www-form-urlencoded" }, timeout:10000 });
      jlog({ evt:"XFER_OK" });
      return { ok:true };
    } catch(e){
      jlog({ evt:"XFER_ERR", status: e?.response?.status||0, body_preview: preview(e?.response?.data) });
      return { ok:false, status:e.response?.status||0, error:"TRANSFER_FAILED", body:e.response?.data };
    }
  },
  async end_call(args){
    const callSid = args.callSid || "";
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return { ok:false, error:"HANGUP_CONFIG_MISSING" };
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Status:"completed" });
      jlog({ evt:"HANGUP_REQ" });
      await httpPost(url, params, { auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN }, headers:{ "Content-Type":"application/x-www-form-urlencoded" }, timeout:8000 });
      jlog({ evt:"HANGUP_OK" });
      return { ok:true };
    } catch(e){
      jlog({ evt:"HANGUP_ERR", status: e?.response?.status||0, body_preview: preview(e?.response?.data) });
      return { ok:false, status:e.response?.status||0, error:"HANGUP_FAILED", body:e.response?.data };
    }
  }
};

/* ===== Turn runner — single-flight with tool execution + memory + outcome nudge ===== */
async function runTurn(ws, baseMessages){
  if (ws.__llmBusy) { ws.__turnQueue = baseMessages; jlog({ evt:"TURN_QUEUE" }); return; }
  ws.__llmBusy = true;

  try {
    let messages = baseMessages.slice();
    const seen = new Set();

    for (let hops=0; hops<6; hops++){
      jlog({ evt:"TURN_HOP", hop:hops });
      const choice = await openaiChat(messages);
      const msg = choice?.message || {};
      const text = (msg.content||"").trim();
      const calls = msg.tool_calls || [];

      if (text) {
        await speakULaw(ws, text);
        ws.__mem.push({ role:"assistant", content:text });
        jlog({ evt:"SPOKEN", preview: preview(text, 120) });
      }
      if (!calls.length) { jlog({ evt:"NO_TOOLS" }); return; }

      jlog({ evt:"TOOL_CALLS", names: calls.map(c=>c.function?.name) });

      for (const tc of calls){
        const name = tc.function?.name || "";
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        if ((name === "transfer" || name === "end_call") && !args.callSid) args.callSid = ws.__callSid || "";

        const key = `${name}|${JSON.stringify(args)}`;
        if (seen.has(key)) { jlog({ evt:"TOOL_DEDUP", name }); continue; }
        seen.add(key);

        const impl = Tools[name];
        jlog({ evt:"TOOL_EXEC", name, args_preview: preview(args) });
        const result = impl ? await impl(args) : { ok:false, error:"TOOL_NOT_FOUND" };
        jlog({ evt:"TOOL_RESULT", name, ok: result?.ok !== false });

        messages = [
          ...messages,
          { role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) },
          { role:"system",
            content:"Tool response received. Now, in THIS SAME TURN, say one short outcome line (≤12 words) and ask ONE next question. Do not repeat the greeting. Do not mention tools or ISO strings." }
        ];
      }
    }
    jlog({ evt:"TURN_HOP_LIMIT" });
  } catch(e){
    jlog({ evt:"TURN_ERR", msg: e?.message||String(e) });
  } finally {
    ws.__llmBusy = false;
    if (ws.__turnQueue) {
      const q = ws.__turnQueue; ws.__turnQueue = null;
      jlog({ evt:"TURN_DEQUEUE" });
      runTurn(ws, q);
    }
  }
}

/* ===== Call loop ===== */
wss.on("connection", (ws)=>{
  let dg = null;
  let pending = [];
  const BATCH = 6;
  let timer = null;

  ws.__streamSid = "";
  ws.__callSid = "";
  ws.__from = "";
  ws.__prompt = "";
  ws.__llmBusy = false;
  ws.__turnQueue = null;
  ws.__ttsQ = Promise.resolve();
  ws.__mem = []; // rolling transcript memory

  jlog({ evt:"WS_CONN" });

  const flush = ()=>{
    if (!pending.length || !dg || dg.readyState !== WebSocket.OPEN) return;
    const chunk = Buffer.concat(pending); pending = [];
    try { dg.send(chunk); jlog({ evt:"DG_FLUSH", bytes: chunk.length }); } catch(e){ jlog({ evt:"DG_FLUSH_ERR", msg:String(e) }); }
  };

  ws.on("message", async raw=>{
    let msg; try { msg = JSON.parse(raw.toString()); } catch { jlog({ evt:"WS_PARSE_ERR" }); return; }

    if (msg.event === "start"){
      ws.__streamSid = msg.start?.streamSid || "";
      const cp = msg.start?.customParameters || {};
      ws.__from    = cp.from || "";
      ws.__callSid = cp.CallSid || cp.callSid || "";
      jlog({ evt:"CALL_START", callSid: ws.__callSid, from: ws.__from });

      ws.__prompt = await getPrompt();
      const boot = [
        ...systemMessages(ws.__prompt),
        ...ws.__mem.slice(-12),
        { role:"user", content:"<CALL_START>" }
      ];
      await runTurn(ws, boot);

      dg = newDeepgram(async (text)=>{
        const base = [
          ...systemMessages(ws.__prompt),
          ...ws.__mem.slice(-12),
          { role:"user", content: text }
        ];
        await runTurn(ws, base);
        ws.__mem.push({ role:"user", content:text });
      });

      return;
    }

    if (msg.event === "media"){
      const ulaw = Buffer.from(msg.media?.payload || "", "base64");
      pending.push(ulaw);
      if (pending.length >= BATCH) flush();
      clearTimeout(timer);
      timer = setTimeout(flush, 80);
      return;
    }

    if (msg.event === "stop"){
      jlog({ evt:"CALL_STOP" });
      try { flush(); } catch {}
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }
  });

  ws.on("close", ()=> { jlog({ evt:"WS_CLOSE" }); try { dg?.close(); } catch {} });
  ws.on("error", (e)=> { jlog({ evt:"WS_ERR", msg: e?.message||String(e) }); try { dg?.close(); } catch {} });
});
