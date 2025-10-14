/* server.js — Prompt-driven voice agent (transport only)
   - Model decides everything via tools; JS executes verbatim
   - μ-law passthrough: Twilio → Deepgram, ElevenLabs TTS → Twilio
   - Robustness: singleton WS, serialized TTS, single-flight LLM, slim deps
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
const log = (...a)=>{ if (DEBUG) console.log(...a); };
async function httpPost(url, data, cfg={}){ return axios.post(url, data, cfg); }
async function httpGet(url, cfg={}){ return axios.get(url, cfg); }
function escapeXml(s=""){
  return s.replace(/[<>&'"]/g, c => ({
    '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":"&apos;"
  }[c]));
}

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

const server = app.listen(PORT, ()=> log("[INIT]", PORT));

/* ===== Singleton WS ===== */
let wss = globalThis.__wss_singleton;
if (!wss) {
  wss = new WebSocketServer({ server, perMessageDeflate:false });
  globalThis.__wss_singleton = wss;
}

/* ===== Deepgram: single connection per call ===== */
function newDeepgram(onFinal){
  const url = "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2-phonecall&interim_results=true&smart_format=true";
  const dg = new WebSocket(url, { headers:{ Authorization:`Token ${DEEPGRAM_API_KEY}` }, perMessageDeflate:false });
  dg.on("open", ()=> log("[DG] open"));
  dg.on("close", ()=> log("[DG] close"));
  dg.on("error", e=> log("[DG] error:", e?.message||e));
  dg.on("message", buf=>{
    try {
      const ev = JSON.parse(buf.toString());
      const t = ev?.channel?.alternatives?.[0]?.transcript?.trim();
      if (t && (ev.is_final || ev.speech_final)) onFinal(t);
    } catch {}
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
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await httpPost(url, { text: clean }, {
      headers:{ "xi-api-key":ELEVENLABS_API_KEY, acceptStream:true },
      responseType:"stream", timeout:20000
    });
    await new Promise((resolve,reject)=>{
      resp.data.on("data", chunk=>{
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          event:"media",
          streamSid: ws.__streamSid,
          media:{ payload: Buffer.from(chunk).toString("base64") }
        }));
      });
      resp.data.on("end", resolve);
      resp.data.on("error", reject);
    });
  }).catch(()=>{});
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
      title:{type:"string"},
      notes:{type:"string"}, meeting_type:{type:"string"}, location:{type:"string"}
    }, required:["service","startISO","endISO","title"] } } },
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
  const { data } = await httpPost("https://api.openai.com/v1/chat/completions", body, {
    headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }, timeout:30000
  });
  return data?.choices?.[0] || {};
}

