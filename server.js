/* server.js — Prompt-driven, tool-called voice agent (copy/paste ready)
   - Behavior controlled by RENDER_PROMPT (or fetch from your dashboard)
   - Tools are pluggable. Toggle with CAPABILITIES flags per tenant.
   - Memory: running transcript + extracted entities + summary.
   - NOW with verbose logs + Twilio track fix + Deepgram μ-law passthrough.
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
/* Twilio (transfer + hangup) */
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const OWNER_PHONE        = process.env.OWNER_PHONE        || "";

/* Per-tenant business config */
const BIZ = {
  id: process.env.BIZ_ID || "oldline",
  name: process.env.BIZ_NAME || "Old Line Barbershop",
  phone: process.env.BIZ_PHONE || "",
  timezone: process.env.BIZ_TZ || "America/New_York",
  hours: process.env.BIZ_HOURS_JSON || `{"mon_fri":"09:00-17:00","weekends":"closed"}`,
  location: process.env.BIZ_LOCATION || "123 Blueberry Ln",
  services: (process.env.BIZ_SERVICES_JSON || `[
    {"name":"haircut","mins":30,"price":30},
    {"name":"beard trim","mins":15,"price":15},
    {"name":"combo","mins":45,"price":40}
  ]`)
};

/* External endpoints (Replit-first, then DASH_* fallback) */
const URLS = {
  CAL_READ:   process.env.REPLIT_READ_URL   || process.env.DASH_CAL_READ_URL   || "",
  CAL_CREATE: process.env.REPLIT_CREATE_URL || process.env.DASH_CAL_CREATE_URL || "",
  CAL_DELETE: process.env.REPLIT_DELETE_URL || process.env.DASH_CAL_CANCEL_URL || "",
  FAQ_LOG:    process.env.REPLIT_FAQ_URL    || process.env.DASH_CALL_LOG_URL   || "",
  PROMPT_FETCH: process.env.PROMPT_FETCH_URL || "",
  CALL_LOG: process.env.DASH_CALL_LOG_URL || "",
  CALL_SUMMARY: process.env.DASH_CALL_SUMMARY_URL || ""
};

/* Feature toggles per tenant */
const CAPABILITIES = {
  booking:   (process.env.CAP_BOOKING   ?? "true") === "true",
  cancel:    (process.env.CAP_CANCEL    ?? "true") === "true",
  faq:       (process.env.CAP_FAQ       ?? "true") === "true",
  smalltalk: (process.env.CAP_SMALLTALK ?? "true") === "true",
  transfer:  (process.env.CAP_TRANSFER  ?? "false") === "true"
};

