/* server.js — Prompt-driven, tool-called voice agent (brain-in-prompt edition)
   - Single prompt controls behavior and policy (RENDER_PROMPT or fetched)
   - Tools are generic; model decides when to call them
   - Minimal env: API keys, Twilio, URLs; everything else lives in the prompt
   - Deepgram μ-law passthrough + ElevenLabs TTS
   - Verbose per-request logging for debugging external calls
*/

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

/* ===== Env / Config ===== */
const PORT = process.env.PORT || 5000;

/* Keys */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

/* Twilio (transfer + hangup) */
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_CALLER_ID   = process.env.TWILIO_CALLER_ID   || ""; // optional outbound callerId
const OWNER_PHONE        = process.env.OWNER_PHONE        || ""; // human transfer target

/* Business / routing identifiers (kept minimal) */
const DASH_BIZ    = process.env.DASH_BIZ || "";           // tenant id string for logs
const DASH_SOURCE = process.env.DASH_SOURCE || "voice";   // e.g., "voice"

/* Business timezone for resolving relative dates */
const BIZ_TZ = process.env.BIZ_TZ || "America/New_York";

/* External endpoints (Replit-first, then DASH_* fallback) */
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

/* ===== HTTP debug wrappers ===== */
const DEBUG_HTTP = (process.env.DEBUG_HTTP ?? "true") === "true";
function rid() { return Math.random().toString(36).slice(2, 8); }
function isWatched(url) {
  if (!url) return false;
  if (url.startsWith("https://api.twilio.com/2010-04-01/Accounts")) return true;
  for (const u of Object.values(URLS)) if (u && url.startsWith(u)) return true;
  return url.startsWith("https://api.openai.com/");
}
function preview(obj, max=320) {
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch { return ""; }
}
async function httpPost(url, data, { headers={}, timeout=12000, auth, tag, trace } = {}) {
  const t = Date.now(), id = rid(), watched = isWatched(url);
  if (DEBUG_HTTP && watched) {
    console.log(JSON.stringify({ evt:"HTTP_REQ", id, tag, method:"POST", url, timeout, trace,
      payload_len: Buffer.byteLength(preview(data, 1<<20), "utf8"), at: new Date().toISOString() }));
  }
  try {
    const resp = await axios.post(url, data, { headers, timeout, auth, responseType: headers.acceptStream ? "stream" : undefined });
    if (DEBUG_HTTP && watched) {
      console.log(JSON.stringify({ evt:"HTTP_RES", id, tag, method:"POST", url,
        status: resp.status, ms: Date.now()-t, resp_preview: headers.acceptStream ? "[stream]" : preview(resp.data),
        at: new Date().toISOString(), trace }));
    }
    return resp;
  } catch (e) {
    const status = e.response?.status || 0;
    const bodyPrev = e.response ? preview(e.response.data) : "";
    console.warn(JSON.stringify({ evt:"HTTP_ERR", id, tag, method:"POST", url, status, ms: Date.now()-t,
      message: e.message, resp_preview: bodyPrev, at: new Date().toISOString(), trace }));
    throw e;
  }
}
async function httpGet(url, { headers={}, timeout=12000, params, auth, tag, trace } = {}) {
  const t = Date.now(), id = rid(), watched = isWatched(url);
  if (DEBUG_HTTP && watched) {
    console.log(JSON.stringify({ evt:"HTTP_REQ", id, tag, method:"GET", url, timeout, params, trace, at: new Date().toISOString() }));
  }
  try {
    const resp = await axios.get(url, { headers, timeout, params, auth });
    if (DEBUG_HTTP && watched) {
      console.log(JSON.stringify({ evt:"HTTP_RES", id, tag, method:"GET", url,
        status: resp.status, ms: Date.now()-t, resp_preview: preview(resp.data), at: new Date().toISOString() }));
    }
    return resp;
  } catch (e) {
    const status = e.response?.status || 0;
    const bodyPrev = e.response ? preview(e.response.data) : "";
    console.warn(JSON.stringify({ evt:"HTTP_ERR", id, tag, method:"GET", url, status, ms: Date.now()-t,
      message: e.message, resp_preview: bodyPrev, at: new Date().toISOString() }));
    throw e;
  }
}