/* ===== Prompt sourcing ===== */
const FALLBACK_PROMPT = `
[Prompt-Version: 2025-10-15T15:40Z — Title=Type — Name • Notes required • No repeats]

You are the AI phone receptionist for ${DASH_BIZ} (VictoryTeamSells.com) — Maryland real estate.
Timezone: ${BIZ_TZ}. Hours: Mon–Fri 09:00–17:00.

Brand
- Confident, concise, friendly, local.
- Office: 1316 E Churchville Rd, Bel Air MD 21014. Main: 833-888-1754.
- Services: buyer consults and tours; seller/listing consults (mention 1.75% if asked); investors; general Q&A.

Greeting
- “Thanks for calling The Victory Team. How can I help today?”

Scratchpad
- Name, Phone (+1XXXXXXXXXX normalized), Service, Meeting Type, Location, Notes.
- Check scratchpad before asking. Never re-ask unless caller changes it.

Conversation Rules
- One short question at a time (≤15 words). No verbatim repeats.
- Natural tone. Respect barge-ins. Keep each reply under ~5 seconds.

Identity and Numbers
- If caller says “this number,” use caller ID. Never speak full numbers. If pressed, confirm only last two digits.

Booking Preconditions (HARD GATE)
- Must have: service, name, phone, meeting_type, and location if in-person.
- Do not call read_availability or book_appointment until all above are known.

Mandatory Title and Notes (HARD GATE)
- Build calendar title exactly: “{Type} — {Name}”.
  - Type ∈ {Buyer Consultation, Seller Consultation, Home Tour, Investor Consultation, Consultation}
  - Name must be the caller’s name. Never use generic text like “Voice Customer”.
- Build a clear notes string that states what the appointment is and relevant context, e.g.:
  “Service: buyer. Type: in-person. Location: office. Caller: {Name}. Context: {brief}. Phone: ends {last2}.”
- If title or notes are missing, do not call book_appointment; ask one question to get what’s missing.

Confirm-Then-Book
1) Propose a specific local time and get an explicit “yes”.
2) Encode startISO/endISO in ${BIZ_TZ} with correct UTC offset.
3) Say a short status line, then call read_availability(startISO,endISO) in the SAME turn.
4) If free → outcome “That time is open.” Then call book_appointment in the SAME turn with the SAME ISOs and include name, phone, service, meeting_type, location, **title**, **notes**.
5) If busy or booking fails → one-line outcome. Offer 2–3 nearby in-hours options. Ask one question.

Reschedule / Cancel
- Use find_customer_events(name, phone, days=30). If one future match, capture event_id.
- Reschedule: verify new time via read_availability → cancel_appointment(event_id) → book_appointment with verified ISOs (keep the same title pattern).
- Cancel: cancel_appointment(event_id). Short outcome. Ask if they want to rebook.

Transfer / End
- If caller asks for a human → transfer(reason, callSid) and stop.
- If caller says goodbye → “Thanks for calling The Victory Team. Have a great day.” → end_call(callSid) in the same turn.

Latency / Failure
- Before any tool, say one short status.
- If a tool fails, give ≤10 word outcome and one concrete next step.

Status/Tool Pairing Contract
- A status line must be followed by the matching tool call in the SAME turn.
- After the tool result, say one short outcome, then ask one question.
- Single-flight: never call the same tool twice for the same ISO window; dedupe by “startISO|endISO”.
- Never mention tool names or ISO strings.

Turn Template
1) Status line (≤6 words)
2) Tool call(s)
3) One short outcome (≤12 words)
4) One natural next question
`;

async function getPrompt(){
  if (RENDER_PROMPT) return RENDER_PROMPT;
  if (URLS.PROMPT_FETCH) {
    try {
      const { data } = await httpGet(URLS.PROMPT_FETCH, { params:{ biz:DASH_BIZ }, timeout:8000 });
      if (data?.prompt) return data.prompt;
    } catch {}
  }
  return FALLBACK_PROMPT;
}

function systemMessages(prompt){
  const parts = new Intl.DateTimeFormat("en-CA",{
    timeZone:BIZ_TZ, year:"numeric", month:"2-digit", day:"2-digit"
  }).formatToParts(new Date()).reduce((a,x)=>(a[x.type]=x.value,a),{});
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return [
    { role:"system", content:`Today is ${today}. Business timezone: ${BIZ_TZ}. Resolve relative dates in this timezone.` },
    { role:"system", content: prompt }
  ];
}

/* ===== Local time helpers ===== */
function toLocalYmdHm(iso, tz){
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12:false
  }).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
  return `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}`;
}

