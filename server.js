/*

voice agent (brain-in-prompt edition)
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
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_CALLER_ID = process.env.TWILIO_CALLER_ID || ""; // optional outbound callerId
const OWNER_PHONE = process.env.OWNER_PHONE || ""; // human transfer target

/* Business / routing identifiers (kept minimal) */
const DASH_BIZ = process.env.DASH_BIZ || "";
const DASH_SOURCE = process.env.DASH_SOURCE || "voice";

/* Optional timezone to resolve relative dates. */
const BIZ_TZ = process.env.BIZ_TZ || "America/New_York";

/* External endpoints (Replit-first, then DASH_* fallback) */
const URLS = {
  CAL_READ: process.env.REPLIT_READ_URL || process.env.DASH_CAL_READ_URL || "",
  CAL_CREATE: process.env.REPLIT_CREATE_URL || process.env.DASH_CAL_CREATE_URL || "",
  CAL_DELETE: process.env.REPLIT_DELETE_URL || process.env.DASH_CAL_CANCEL_URL || "",
  LEAD_UPSERT: process.env.REPLIT_LEAD_URL || process.env.DASH_LEAD_UPSERT_URL || "",
  FAQ_LOG: process.env.REPLIT_FAQ_URL || process.env.DASH_CALL_LOG_URL || "",
  CALL_LOG: process.env.DASH_CALL_LOG_URL || "",
  CALL_SUMMARY: process.env.DASH_CALL_SUMMARY_URL || "",
  PROMPT_FETCH: process.env.PROMPT_FETCH_URL || ""
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
    console.log(JSON.stringify({ evt:"HTTP_REQ", id, tag, method:"POST", url, timeout, trace, payload_len: Buffer.byteLength(preview(data, 1<<20), "utf8"), at: new Date().toISOString() }));
  }
  try {
    const resp = await axios.post(url, data, { headers, timeout, auth, responseType: headers.acceptStream ? "stream" : undefined });
    if (DEBUG_HTTP && watched) {
      console.log(JSON.stringify({ evt:"HTTP_RES", id, tag, method:"POST", url, status: resp.status, ms: Date.now()-t, resp_preview: headers.acceptStream ? "[stream]" : preview(resp.data), at: new Date().toISOString(), trace }));
    }
    return resp;
  } catch (e) {
    const status = e.response?.status || 0;
    const bodyPrev = e.response ? preview(e.response.data) : "";
    console.warn(JSON.stringify({ evt:"HTTP_ERR", id, tag, method:"POST", url, status, ms: Date.now()-t, message: e.message, resp_preview: bodyPrev, at: new Date().toISOString(), trace }));
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
      console.log(JSON.stringify({ evt:"HTTP_RES", id, tag, method:"GET", url, status: resp.status, ms: Date.now()-t, resp_preview: preview(resp.data), at: new Date().toISOString() }));
    }
    return resp;
  } catch (e) {
    const status = e.response?.status || 0;
    const bodyPrev = e.response ? preview(e.response.data) : "";
    console.warn(JSON.stringify({ evt:"HTTP_ERR", id, tag, method:"GET", url, status, ms: Date.now()-t, message: e.message, resp_preview: bodyPrev, at: new Date().toISOString() }));
    throw e;
  }
}