/* ===== Brain prompt (single source of truth) ===== */
const RENDER_PROMPT = process.env.RENDER_PROMPT || `
You are an AI phone receptionist for a professional services company.
You are the sole brain. Decide when to ask, clarify, answer FAQs, read back, book, reschedule, cancel, transfer, or end calls.

Interview style:
- Ask one question at a time. Wait for the answer. Mirror briefly, then move on.
- Keep turns under ~15 words unless reading back details.
- Speak clearly and concisely.

Collect before booking:
- Full name, phone, role, service, address/MLS if showing, preferred date/time, meeting type, notes.

Scheduling policy:
- Read availability with the calendar tool.
- Confirm details and read back date/time once before booking.
- Never double-book a slot.
- If slot is taken, offer the 2–3 closest valid alternatives. Do not repeat “requested time not available” more than once.
- Send reminders a day before the appointment (assume downstream system handles reminders).
- Allow adjustments only up to 20 hours before start.

Cancellation policy:
- Do not cancel unless caller provides the full name on the booking or calls from the number that booked.
- If policy not met, offer transfer.

FAQs you can answer briefly:
- Service areas, pricing ranges, commission basics, pre-approval, staging, open houses, office location, documents to bring, hours, contact methods.

Escalation policy:
- If urgent, complex, or user asks for a human, offer transfer-to-agent.

Closing policy:
- When caller signals completion, ask: “Anything else I can help with?”
- If they say no, deliver one brief goodbye line, then end the call. Do not say goodbye more than once.

Behavioral constraints:
- Do not hallucinate bookings. Use tools.
- Use calendar tools for availability, booking, and canceling.
- Use lead capture tool when a new contact appears.
- Use logging tools to record calls and FAQs when available.
- Keep responses natural but concise.
- Resolve relative dates like “today/tomorrow” in the business timezone if known; otherwise ask.

Output:
- Short, natural voice responses.
`;

/* ===== HTTP + TwiML ===== */
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", (_, res) => res.status(200).send("OK: AI Voice Agent up"));

app.post("/twiml", (req, res) => {
  const from = req.body?.From || "";
  const callSid = req.body?.CallSid || "";
  console.log("[HTTP] /twiml", { from, callSid });

  res.set("Content-Type", "text/xml");
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${host}" track="inbound_track">
          <Parameter name="from" value="${from}"/>
          <Parameter name="CallSid" value="${callSid}"/>
          <Parameter name="callSid" value="${callSid}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim());
  console.log("[HTTP] TwiML served with host", host);
});

/* TwiML handoff target used during live transfer */
app.post("/handoff", (req, res) => {
  const from = req.body?.From || TWILIO_CALLER_ID || "";
  console.log("[HTTP] /handoff]", { from, owner: OWNER_PHONE });
  res.type("text/xml").send(`
    <Response>
      <Say voice="alice">Transferring you now.</Say>
      <Dial callerId="${from}">
        <Number>${OWNER_PHONE}</Number>
      </Dial>
    </Response>
  `.trim());
});

/* Optional: simple goodbye TwiML */
app.post("/goodbye", (_req, res) => {
  res.type("text/xml").send(`<Response><Say voice="alice">Goodbye.</Say><Hangup/></Response>`);
});

const server = app.listen(PORT, () => {
  console.log(`[INIT] listening on ${PORT}`);
  console.log("[INIT] URLS", URLS);
  console.log("[INIT] TENANT", { DASH_BIZ, DASH_SOURCE, BIZ_TZ });
});
const wss = new WebSocketServer({ server });