/* ===== Slot extractor ===== */
function normalizePhone(s){
  if (!s) return "";
  const d = s.replace(/\D/g,"");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.startsWith("+")) return d;
  return "";
}
function extractSlots(ws, text){
  const t = String(text).toLowerCase();
  if (/this (is )?my number|this number/.test(t) && ws.__from) ws.__slots.phone = normalizePhone(ws.__from);
  const mPhone = text.match(/(?:\+?1[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/);
  if (mPhone) ws.__slots.phone = normalizePhone(mPhone[0]);
  if (/\b(in[-\s]?person|at your office|meet in person)\b/.test(t)) ws.__slots.meeting_type = "in-person";
  if (/\b(virtual|zoom|phone call|google meet|teams)\b/.test(t)) ws.__slots.meeting_type = "virtual";
  const mAddr = text.match(/\b\d{2,5}\s+[A-Za-z0-9.\- ]{3,40}\b/);
  if (mAddr && !ws.__slots.location && ws.__slots.meeting_type === "in-person") ws.__slots.location = mAddr[0];
  const mName = text.match(/\b(?:i[' ]?m|this is|my name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (mName) ws.__slots.name = mName[1].trim();
  if (/\b(buyer|buy a home|tour)\b/.test(t)) ws.__slots.service = "buyer";
  if (/\b(seller|list my home|listing)\b/.test(t)) ws.__slots.service = "seller";
  if (/\binvest(ing|or)?\b/.test(t)) ws.__slots.service = "investor";
}
function scratchpadMessage(ws){
  const S = ws.__slots;
  const lines = [
    `Scratchpad`,
    `- Name: ${S.name||""}`,
    `- Phone: ${S.phone||""}`,
    `- Service: ${S.service||""}`,
    `- Meeting Type: ${S.meeting_type||""}`,
    `- Location: ${S.location||""}`,
    `- Notes: ${S.notes||""}`
  ].join("\n");
  return { role:"system", content: lines };
}

/* ===== Tools ===== */
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
        timezone: BIZ_TZ,
        Timezone: BIZ_TZ,
        window: windowObj,
        contact_name: name,
        contact_phone: phone
      };
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000 });
      log("[TOOL][read_availability] ok", windowObj ? JSON.stringify(windowObj) : "");
      return { ok:true, data };
    } catch(e){
      log("[TOOL][read_availability] fail:", e?.response?.status, e?.response?.data?.error || e?.message);
      return { ok:false, status:e.response?.status||0, error:"READ_FAILED", body:e.response?.data };
    }
  },

  async book_appointment(args){
    if (!URLS.CAL_CREATE) return { ok:false, error:"CAL_CREATE_URL_MISSING" };
    try {
      const a = { ...args };
      a.meeting_type = a.meeting_type || "";
      a.location     = a.location     || "";

      // Validate title contains the caller name and is not generic
      const nm = (a.name||"").trim();
      const title = (a.title||"").trim();
      const badGeneric = /voice customer|consultation with voice customer/i.test(title);
      const nameMissing = nm.length === 0;
      const nameNotInTitle = nm && !new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`,'i').test(title);
      if (!title || nameMissing || nameNotInTitle || badGeneric) {
        return { ok:false, status:400, error:"INVALID_TITLE",
          body:{ message:"Title must be '{Type} — {Name}' and include caller name." } };
      }

      // Require a non-empty notes string
      if (!a.notes || !String(a.notes).trim()) {
        return { ok:false, status:400, error:"MISSING_NOTES",
          body:{ message:"Notes are required to describe the appointment." } };
      }

      // Add both local-time strings and dual timezone keys for compatibility
      const startLocal = (a.startISO ? toLocalYmdHm(a.startISO, BIZ_TZ) : "");
      const endLocal   = (a.endISO   ? toLocalYmdHm(a.endISO,   BIZ_TZ) : "");
      const payload = {
        biz: DASH_BIZ,
        source: DASH_SRC,
        Timezone: BIZ_TZ,
        timezone: BIZ_TZ,
        Start_Time_Local: startLocal,
        End_Time_Local: endLocal,
        start_local: startLocal,
        end_local: endLocal,
        ...a // title and notes pass through exactly as provided
      };

      const { data } = await httpPost(URLS.CAL_CREATE, payload, { timeout:12000 });
      log("[TOOL][book_appointment] ok", JSON.stringify({ startISO:a.startISO, endISO:a.endISO }));
      return { ok:true, data };
    } catch(e){
      const status = e?.response?.status;
      const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message;
      log("[TOOL][book_appointment] fail:", status, msg?.slice?.(0,160));
      return { ok:false, status: status||0, error:"CREATE_FAILED", body:e.response?.data };
    }
  },

  async cancel_appointment(args){
    if (!URLS.CAL_DELETE) return { ok:false, error:"CAL_DELETE_URL_MISSING" };
    try {
      const { data, status } = await httpPost(URLS.CAL_DELETE, { intent:"DELETE", biz:DASH_BIZ, source:DASH_SRC, ...args }, { timeout:12000 });
      const ok = (status>=200&&status<300) || data?.ok || data?.deleted || data?.cancelled;
      log("[TOOL][cancel_appointment]", ok?"ok":"not-ok");
      return { ok: !!ok, data };
    } catch(e){
      log("[TOOL][cancel_appointment] fail:", e?.response?.status, e?.response?.data?.error || e?.message);
      return { ok:false, status:e.response?.status||0, error:"DELETE_FAILED", body:e.response?.data };
    }
  },

  async find_customer_events(args){
    if (!URLS.CAL_READ) return { ok:false, error:"CAL_READ_URL_MISSING", events:[] };
    try {
      const payload = { intent:"READ", biz:DASH_BIZ, source:DASH_SRC, timezone:BIZ_TZ, Timezone:BIZ_TZ, ...args };
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000 });
      log("[TOOL][find_customer_events] ok");
      return { ok:true, events: data?.events||[], data };
    } catch(e){
      log("[TOOL][find_customer_events] fail:", e?.response?.status, e?.response?.data?.error || e?.message);
      return { ok:false, status:e.response?.status||0, error:"FIND_FAILED", events:[], body:e.response?.data };
    }
  },

  async lead_upsert(args){
    if (!URLS.LEAD_UPSERT) return { ok:false, error:"LEAD_URL_MISSING" };
    try {
      const { data } = await httpPost(URLS.LEAD_UPSERT, { biz:DASH_BIZ, source:DASH_SRC, ...args }, { timeout:8000 });
      log("[TOOL][lead_upsert] ok");
      return { ok:true, data };
    } catch(e){
      log("[TOOL][lead_upsert] fail:", e?.response?.status, e?.response?.data?.error || e?.message);
      return { ok:false, status:e.response?.status||0, error:"LEAD_FAILED", body:e.response?.data };
    }
  },

  async faq(args){
    try {
      if (URLS.FAQ_LOG) {
        await httpPost(URLS.FAQ_LOG, { biz:DASH_BIZ, source:DASH_SRC, ...args }, { timeout:8000 });
        log("[TOOL][faq] ok");
      }
    } catch(e){ log("[TOOL][faq] fail:", e?.message); }
    return { ok:true };
  },

  async transfer(args){
    const callSid = args.callSid || "";
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OWNER_PHONE || !callSid) return { ok:false, error:"TRANSFER_CONFIG_MISSING" };
    const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
    const handoffUrl = `https://${host}/handoff`;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
    const params = new URLSearchParams({ Url: handoffUrl, Method:"POST" });
    try {
      await httpPost(url, params, {
        auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN },
        headers:{ "Content-Type":"application/x-www-form-urlencoded" }, timeout:10000
      });
      log("[TOOL][transfer] ok");
      return { ok:true };
    } catch(e){
      log("[TOOL][transfer] fail:", e?.response?.status, e?.response?.data?.message || e?.message);
      return { ok:false, status:e.response?.status||0, error:"TRANSFER_FAILED", body:e.response?.data };
    }
  },

  async end_call(args){
    const callSid = args.callSid || "";
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return { ok:false, error:"HANGUP_CONFIG_MISSING" };
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
    const params = new URLSearchParams({ Status:"completed" });
    try {
      await httpPost(url, params, {
        auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN },
        headers:{ "Content-Type":"application/x-www-form-urlencoded" }, timeout:8000
      });
      log("[TOOL][end_call] ok");
      return { ok:true };
    } catch(e){
      log("[TOOL][end_call] fail:", e?.response?.status, e?.response?.data?.message || e?.message);
      return { ok:false, status:e.response?.status||0, error:"HANGUP_FAILED", body:e.response?.data };
    }
  }
};