/* Primary prompt (may be overridden by dashboard at call start) */
const RENDER_PROMPT = process.env.RENDER_PROMPT || `
You are {{BIZ_NAME}}’s AI receptionist.

Interview style:
- Ask ONE question at a time. Wait for the answer. Then ask the next.
- Mirror briefly, then move forward.
- Keep each turn under ~15 words unless reading back details.

Collect before booking: caller name, phone, role (buyer/seller/landlord/tenant), service, address/MLS if showing, preferred date/time, meeting type (in-person/phone), notes (budget, pre-approval, timeline).

Rules:
- Confirm details and read back date/time before booking.
- If showing request lacks address/MLS, ask for it first.
- Offer nearest alternative slots if conflict.
- For FAQs: coverage areas, commission basics, pre-approval, staging, open houses, office location, documents to bring.
- If urgent or complex, offer transfer to agent.
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
  const from = req.body?.From || BIZ.phone || "";
  console.log("[HTTP] /handoff]", { from, owner: OWNER_PHONE });
  res.type("text/xml").send(`
    <Response>
      <Say voice="alice">Transferring you now.</Say>
      <Dial callerId="${from || BIZ.phone || ""}">
        <Number>${OWNER_PHONE}</Number>
      </Dial>
    </Response>
  `.trim());
});

/* Optional: simple goodbye TwiML */
app.post("/goodbye", (_req, res) => {
  res.type("text/xml").send(`<Response><Say voice="alice">Goodbye.</Say><Hangup/></Response>`);
});

const server = app.listen(PORT, () => console.log(`[INIT] listening on ${PORT}`));
const wss = new WebSocketServer({ server });

/* ===== Utilities ===== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    if (ev.type !== "Results") return;
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
/* Strip markdown/formatting before TTS to avoid garbled speech */
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

/* Ensure phone numbers are read digit-by-digit */
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
  console.log(JSON.stringify({ event:"BOT_SAY", reply:speak }));
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn("[TTS] missing ElevenLabs credentials");
    return;
  }
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await axios.post(url, { text: speak, voice_settings:{ stability:0.4, similarity_boost:0.8 } },
      { headers:{ "xi-api-key":ELEVENLABS_API_KEY }, responseType:"stream" });
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

/* ===== Tool Registry (pluggable) ===== */
const Tools = {
  async read_availability({ dateISO, startISO, endISO }) {
    console.log("[TOOL] read_availability", { dateISO, startISO, endISO });
    if (!CAPABILITIES.booking || !URLS.CAL_READ) return { text:"Booking is unavailable." };
    try {
      const payload = { intent:"READ", biz:BIZ.id, source:"voice", window:{ start:startISO||`${dateISO}T00:00:00`, end:endISO||`${dateISO}T23:59:59` } };
      const t0 = Date.now();
      const { data } = await axios.post(URLS.CAL_READ, payload, { timeout:12000 });
      console.log("[TOOL] read_availability ok", { ms: Date.now()-t0 });
      return { data };
    } catch(e){ console.error("[TOOL] read_availability error", e.message); return { text:"I could not reach the calendar." }; }
  },
  async book_appointment({ name, phone, service, startISO, endISO, notes }) {
    console.log("[TOOL] book_appointment", { name, service, startISO, endISO });
    if (!CAPABILITIES.booking || !URLS.CAL_CREATE) return { text:"Booking is unavailable." };
    try {
      const payload = {
        Event_Name: `${service||"Appointment"} (${name||"Guest"})`,
        Start_Time: startISO, End_Time: endISO,
        Customer_Name: name||"", Customer_Phone: phone||"", Customer_Email: "",
        Notes: notes||service||""
      };
      const t0 = Date.now();
      const { data } = await axios.post(URLS.CAL_CREATE, payload, { timeout:12000 });
      console.log("[TOOL] book_appointment ok", { ms: Date.now()-t0 });
      return { data, text:"Booked." };
    } catch(e){ console.error("[TOOL] book_appointment error", e.message); return { text:"I couldn't book that just now." }; }
  },
  async cancel_appointment({ event_id }) {
    console.log("[TOOL] cancel_appointment", { event_id });
    if (!CAPABILITIES.cancel || !URLS.CAL_DELETE) return { text:"Cancellation is unavailable." };
    try {
      const t0 = Date.now();
      const { data, status } = await axios.post(URLS.CAL_DELETE, { intent:"DELETE", biz:BIZ.id, source:"voice", event_id }, { timeout:12000 });
      const ok = (status>=200&&status<300) || data?.ok===true || data?.deleted===true;
      console.log("[TOOL] cancel_appointment result", { ms: Date.now()-t0, ok });
      return { text: ok ? "Canceled." : "Could not cancel." , data };
    } catch(e){ console.error("[TOOL] cancel_appointment error]", e.message); return { text:"I couldn't cancel that." }; }
  },
  async faq({ topic, service }) {
    console.log("[TOOL] faq", { topic, service });
    if (!CAPABILITIES.faq) return { text:"" };
    try { if (URLS.FAQ_LOG) await axios.post(URLS.FAQ_LOG, { topic, service }); } catch {}
    return { data:{ topic, service } };
  },
  async transfer({ reason, callSid }) {
    console.log("[TOOL] transfer", { reason, callSid, owner: OWNER_PHONE });
    if (!CAPABILITIES.transfer) return { text:"" };
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OWNER_PHONE || !callSid) {
      console.warn("[TOOL] transfer missing config or callSid]");
      return { text:"Sorry, I can’t transfer right now." };
    }
    try {
      const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
      const handoffUrl = `https://${host}/handoff`;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Url: handoffUrl, Method: "POST" });
      const auth = { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN };
      const t0 = Date.now();
      const resp = await axios.post(url, params, {
        auth,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000
      });
      console.log("[TOOL] transfer redirect ok", { ms: Date.now()-t0, status: resp.status });
      return { text:"Transferring you now. Please hold." };
    } catch(e){
      console.error("[TOOL] transfer redirect error", e.message);
      return { text:"Sorry, transfer failed." };
    }
  },
  async end_call({ callSid, reason }) {
    console.log("[TOOL] end_call", { callSid, reason });
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) {
      console.warn("[TOOL] end_call missing config or callSid");
      return { text:"" };
    }
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Status: "completed" });
      const auth = { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN };
      const t0 = Date.now();
      const resp = await axios.post(url, params, {
        auth,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000
      });
      console.log("[TOOL] end_call ok", { ms: Date.now()-t0, status: resp.status });
      return { text:"" };
    } catch(e){
      console.error("[TOOL] end_call error", e.message);
      return { text:"" };
    }
  },
  async store_memory({ key, value }) {
    console.log("[TOOL] store_memory", { key });
    return { data:{ saved:true } };
  }
};