/* ===== Utilities ===== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- Time helpers (Local/UTC pairing for READ + relative dates) ---- */
function toLocalParts(iso, tz) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12:false
  });
  const p = f.formatToParts(d).reduce((a,x)=> (a[x.type]=x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; // "YYYY-MM-DD HH:mm"
}
function asUTC(iso) {
  return new Date(iso).toISOString(); // "YYYY-MM-DDTHH:mm:ss.sssZ"
}
function dayWindowLocal(dateISO, tz) {
  // Local wall-clock bounds for the given day + equivalent UTC
  const start_local = `${dateISO} 00:00`;
  const end_local   = `${dateISO} 23:59`;
  // Build Date from local midnight in tz by using offset of "fake" ISO with tz applied via formatter
  // For our backend validator we just need UTC strings at local 00:00 and 23:59
  const start_utc = new Date(`${dateISO}T00:00:00`).toISOString();
  const end_utc   = new Date(`${dateISO}T23:59:00`).toISOString();
  return { start_local, end_local, start_utc, end_utc, timezone: tz };
}
function todayISOInTZ(tz){
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = f.formatToParts(new Date()).reduce((a,x)=> (a[x.type]=x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`; // YYYY-MM-DD
}

/* === Deepgram ASR (μ-law passthrough) === */
function startDeepgram({ onFinal }) {
  const url =
    "wss://api.deepgram.com/v1/listen"
    + "?encoding=mulaw"
    + "&sample_rate=8000"
    + "&channels=1"
    + "&model=nova-2-phonecall"
    + "&interim_results=true"
    + "&smart_format=true"
    + "&endpointing=250";
  console.log("[Deepgram] connecting", url);
  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });
  dg.on("open", () => console.log("[Deepgram] open"));

  let lastInterimLog = 0;
  dg.on("message", (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    const alt = ev.channel?.alternatives?.[0];
    const text = (alt?.transcript || "").trim();
    if (!text) return;
    if (ev.is_final || ev.speech_final) {
      console.log(`[ASR FINAL] ${text}`);
      onFinal?.(text);
    } else {
      const now = Date.now();
      if (now - lastInterimLog > 1500) {
        console.log(`[ASR interim] ${text}`);
        lastInterimLog = now;
      }
    }
  });
  dg.on("error", e => console.error("[Deepgram error]", e.message));
  dg.on("close", () => console.log("[Deepgram] closed"));
  return {
    sendULaw(buf){
      try { dg.send(buf); } catch(e){ console.error("[Deepgram send error]", e.message); }
    },
    close(){ try { dg.close(); } catch {} }
  };
}

/* === ElevenLabs TTS === */
function cleanTTS(s=""){
  return String(s)
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/^-+\s*/gm, "")
    .replace(/^\d+\.\s*/gm, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, ", ")
    .trim();
}
function shouldSpeak(ws, normalized=""){
  const now = Date.now();
  return !(ws.__lastBotText === normalized && now - (ws.__lastBotAt || 0) < 4000);
}
function speakifyPhoneNumbers(s=""){
  const toDigits = str => str.replace(/\D+/g, "");
  const spaceDigits = digits => digits.split("").join(" ");
  return s
    .replace(/\+?1?[\s.-]*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/g, (m) => {
      let d = toDigits(m);
      if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
      if (d.length === 10) return spaceDigits(d);
      return spaceDigits(toDigits(m));
    })
    .replace(/\d{7,}/g, (m) => spaceDigits(m));
}
async function say(ws, text) {
  if (!text || !ws.__streamSid) return;
  const speak = speakifyPhoneNumbers(cleanTTS(text));
  if (!shouldSpeak(ws, speak)) return;

  ws.__lastBotText = speak;
  ws.__lastBotAt = Date.now();
  console.log(JSON.stringify({ event:"BOT_SAY", reply:speak }));
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn("[TTS] missing ElevenLabs credentials");
    return;
  }
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await httpPost(url, { text: speak, voice_settings:{ stability:0.4, similarity_boost:0.8 } },
      { headers:{ "xi-api-key":ELEVENLABS_API_KEY, acceptStream: true }, timeout: 20000, tag:"TTS_STREAM", trace:{ streamSid: ws.__streamSid } });
    resp.data.on("data", chunk => {
      const b64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event:"media", streamSid:ws.__streamSid, media:{ payload:b64 } }));
    });
    resp.data.on("end", () => console.log("[TTS] stream end"));
  } catch(e){ console.error("[TTS ERROR]", e.message); }
}

/* ===== Minimal Memory ===== */
function newMemory() {
  return {
    transcript: [],
    entities: { name:"", phone:"", service:"", date:"", time:"" },
    summary: ""
  };
}
function remember(mem, from, text){ mem.transcript.push({from, text}); if(mem.transcript.length>200) mem.transcript.shift(); }

/* ===== Tool Registry (prompt-driven usage) ===== */
const Tools = {
  // FIXED: Build the window with Local↔UTC pairing your validator expects.
  async read_availability({ dateISO, startISO, endISO }) {
    console.log("[TOOL] read_availability", { dateISO, startISO, endISO });
    if (!URLS.CAL_READ) return { text:"Calendar read unavailable." };
    try {
      let windowObj;

      if (startISO && endISO) {
        const start_local = toLocalParts(startISO, BIZ_TZ);
        const end_local   = toLocalParts(endISO,   BIZ_TZ);
        windowObj = {
          start_local,
          end_local,
          start_utc: asUTC(startISO),
          end_utc:   asUTC(endISO),
        };
      } else if (dateISO) {
        const w = dayWindowLocal(dateISO, BIZ_TZ);
        windowObj = {
          start_local: w.start_local,
          end_local:   w.end_local,
          start_utc:   w.start_utc,
          end_utc:     w.end_utc,
        };
      } else {
        // If model forgot to provide a date, default to "today" in business TZ
        const today = todayISOInTZ(BIZ_TZ);
        const w = dayWindowLocal(today, BIZ_TZ);
        windowObj = {
          start_local: w.start_local,
          end_local:   w.end_local,
          start_utc:   w.start_utc,
          end_utc:     w.end_utc,
        };
      }

      const payload = {
        intent: "READ",
        biz: DASH_BIZ,
        source: DASH_SOURCE,
        timezone: BIZ_TZ,
        window: windowObj
      };

      const { data } = await httpPost(URLS.CAL_READ, payload, {
        timeout: 12000,
        tag: "CAL_READ",
        trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid }
      });
      return { data };
    } catch(e){ return { text:"Could not read availability." }; }
  },

  async book_appointment({ name, phone, service, startISO, endISO, notes }) {
    console.log("[TOOL] book_appointment", { name, service, startISO, endISO });
    if (!URLS.CAL_CREATE) return { text:"Calendar booking unavailable." };
    try {
      // Keep your simple booking flow; backend will validate hours.
      const payload = {
        Event_Name: `${service||"Appointment"} (${name||"Guest"})`,
        Start_Time: startISO,
        End_Time: endISO,
        Customer_Name: name||"",
        Customer_Phone: phone||"",
        Customer_Email: "",
        Notes: notes||service||"",
        biz: DASH_BIZ,
        source: DASH_SOURCE
      };
      const { data } = await httpPost(URLS.CAL_CREATE, payload, {
        timeout:12000, tag:"CAL_CREATE",
        trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid }
      });
      return { data, text:"Booked." };
    } catch(e){ return { text:"Booking failed." }; }
  },

  async cancel_appointment({ event_id, name, phone }) {
    console.log("[TOOL] cancel_appointment", { event_id });
    if (!URLS.CAL_DELETE) return { text:"Cancellation unavailable." };
    try {
      const { data, status } = await httpPost(URLS.CAL_DELETE,
        { intent:"DELETE", biz:DASH_BIZ, source:DASH_SOURCE, event_id, name, phone },
        { timeout:12000, tag:"CAL_DELETE", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
      const ok = (status>=200&&status<300) || data?.ok===true || data?.deleted===true;
      return { text: ok ? "Canceled." : "Could not cancel.", data };
    } catch(e){ return { text:"Cancellation failed." }; }
  },

  async lead_upsert({ name, phone, intent, notes }) {
    console.log("[TOOL] lead_upsert]", { name, intent });
    if (!URLS.LEAD_UPSERT) return { text:"Lead logging unavailable." };
    try {
      const { data } = await httpPost(URLS.LEAD_UPSERT,
        { biz:DASH_BIZ, source:DASH_SOURCE, name, phone, intent, notes },
        { timeout: 8000, tag:"LEAD_UPSERT", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
      return { data };
    } catch { return { text:"" }; }
  },

  async faq({ topic, service }) {
    console.log("[TOOL] faq", { topic, service });
    try {
      if (URLS.FAQ_LOG) {
        await httpPost(URLS.FAQ_LOG, { biz:DASH_BIZ, source:DASH_SOURCE, topic, service },
          { timeout:8000, tag:"FAQ_LOG", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
      }
    } catch {}
    return { data:{ topic, service } };
  },

  async transfer({ reason, callSid }) {
    console.log("[TOOL] transfer", { reason, callSid, owner: OWNER_PHONE });
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OWNER_PHONE || !callSid) {
      return { text:"Transfer not configured." };
    }
    try {
      const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
      const handoffUrl = `https://${host}/handoff`;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Url: handoffUrl, Method: "POST" });
      const auth = { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN };
      await httpPost(url, params, {
        auth, timeout: 10000, tag:"TWILIO_REDIRECT",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        trace:{ callSid, convoId: currentTrace.convoId }
      });
      return { text:"Transferring you now. Please hold." };
    } catch { return { text:"Transfer failed." }; }
  },

  async end_call({ callSid, reason }) {
    console.log("[TOOL] end_call", { callSid, reason });
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return { text:"" };
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Status: "completed" });
      const auth = { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN };
      await httpPost(url, params, {
        auth, timeout: 10000, tag:"TWILIO_HANGUP",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        trace:{ callSid, reason, convoId: currentTrace.convoId }
      });
      return { text:"" };
    } catch { return { text:"" }; }
  }
};