/* ===== Turn runner ===== */
async function runTurn(ws, baseMessages){
  if (ws.__llmBusy) { ws.__turnQueue = baseMessages; return; }
  ws.__llmBusy = true;

  try {
    let messages = [
      ...baseMessages,
      scratchpadMessage(ws)
    ];

    for (let hops=0; hops<6; hops++){
      log("[LLM] hop", hops, "msgs:", messages.length);
      const choice = await openaiChat(messages);
      const assistantMsg = choice?.message || {};
      const text = (assistantMsg.content || "").trim();
      const calls = assistantMsg.tool_calls || [];

      if (text) {
        log("[LLM] say:", text.slice(0, 140));
        await speakULaw(ws, text);
        ws.__mem.push({ role:"assistant", content:text });
      }

      messages = [...messages, assistantMsg];

      if (!calls?.length) {
        log("[LLM] no tool calls");
        return;
      }

      const seenIds = new Set();
      for (const tc of calls){
        if (!tc?.id || seenIds.has(tc.id)) continue;
        seenIds.add(tc.id);

        const name = tc.function?.name || "";
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}

        if ((name === "transfer" || name === "end_call") && !args.callSid) args.callSid = ws.__callSid || "";

        let windowKey = "";
        if (args?.startISO && args?.endISO) windowKey = `${args.startISO}|${args.endISO}`;

        if ((name === "read_availability" || name === "book_appointment") && windowKey){
          if (ws.__windowFlights.has(windowKey) && name === "read_availability") {
            log("[DEDUP] skip read_availability", windowKey);
            messages.push({ role:"tool", tool_call_id: tc.id, content: JSON.stringify({ ok:true, deduped:true }) });
            messages.push({ role:"system",
              content:"Tool response received. Now, in THIS SAME TURN, say one short outcome line (≤12 words) and ask ONE next question. Do not mention tools or ISO strings." });
            continue;
          }
          ws.__windowFlights.add(windowKey);
        }

        if (name === "book_appointment") {
          args.meeting_type = args.meeting_type ?? ws.__slots.meeting_type ?? "";
          args.location     = args.location     ?? ws.__slots.location ?? "";
          args.name  = args.name  ?? ws.__slots.name  ?? "";
          args.phone = args.phone ?? ws.__slots.phone ?? "";
          args.service = args.service ?? ws.__slots.service ?? "";
        }

        log("[LLM→TOOL]", name, JSON.stringify(args).slice(0, 180));
        const impl = Tools[name];
        const result = impl ? await impl(args) : { ok:false, error:"TOOL_NOT_FOUND" };
        log("[TOOL→LLM]", name, result?.ok ? "ok" : "fail");

        if (name === "book_appointment" && result?.ok) ws.__lastBooked = { startISO: args.startISO, endISO: args.endISO };

        messages.push({ role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) });
        messages.push({ role:"system",
          content:"Tool response received. Now, in THIS SAME TURN, say one short outcome line (≤12 words) and ask ONE next question. Do not repeat the greeting. Do not mention tools or ISO strings." });
      }
    }
  } finally {
    ws.__llmBusy = false;
    if (ws.__turnQueue) { const q = ws.__turnQueue; ws.__turnQueue = null; runTurn(ws, q); }
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
  ws.__mem = [];
  ws.__slots = { name:"", phone:"", service:"", meeting_type:"", location:"", notes:"" };
  ws.__windowFlights = new Set();
  ws.__lastBooked = null;

  const flush = ()=>{
    if (!pending.length || !dg || dg.readyState !== WebSocket.OPEN) return;
    const chunk = Buffer.concat(pending); pending = [];
    try { dg.send(chunk); } catch {}
  };

  ws.on("message", async raw=>{
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start"){
      ws.__streamSid = msg.start?.streamSid || "";
      const cp = msg.start?.customParameters || {};
      ws.__from    = cp.from || "";
      ws.__callSid = cp.CallSid || cp.callSid || "";
      ws.__slots.phone = normalizePhone(ws.__from) || ws.__slots.phone;
      log("[CALL] start", ws.__callSid);

      ws.__prompt = await getPrompt();
      const boot = [
        ...systemMessages(ws.__prompt),
        scratchpadMessage(ws),
        ...ws.__mem.slice(-12),
        { role:"user", content:"<CALL_START>" }
      ];
      await runTurn(ws, boot);

      dg = newDeepgram(async (text)=>{
        extractSlots(ws, text);
        const base = [
          ...systemMessages(ws.__prompt),
          scratchpadMessage(ws),
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
      try { flush(); } catch {}
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }
  });

  ws.on("close", ()=> { try { dg?.close(); } catch {} });
  ws.on("error", ()=> { try { dg?.close(); } catch {} });
});