/* ===== Brain prompt (single source of truth) ===== */
const RENDER_PROMPT = process.env.RENDER_PROMPT || `
You are an AI phone receptionist for **The Victory Team (VictoryTeamSells.com)** — Maryland real estate.

Business facts:
- Brand/Tone: Trusted, top-1% Maryland real estate team led by Dan McGhee. Friendly, concise, confident, service-first.
- Service areas: Maryland (Harford County focus; Bel Air HQ).
- Office: 1316 E Churchville Rd, Bel Air, MD 21014.
- Main phone to read back if asked: 833-888-1754.
- Hours: Mon–Fri 9:00 AM–5:00 PM (America/New_York). Outside hours: capture lead and offer callback.
- Core services: buyer consults & tours, seller/listing consults (mention **1.75% listing model** if selling), investor guidance, general real estate Q&A; direct to online buyer/seller resources if helpful.
- Positioning points (only when relevant): 600+ homes sold; $220M+ closed; Top 1% nationwide; consistent 5★ reviews.

Interview style:
- Ask one question at a time, wait for answer, mirror briefly.
- Keep turns under ~15 words unless reading back details.
- Sound warm, efficient, local.
- Don’t re-ask collected info; if uncertain, confirm succinctly (“I have Tue 10 AM—correct?”).

Collect before booking (ask only for missing items):
- Full name, phone, role (buyer/seller/investor/tenant/landlord), service type (buyer tour, listing consult, etc.), property address/MLS if a showing, preferred date/time, meeting type (phone/office/in-person showing), notes.

Scheduling policy:
- **Always resolve relative dates in America/New_York.**
- When you produce start/end, **convert to UTC ISO with “Z”** (Eastern time → UTC) before calling booking tools.
- Read availability first; confirm details and read back once before booking.
- Never double-book; if conflict appears, propose 2–3 nearest alternatives.
- Reminders are downstream; just confirm “You’ll get a reminder.”

Booking rules (strict):
- Do **NOT** call \`book_appointment\` until you have: name, phone, role, service, meeting type, **both date & time**.
- Default duration = **30 minutes** if unspecified.
- Payload to \`book_appointment\`: \`{ name, phone, service, startISO, endISO, notes }\` using **UTC “Z”**.
- If a tool fails, read the error briefly, fix the payload (often missing time), retry once, then offer alternatives or transfer.

Cancellation policy:
- Only cancel for the person on the booking (or same number). Else, offer transfer.

FAQs (keep brief):
- Hours, service areas, office, basic buyer/seller process, 1.75% listing model (if selling), what to bring, contact methods, website resources.

Escalation/transfer:
- If urgent/complex or caller requests a human, offer transfer-to-agent.

Handling cut-off / partial speech:
- If input is clipped/unclear: briefly clarify (“It sounded like ‘…’. Could you repeat?”).
- **Do not interrupt mid-speech**; wait until user stops talking for ~1 second before replying.

Closing policy:
- When caller indicates they’re done, ask “Anything else I can help with?”
- If no, give one short goodbye line and end the call.

Behavioral constraints:
- Do not fabricate tool outcomes; always use tools for availability, booking, canceling, transfer, lead logging, and call logging.
- Keep responses natural, concise, and on-brand.
- Outside business hours: capture name/number/service + best time to reach them; promise a callback during office hours.

Greeting:
- Start with: “Thanks for calling The Victory Team in Bel Air—how can I help today?”

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
</Response>`.trim());
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