/* Tool schema advertised to the model (the model chooses based on prompt policy) */
const toolSchema = [
  { type:"function", function:{
      name:"read_availability",
      description:"Read calendar availability in a given window",
      parameters:{ type:"object", properties:{
        dateISO:{type:"string", description:"YYYY-MM-DD in business timezone"},
        startISO:{type:"string", description:"ISO start"},
        endISO:{type:"string", description:"ISO end"}
      }, required:[] }
  }},
  { type:"function", function:{
      name:"book_appointment",
      description:"Create a calendar event",
      parameters:{ type:"object", properties:{
        name:{type:"string"}, phone:{type:"string"}, service:{type:"string"},
        startISO:{type:"string"}, endISO:{type:"string"}, notes:{type:"string"}
      }, required:["service","startISO","endISO"] }
  }},
  { type:"function", function:{
      name:"cancel_appointment",
      description:"Cancel a calendar event by id; caller must prove identity per policy",
      parameters:{ type:"object", properties:{
        event_id:{type:"string"}, name:{type:"string"}, phone:{type:"string"}
      }, required:["event_id"] }
  }},
  { type:"function", function:{
      name:"lead_upsert",
      description:"Create or update a lead/contact for this caller",
      parameters:{ type:"object", properties:{
        name:{type:"string"}, phone:{type:"string"}, intent:{type:"string"}, notes:{type:"string"}
      }, required:["name","phone"] }
  }},
  { type:"function", function:{
      name:"faq",
      description:"Log or answer FAQs like hours, prices, services, location",
      parameters:{ type:"object", properties:{ topic:{type:"string"}, service:{type:"string"} }, required:[] }
  }},
  { type:"function", function:{
      name:"transfer",
      description:"Transfer the caller to a human",
      parameters:{ type:"object", properties:{ reason:{type:"string"}, callSid:{type:"string"} }, required:[] }
  }},
  { type:"function", function:{
      name:"end_call",
      description:"Politely end the call immediately",
      parameters:{ type:"object", properties:{ callSid:{type:"string"}, reason:{type:"string"} }, required:[] }
  }}
];