/* Tool schema advertised to the model */
const toolSchema = [
  { type:"function", function:{
      name:"read_availability",
      description:"Read calendar availability in a given window",
      parameters:{ type:"object", properties:{
        dateISO:{type:"string"}, startISO:{type:"string"}, endISO:{type:"string"}
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
      description:"Cancel a calendar event by id",
      parameters:{ type:"object", properties:{ event_id:{type:"string"} }, required:["event_id"] }
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
  }},
  { type:"function", function:{
      name:"store_memory",
      description:"Store a memory key/value for this caller",
      parameters:{ type:"object", properties:{ key:{type:"string"}, value:{type:"string"} }, required:["key","value"] }
  }}
];

/* ===== LLM ===== */
async function openaiChat(messages, options={}) {
  console.log("[GPT] request", { msgs: messages.length });
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
  const t0 = Date.now();
  const { data } = await axios.post("https://api.openai.com/v1/chat/completions", body, { headers });
  const choice = data.choices?.[0];
  console.log("[GPT] ok", {
    ms: Date.now()-t0,
    toolCalls: choice?.message?.tool_calls?.length || 0,
    hasText: !!(choice?.message?.content || "").trim()
  });
  return choice;
}

/* Build system prompt with tenant facts + runtime summary */
function buildSystemPrompt(mem, tenantPrompt) {
  const profile = {
    BIZ_NAME: BIZ.name,
    PHONE: BIZ.phone,
    LOCATION: BIZ.location,
    TIMEZONE: BIZ.timezone,
    HOURS: JSON.parse(BIZ.hours),
    SERVICES: JSON.parse(BIZ.services)
  };
  const p = (tenantPrompt || RENDER_PROMPT).replaceAll("{{BIZ_NAME}}", BIZ.name);
  const todayISO = new Date().toISOString().slice(0,10);
  return [
    { role:"system", content: `Today is ${todayISO} and the business timezone is ${BIZ.timezone}. Resolve relative dates like "today" and "tomorrow" in this timezone.` },
    { role:"system", content: p },
    { role:"system", content: `<biz_profile>${JSON.stringify(profile)}</biz_profile>` },
    { role:"system", content: `<memory_summary>${mem.summary}</memory_summary>` },
    { role:"system", content:
`Rules:
- Sound human and conversational. Acknowledge, then move things forward.
- Use tools for availability, booking, canceling, FAQs, transfer, and hangup. Do not fabricate.
- Extract and reuse caller details you learn: name, phone, service, date, time.
- Confirm key details before booking. Offer alternatives if conflict.
- On first hint of “I’m good / that’s all / bye”: ask “Anything else I can help with?”.
- If they then decline clearly, say a warm goodbye, then end the call.
- Keep replies under ~25 words unless reading back details.
` }
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
wss.on("connection", (ws) => {
  console.log("[WS] connection from Twilio]");
  let dg = null;
  let pendingULaw = [];
  const BATCH = 10; // ~200ms @ 8kHz
  let tailTimer = null;
  let lastMediaLog = 0;

  // Per-call state
  ws.__askedCloseConfirm = false;
  ws.__closeIntentCount = 0;
  ws.__handling = false;
  ws.__queuedTurn = null;
  ws.__lastUserText = "";
  ws.__lastUserAt = 0;
  ws.__closing = false;       // NEW
  ws.__saidFarewell = false;  // NEW

  // For logging
  ws.__postedLog = false;

  // Graceful hangup window
  ws.__hangTimer = null;
  ws.__pendingHangupUntil = 0;

  function clearHangTimer() {
    if (ws.__hangTimer) { clearTimeout(ws.__hangTimer); ws.__hangTimer = null; }
    ws.__pendingHangupUntil = 0;
  }

  // Force hangup completion and ignore late speech
  function scheduleHangup(ms = 2500) {
    clearHangTimer();
    ws.__pendingHangupUntil = Date.now() + ms;
    ws.__hangTimer = setTimeout(async () => {
      try { await Tools.end_call({ callSid: ws.__callSid, reason: "caller done" }); } catch(e){ console.error("[TOOL] end_call exec error", e.message); }
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
    try {
      const payload = {
        biz: BIZ.id,
        source: "voice",
        convoId: ws.__convoId || "",
        callSid: ws.__callSid || "",
        from: ws.__from || "",
        summary: ws.__mem?.summary || "",
        transcript: ws.__mem?.transcript || [],
        ended_reason: reason || ""
      };
      if (URLS.CALL_LOG) {
        const t0 = Date.now();
        await axios.post(URLS.CALL_LOG, payload, { timeout: 10000 });
        console.log("[CALL_LOG] posted", { ms: Date.now()-t0 });
      }
      if (URLS.CALL_SUMMARY) {
        const t1 = Date.now();
        await axios.post(URLS.CALL_SUMMARY, { ...payload, transcript: undefined }, { timeout: 8000 });
        console.log("[CALL_SUMMARY] posted", { ms: Date.now()-t1 });
      }
    } catch (e) {
      console.warn("[CALL_LOG] post error", e.message);
    }
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
      console.log("[CALL_START]", { convoId: ws.__convoId, streamSid: ws.__streamSid, from: ws.__from, callSid: ws.__callSid });

      ws.__tenantPrompt = "";
      if (URLS.PROMPT_FETCH) {
        try {
          const { data } = await axios.get(`${URLS.PROMPT_FETCH}?biz=${encodeURIComponent(BIZ.id)}`);
          if (data?.prompt) ws.__tenantPrompt = data.prompt;
          console.log("[PROMPT_FETCH] ok", { hasPrompt: !!data?.prompt });
        } catch(e){
          console.warn("[PROMPT_FETCH] error", e.message);
        }
      }

      dg = startDeepgram({
        onFinal: async (text) => {
          // If closing, ignore further ASR turns
          if (ws.__closing) return;

          // If farewell window active, ignore late speech
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

      await say(ws, `Hi, thanks for calling ${BIZ.name}. How can I help?`);
      remember(ws.__mem, "bot", `Hi, thanks for calling ${BIZ.name}. How can I help?`);
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

  /* ===== Turn handler ===== */
  async function handleTurn(ws, userText) {
    console.log("[TURN] user >", userText);

    const byeHint = /\b(that's all|that is all|i'?m good|i'?m okay|no thanks|no thank you|nothing else|that'?ll be it|i'?m fine|all set|im fine|im good|nope\.?\s*that'?s it|bye|goodbye|see you)\b/i;

    if (byeHint.test(userText)) {
      ws.__closeIntentCount += 1;

      if (ws.__closeIntentCount === 1 && !ws.__askedCloseConfirm) {
        ws.__askedCloseConfirm = true;
        const line = "Got it. Anything else I can help with before I let you go?";
        await say(ws, line);
        remember(ws.__mem, "bot", line);
        await updateSummary(ws.__mem);
        return;
      }

      if (!ws.__saidFarewell) {
        ws.__saidFarewell = true;
        ws.__closing = true;
        scheduleHangup(2500);
        const farewell = "Alright — thanks for calling. Have a great day! Bye.";
        await say(ws, farewell);
        remember(ws.__mem, "bot", farewell);
        await updateSummary(ws.__mem);
      }
      return;
    }

    const messages = buildMessages(ws.__mem, userText, ws.__tenantPrompt);
    let choice;
    try {
      choice = await openaiChat(messages);
    } catch(e){
      console.error("[GPT] fatal", e.message);
      return;
    }

    if (choice?.message?.tool_calls?.length) {
      const toolCall = choice.message.tool_calls[0];
      const name = toolCall.function.name;
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}

      if ((name === "transfer" || name === "end_call") && !args.callSid) args.callSid = ws.__callSid || "";
      console.log("[TOOL] call ->", name, args);

      if (name === "end_call") {
        if (!ws.__saidFarewell) {
          ws.__saidFarewell = true;
          ws.__closing = true;
          scheduleHangup(2500);
          const farewell = "Alright — thanks for calling. Have a great day! Bye.";
          await say(ws, farewell);
          remember(ws.__mem, "bot", farewell);
          await updateSummary(ws.__mem);
        }
        return;
      }

      const impl = Tools[name];
      let toolResult = { text:"" };
      if (impl) {
        try { toolResult = await impl(args); }
        catch(e){ console.error("[TOOL] error", name, e.message); toolResult = { text:"" }; }
      } else {
        console.warn("[TOOL] missing impl", name);
      }

      let follow;
      try {
        follow = await openaiChat([...messages,
          choice.message,
          { role:"tool", tool_call_id: toolCall.id, content: JSON.stringify(toolResult) }
        ]);
      } catch(e){
        console.error("[GPT] follow error", e.message);
        return;
      }
      const botText = (follow?.message?.content || "").trim() || toolResult.text || "";
      console.log("[TURN] bot (tool-follow) >", botText);
      if (botText && !ws.__closing) {
        await say(ws, botText);
        remember(ws.__mem, "bot", botText);
      }

      if (name === "transfer") {
        try { ws.close(); } catch {}
      }

      await updateSummary(ws.__mem);
      return;
    }

    const botText = (choice?.message?.content || "").trim();
    console.log("[TURN] bot >", botText);
    if (botText && !ws.__closing) {
      await say(ws, botText);
      remember(ws.__mem, "bot", botText);
    }
    await updateSummary(ws.__mem);
  }
});

/* ===== Rolling summary ===== */
async function updateSummary(mem) {
  const last = mem.transcript.slice(-16).map(m => `${m.from}: ${m.text}`).join("\n");
  try {
    const t0 = Date.now();
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          { role:"system", content:"Summarize the dialog in 2 lines. Include name, phone, service, date/time if known." },
          { role:"user", content: last }
        ]
      },
      { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` } }
    );
    mem.summary = data.choices[0].message.content.trim().slice(0, 500);
    console.log("[SUMMARY] len", mem.summary.length, "ms", Date.now()-t0);
  } catch(e){
    console.warn("[SUMMARY] error", e.message);
  }
}

/* ===== How to extend =====
1) Add a tool:
   - Implement async function in Tools (return {text?, data?}).
   - Add its JSON schema in toolSchema.
2) Per-client setup:
   - Set BIZ_* env vars and CAP_* toggles.
   - Set RENDER_PROMPT or host it at PROMPT_FETCH.
   - Point REPLIT_* URLs to that tenant’s endpoints.
3) Behavior control:
   - Edit prompt text only. Keep server identical across customers.
*/