/* === Deepgram ASR (μ-law passthrough) === */
/* Fix 1: allow longer speaking without cutoff (endpointing=1000ms + talk-detection) */
function startDeepgram({ onFinal, onInterim }) {
  const url = "wss://api.deepgram.com/v1/listen"
    + "?encoding=mulaw"
    + "&sample_rate=8000"
    + "&channels=1"
    + "&model=nova-2-phonecall"
    + "&interim_results=true"
    + "&smart_format=true"
    + "&endpointing=1000"; // <-- was 250; now 1000ms silence to finalize

  console.log("[Deepgram] connecting", url);
  const dg = new WebSocket(url, { headers: { Authorization: `token ${DEEPGRAM_API_KEY}` }, perMessageDeflate: false });

  dg.on("open", () => console.log("[Deepgram] open"));
  let lastInterimLog = 0;

  dg.on("message", (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;

    const alt = ev.channel?.alternatives?.[0];
    const text = (alt?.transcript || "").trim();
    const isFinal = !!(ev.is_final || ev.speech_final);

    if (!text && !isFinal) return;

    if (!isFinal) {
      onInterim?.(text);
      const now = Date.now();
      if (text && now - lastInterimLog > 1500) {
        console.log("[ASR interim]", text);
        lastInterimLog = now;
      }
      return;
    }

    console.log("[ASR FINAL]", text);
    onFinal?.(text);
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
    .replace(/`{1,3}[^]*`{1,3}/g, "")
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

/* Fix 1b: do not speak while user is talking (simple barge-in guard) */
async function waitUntilUserQuiet(ws, maxWaitMs=3500) {
  const start = Date.now();
  while (ws.__userTalking && Date.now() - start < maxWaitMs) {
    await sleep(100);
  }
}

async function say(ws, text) {
  if (!text || !ws.__streamSid) return;
  const speak = speakifyPhoneNumbers(cleanTTS(text));
  if (!shouldSpeak(ws, speak)) return;

  // Wait briefly if user is still talking (guard against cutting them off)
  await waitUntilUserQuiet(ws, 3500);

  ws.__lastBotText = speak;
  ws.__lastBotAt = Date.now();
  console.log(JSON.stringify({ event:"BOT_SAY", reply:speak }));

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn("[TTS] missing ElevenLabs credentials");
    return;
  }
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await httpPost(url, { text: speak, voice_settings:{ stability:0.4, similarity_boost:0.8 } }, { headers:{ "xi-api-key":ELEVENLABS_API_KEY, acceptStream: true }, timeout: 20000, tag:"TTS_STREAM", trace:{ streamSid: ws.__streamSid } });
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
function remember(mem, from, text){
  mem.transcript.push({from, text});
  if(mem.transcript.length>200) mem.transcript.shift();
}

/* ===== Time helpers: Eastern -> UTC ISO(Z) ===== */
function toUTCZFromEastern(easternISOOrLocal) {
  // Accepts "YYYY-MM-DDTHH:mm:ss" or with 'Z' or offset; force interpretation in America/New_York and output UTC 'Z'
  // For simplicity, rely on Date with explicit offset using Intl (approx). Caller should pass ISO with timezone if possible.
  const d = new Date(easternISOOrLocal); // if already with tz, OK; if local, server local—prefer explicit in prompt.
  return new Date(d.getTime() - (new Date().getTimezoneOffset()*60000)).toISOString(); // fallback
}

/* ===== Tool Registry (prompt-driven usage) ===== */
const Tools = {
  async read_availability({ dateISO, startISO, endISO }) {
    console.log("[TOOL] read_availability", { dateISO, startISO, endISO });
    if (!URLS.CAL_READ) return { text:"Calendar read unavailable." };
    try {
      const payload = {
        intent:"READ",
        biz: DASH_BIZ,
        source: DASH_SOURCE,
        window:{
          start: startISO || `${dateISO||""}T00:00:00Z`,
          end:   endISO   || `${dateISO||""}T23:59:59Z`
        }
      };
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000, tag:"CAL_READ", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
      return { data };
    } catch(e){ return { text:"Could not read availability." }; }
  },

  async book_appointment({ name, phone, service, startISO, endISO, notes }) {
    console.log("[TOOL] book_appointment", { name, service, startISO, endISO });
    if (!URLS.CAL_CREATE) return { text:"Calendar booking unavailable." };
    try {
      // Enforce UTC 'Z' to avoid timezone drift
      const startZ = /Z$/.test(startISO||"") ? startISO : (startISO ? `${startISO.replace(/Z?$/,"")}Z` : "");
      const endZ   = /Z$/.test(endISO||"")   ? endISO   : (endISO   ? `${endISO.replace(/Z?$/,"")}Z`   : "");

      const payload = {
        Event_Name: `${service||"Appointment"} (${name||"Guest"})`,
        Start_Time: startZ,
        End_Time: endZ,
        Customer_Name: name||"",
        Customer_Phone: phone||"",
        Customer_Email: "",
        Notes: notes||service||"",
        biz: DASH_BIZ,
        source: DASH_SOURCE
      };
      const { data } = await httpPost(URLS.CAL_CREATE, payload, { timeout:12000, tag:"CAL_CREATE", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
      return { data, text:"Booked." };
    } catch(e){ return { text:"Booking failed." }; }
  },

  async cancel_appointment({ event_id, name, phone }) {
    console.log("[TOOL] cancel_appointment", { event_id });
    if (!URLS.CAL_DELETE) return { text:"Cancellation unavailable." };
    try {
      const { data, status } = await httpPost(URLS.CAL_DELETE, { intent:"DELETE", biz:DASH_BIZ, source:DASH_SOURCE, event_id, name, phone }, { timeout:12000, tag:"CAL_DELETE", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
      const ok = (status>=200&&status<300) || data?.ok===true || data?.deleted===true;
      return { text: ok ? "Canceled." : "Could not cancel.", data };
    } catch(e){ return { text:"Cancellation failed." }; }
  },

  async lead_upsert({ name, phone, intent, notes }) {
    console.log("[TOOL] lead_upsert", { name, intent });
    if (!URLS.LEAD_UPSERT) return { text:"Lead logging unavailable." };
    try {
      const { data } = await httpPost(URLS.LEAD_UPSERT, { biz:DASH_BIZ, source:DASH_SOURCE, name, phone, intent, notes }, { timeout: 8000, tag:"LEAD_UPSERT", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
      return { data };
    } catch { return { text:"" }; }
  },

  async faq({ topic, service }) {
    console.log("[TOOL] faq", { topic, service });
    try {
      if (URLS.FAQ_LOG) {
        await httpPost(URLS.FAQ_LOG, { biz:DASH_BIZ, source:DASH_SOURCE, topic, service }, { timeout:8000, tag:"FAQ_LOG", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
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
      await httpPost(url, params, { auth, timeout: 10000, tag:"TWILIO_REDIRECT", headers: { "Content-Type": "application/x-www-form-urlencoded" }, trace:{ callSid, convoId: currentTrace.convoId } });
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
      await httpPost(url, params, { auth, timeout: 10000, tag:"TWILIO_HANGUP", headers: { "Content-Type": "application/x-www-form-urlencoded" }, trace:{ callSid, reason, convoId: currentTrace.convoId } });
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
      startISO:{type:"string", description:"ISO start (UTC Z preferred)"},
      endISO:{type:"string", description:"ISO end (UTC Z preferred)"}
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
  const { data } = await httpPost("https://api.openai.com/v1/chat/completions", body, { headers, timeout: 30000, tag:"OPENAI_CHAT", trace: { convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
  return data.choices?.[0];
}

/* Build system prompt with runtime facts only; everything else is in RENDER_PROMPT */
function buildSystemPrompt(mem, tenantPrompt) {
  const todayISO = new Date().toISOString().slice(0,10);
  const p = (tenantPrompt || RENDER_PROMPT);
  return [
    { role:"system", content: `Today is ${todayISO}. Business timezone: ${BIZ_TZ}. Resolve relative dates in this timezone.` },
    { role:"system", content: p },
    { role:"system", content: `Hard constraints:
- Use tools for availability, booking, canceling, transfer, FAQ logging, lead capture, and hangup.
- Do not fabricate tool outcomes. If a tool fails, explain briefly and offer next steps.
- Keep replies under ~25 words unless reading back details.
- Wait ~1s after user stops talking before replying (don’t interrupt).
- One goodbye line only, then end_call.` },
    { role:"system", content: `<memory_summary>${mem.summary}</memory_summary>` }
  ];
}

/* Turn user/bot text into chat messages */
function buildMessages(mem, userText, tenantPrompt) {
  const sys = buildSystemPrompt(mem, tenantPrompt);
  const history = mem.transcript.slice(-12).map(m => ({ role: m.from === "user" ? "user" : "assistant", content: m.text }) );
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

  // Talk detection (don’t speak while user is talking)
  ws.__userTalking = false;
  let talkQuietTimer = null;
  function markTalking() {
    ws.__userTalking = true;
    if (talkQuietTimer) clearTimeout(talkQuietTimer);
    // consider user quiet if no interim for 1100ms
    talkQuietTimer = setTimeout(() => { ws.__userTalking = false; }, 1100);
  }

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
    const payload = { biz: DASH_BIZ, source: DASH_SOURCE, convoId: trace.convoId, callSid: trace.callSid, from: trace.from, summary: ws.__mem?.summary || "", transcript: ws.__mem?.transcript || [], ended_reason: reason || "" };
    try {
      if (URLS.CALL_LOG) { await httpPost(URLS.CALL_LOG, payload, { timeout: 10000, tag:"CALL_LOG", trace }); }
      else { console.warn("[CALL_LOG] URL missing"); }
    } catch {}
    try {
      if (URLS.CALL_SUMMARY) { await httpPost(URLS.CALL_SUMMARY, { ...payload, transcript: undefined }, { timeout: 8000, tag:"CALL_SUMMARY", trace }); }
      else { console.warn("[CALL_SUMMARY] URL missing"); }
    } catch {}
  }

  ws.__mem = newMemory();

  ws.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

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
        } catch(e){ console.warn("[PROMPT_FETCH] error", e.message); }
      }

      dg = startDeepgram({
        onInterim: (_t) => { markTalking(); },
        onFinal: async (text) => {
          // Ignore speech during hangup grace
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

          // Debounce: if another interim arrives soon, let user continue (avoid cutting off)
          await sleep(80);

          if (ws.__handling) { ws.__queuedTurn = text; return; }
          ws.__handling = true;
          remember(ws.__mem, "user", text);
          await handleTurn(ws, text);
          ws.__handling = false;

          if (ws.__queuedTurn) {
            const next = ws.__queuedTurn; ws.__queuedTurn = null;
            ws.__handling = true;
            remember(ws.__mem, "user", next);
            await handleTurn(ws, next);
            ws.__handling = false;
          }
        }
      });

      await say(ws, "Thanks for calling The Victory Team in Bel Air—how can I help today?");
      remember(ws.__mem, "bot", "Thanks for calling The Victory Team in Bel Air—how can I help today?");
      return;
    }

    if (msg.event === "media") {
      if (!dg) return;
      const ulaw = Buffer.from(msg.media?.payload || "", "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= BATCH) flushULaw();
      clearTimeout(tailTimer);
      tailTimer = setTimeout(flushULaw, 140);
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
    if (talkQuietTimer) clearTimeout(talkQuietTimer);
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
      if (ws.__closeIntentCount >= 2) { ws.__closing = true; }
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
        } else { console.warn("[TOOL] missing impl", name); }

        // Follow-up turn after tool result
        let follow;
        try {
          follow = await openaiChat([
            ...messages,
            choice.message,
            { role:"tool", tool_call_id: tc.id, content: JSON.stringify(toolResult) }
          ]);
        } catch(e){ console.error("[GPT] follow error", e.message); continue; }

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
      { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }, timeout: 20000, tag:"OPENAI_SUMMARY", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } }
    );
    mem.summary = data.choices?.[0]?.message?.content?.trim()?.slice(0, 500) || "";
    console.log("[SUMMARY] len", mem.summary.length);
  } catch(e){ console.warn("[SUMMARY] error", e.message); }
}

/*
Notes
- Longer Deepgram endpointing (1000ms) + talk detection prevents cutting users off.
- Booking payloads normalized to UTC “Z” to avoid timezone drift in your Replit calendar.
- Transcripts & summaries still posted at end of call to CALL_LOG/CALL_SUMMARY.
*/