/* ===== LLM ===== */
async function openaiChat(messages, options={}){
  const headers = { Authorization:`Bearer ${OPENAI_API_KEY}` };
  const body = {
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages,
    tools: toolSchema,
    tool_choice: "auto",
    response_format: { type: "text" },
    ...options
  };
  const { data } = await httpPost("https://api.openai.com/v1/chat/completions", body, {
    headers, timeout: 30000, tag:"OPENAI_CHAT", trace: { convoId: currentTrace.convoId, callSid: currentTrace.callSid }
  });
  return data.choices?.[0];
}

/* Build system prompt with runtime facts only; everything else is in RENDER_PROMPT */
function buildSystemPrompt(mem, tenantPrompt) {
  const todayISO = todayISOInTZ(BIZ_TZ); // resolve "today" in business TZ
  const p = (tenantPrompt || RENDER_PROMPT);
  return [
    { role:"system", content: `Today is ${todayISO}. Business timezone: ${BIZ_TZ}. Resolve relative dates in this timezone.` },
    { role:"system", content: p },
    { role:"system", content:
`Hard constraints:
- Use tools for availability, booking, canceling, transfer, FAQ logging, lead capture, and hangup.
- Do not fabricate tool outcomes. If a tool fails, explain briefly and offer next steps.
- Keep replies under ~25 words unless reading back details.
- One goodbye line only, then end_call.` },
    { role:"system", content: `<memory_summary>${mem.summary}</memory_summary>` }
  ];
}

/* Turn user/bot text into chat messages */
function buildMessages(mem, userText, tenantPrompt) {
  const sys = buildSystemPrompt(mem, tenantPrompt);
  const history = mem.transcript.slice(-12).map(m =>
    ({ role: m.from === "user" ? "user" : "assistant", content: m.text })
  );
  return [...sys, ...history, { role:"user", content:userText }];
}

/* ===== WS wiring ===== */
let currentTrace = { convoId:"", callSid:"" }; // updated per-connection
wss.on("connection", (ws) => {
  console.log("[WS] connection from Twilio]");
  let dg = null;
  let pendingULaw = [];
  const BATCH = 10; // ~200ms @ 8kHz
  let tailTimer = null;
  let lastMediaLog = 0;

  // Per-call state
  ws.__handling = false;
  ws.__queuedTurn = null;
  ws.__lastUserText = "";
  ws.__lastUserAt = 0;

  // Closing state
  ws.__closeIntentCount = 0;
  ws.__awaitingCloseConfirm = false;
  ws.__closing = false;
  ws.__saidFarewell = false;

  // Dedup speech
  ws.__lastBotText = "";
  ws.__lastBotAt = 0;

  // Logging
  ws.__postedLog = false;

  // Graceful hangup window
  ws.__hangTimer = null;
  ws.__pendingHangupUntil = 0;

  function clearHangTimer() {
    if (ws.__hangTimer) { clearTimeout(ws.__hangTimer); ws.__hangTimer = null; }
    ws.__pendingHangupUntil = 0;
  }
  function scheduleHangup(ms = 2500) {
    clearHangTimer();
    ws.__pendingHangupUntil = Date.now() + ms;
    ws.__hangTimer = setTimeout(async () => {
      try { await Tools.end_call({ callSid: ws.__callSid, reason: "caller done" }); } catch {}
      try { ws.close(); } catch {}
      setTimeout(() => { try { ws.terminate?.(); } catch {} }, 1500);
    }, ms);
  }
  function flushULaw() {
    if (!pendingULaw.length || !dg) return;
    const chunk = Buffer.concat(pendingULaw);
    pendingULaw = [];
    const now = Date.now();
    if (now - lastMediaLog > 2000) {
      console.log("[MEDIA] flush", { frames: Math.round(chunk.length / 160), bytes: chunk.length });
      lastMediaLog = now;
    }
    dg.sendULaw(chunk);
  }

  async function postCallLogOnce(ws, reason) {
    if (ws.__postedLog) return;
    ws.__postedLog = true;

    const trace = { convoId: ws.__convoId || "", callSid: ws.__callSid || "", from: ws.__from || "" };

    const transcriptArr = ws.__mem?.transcript || [];
    const transcriptText = transcriptArr.map(t => `${t.from}: ${t.text}`).join("\n");

    const payload = {
      biz: DASH_BIZ,
      source: DASH_SOURCE,
      convoId: trace.convoId,
      callSid: trace.callSid,
      from: trace.from,
      summary: ws.__mem?.summary || "",
      transcript: transcriptText,
      ended_reason: reason || ""
    };

    try {
      if (URLS.CALL_LOG) {
        await httpPost(URLS.CALL_LOG, payload, { timeout: 10000, tag:"CALL_LOG", trace });
      } else {
        console.warn("[CALL_LOG] URL missing");
      }
    } catch {}

    try {
      if (URLS.CALL_SUMMARY) {
        await httpPost(URLS.CALL_SUMMARY, payload, {
          timeout: 8000, tag:"CALL_SUMMARY", trace
        });
      } else {
        console.warn("[CALL_SUMMARY] URL missing");
      }
    } catch {}
  }

  ws.__mem = newMemory();

  ws.on("message", async raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      ws.__convoId = uuidv4();
      const cp = msg.start?.customParameters || {};
      ws.__from = cp.from || "";
      ws.__callSid = cp.CallSid || cp.callSid || "";
      currentTrace = { convoId: ws.__convoId, callSid: ws.__callSid };
      console.log("[CALL_START]", { convoId: ws.__convoId, streamSid: ws.__streamSid, from: ws.__from, callSid: ws.__callSid });

      // Optionally fetch tenant-specific prompt
      ws.__tenantPrompt = "";
      if (URLS.PROMPT_FETCH) {
        try {
          const { data } = await httpGet(
            `${URLS.PROMPT_FETCH}?biz=${encodeURIComponent(DASH_BIZ)}`,
            { timeout: 10000, tag:"PROMPT_FETCH", trace:{ convoId: ws.__convoId, callSid: ws.__callSid } }
          );
          if (data?.prompt) ws.__tenantPrompt = data.prompt;
          console.log("[PROMPT_FETCH] ok", { hasPrompt: !!data?.prompt });
        } catch(e){
          console.warn("[PROMPT_FETCH] error", e.message);
        }
      }

      dg = startDeepgram({
        onFinal: async (text) => {
          if (ws.__pendingHangupUntil && Date.now() < ws.__pendingHangupUntil) {
            console.log("[HANG] user spoke during grace window — ignoring");
            return;
          }

          const now = Date.now();
          if (text === ws.__lastUserText && (now - ws.__lastUserAt) < 1500) {
            console.log("[TURN] dropped duplicate final");
            return;
          }
          ws.__lastUserText = text;
          ws.__lastUserAt = now;

          if (ws.__handling) {
            ws.__queuedTurn = text;
            return;
          }
          ws.__handling = true;
          remember(ws.__mem, "user", text);
          await handleTurn(ws, text);
          ws.__handling = false;

          if (ws.__queuedTurn) {
            const next = ws.__queuedTurn;
            ws.__queuedTurn = null;
            ws.__handling = true;
            remember(ws.__mem, "user", next);
            await handleTurn(ws, next);
            ws.__handling = false;
          }
        }
      });

      await say(ws, `Hi, how can I help?`);
      remember(ws.__mem, "bot", `Hi, how can I help?`);
      return;
    }

    if (msg.event === "media") {
      if (!dg) return;
      const ulaw = Buffer.from(msg.media?.payload || "", "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= BATCH) flushULaw();
      clearTimeout(tailTimer);
      tailTimer = setTimeout(flushULaw, 120);
      return;
    }

    if (msg.event === "stop") {
      console.log("[CALL_STOP]", { convoId: ws.__convoId });
      try { flushULaw(); } catch {}
      try { dg?.close(); } catch {}
      await postCallLogOnce(ws, "twilio stop");
      try { ws.close(); } catch {}
    }
  });

  ws.on("close", async () => {
    try { dg?.close(); } catch {}
    clearHangTimer();
    await postCallLogOnce(ws, "socket close");
    console.log("[WS] closed", { convoId: ws.__convoId });
  });

  /* ===== Turn handler (prompt is the brain) ===== */
  async function handleTurn(ws, userText) {
    console.log("[TURN] user >", userText);

    // Soft intent to end
    const byeHint = /\b(that's all|that is all|i'?m good|i'?m okay|no thanks|no thank you|nothing else|that'?ll be it|i'?m fine|all set|im fine|im good|nope|bye|goodbye|see you)\b/i;
    if (byeHint.test(userText)) {
      ws.__closeIntentCount += 1;
      ws.__awaitingCloseConfirm = ws.__closeIntentCount === 1;
      if (ws.__closeIntentCount >= 2) {
        ws.__closing = true;
      }
    }

    const messages = buildMessages(ws.__mem, userText, ws.__tenantPrompt);
    let choice;
    try {
      choice = await openaiChat(messages);
    } catch(e){
      console.error("[GPT] fatal", e.message);
      return;
    }

    /* Tool flow (model decides) */
    if (choice?.message?.tool_calls?.length) {
      for (const tc of choice.message.tool_calls) {
        const name = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}

        if ((name === "transfer" || name === "end_call") && !args.callSid) args.callSid = ws.__callSid || "";
        console.log("[TOOL] call ->", name, args);

        const impl = Tools[name];
        let toolResult = { text:"" };
        if (impl) {
          try { toolResult = await impl(args); }
          catch(e){ console.error("[TOOL] error", name, e.message); toolResult = { text:"" }; }
        } else {
          console.warn("[TOOL] missing impl", name);
        }

        // Follow-up turn after tool result
        let follow;
        try {
          follow = await openaiChat([
            ...messages,
            choice.message,
            { role:"tool", tool_call_id: tc.id, content: JSON.stringify(toolResult) }
          ]);
        } catch(e){
          console.error("[GPT] follow error", e.message);
          continue;
        }

        const botText = (follow?.message?.content || "").trim() || toolResult.text || "";
        if (botText) {
          await say(ws, botText);
          remember(ws.__mem, "bot", botText);
        }

        if (name === "end_call") {
          ws.__saidFarewell = true;
          ws.__closing = true;
          scheduleHangup(2000);
        }
      }

      await updateSummary(ws.__mem);
      return;
    }

    /* Normal AI reply */
    const botText = (choice?.message?.content || "").trim();
    if (botText) {
      await say(ws, botText);
      remember(ws.__mem, "bot", botText);
    }

    if (ws.__closing && !ws.__saidFarewell) {
      ws.__saidFarewell = true;
      scheduleHangup(2000);
    }

    await updateSummary(ws.__mem);
  }
});

/* ===== Rolling summary ===== */
async function updateSummary(mem) {
  const last = mem.transcript.slice(-16).map(m => `${m.from}: ${m.text}`).join("\n");
  try {
    const { data } = await httpPost(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          { role:"system", content:`Summarize the dialog in 2 lines. Include name, phone, service, date/time if known. TZ=${BIZ_TZ}.` },
          { role:"user", content: last }
        ]
      },
      { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }, timeout: 20000, tag:"OPENAI_SUMMARY",
        trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } }
    );
    mem.summary = data.choices?.[0]?.message?.content?.trim()?.slice(0, 500) || "";
    console.log("[SUMMARY] len", mem.summary.length);
  } catch(e){
    console.warn("[SUMMARY] error", e.message);
  }
}

/* ===== Notes =====
- Keep tenant behavior/business facts in RENDER_PROMPT (or serve via PROMPT_FETCH).
- The model decides when to call tools based on your prompt policy.
- READ endpoint now receives Local↔UTC paired window + timezone so validation passes.
*/
