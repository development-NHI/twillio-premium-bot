/* server.js — Prompt-driven voice agent (transport only)
   - Model decides everything via tools; JS executes verbatim
   - μ-law passthrough: Twilio → Deepgram, ElevenLabs TTS → Twilio
   - Robustness: singleton WS, serialized TTS, single-flight LLM, slim deps
   
   ✅ FIXED FOR RECEPTORX INTEGRATION
   - Only tool implementations changed to match ReceptorX API format
   - All TTS, Deepgram, WebSocket, and prompt logic UNTOUCHED
   
   ✅ V2 FIXES:
   - read_availability: Changed from GET to POST with JSON body
   - Scratchpad preservation after tool failures
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

// Use your existing dashboard URLs
const URLS = {
  CAL_CREATE:   process.env.DASH_CAL_CREATE_URL   || "",
  CAL_READ:     process.env.DASH_CAL_READ_URL     || "",
  CAL_CANCEL:   process.env.DASH_CAL_CANCEL_URL   || "",
  LEAD_UPSERT:  process.env.DASH_LEAD_UPSERT_URL  || "",
  FAQ_LOG:      process.env.DASH_CALL_LOG_URL     || "",
  CALL_SUMMARY: process.env.DASH_CALL_SUMMARY_URL || "",
  PROMPT_FETCH: process.env.PROMPT_FETCH_URL      || ""
};

const RECEPTORX_USER_ID = process.env.RECEPTORX_USER_ID || "developer-user";

const PRE_CONNECT_GREETING = process.env.PRE_CONNECT_GREETING || "";
const RENDER_PROMPT        = process.env.RENDER_PROMPT || "";

/* ===== Minimal utils ===== */
const DEBUG = (process.env.DEBUG || "true") === "true";
const log = (...a)=>{ if (DEBUG) console.log(...a); };
async function httpPost(url, data, cfg={}){ return axios.post(url, data, cfg); }
async function httpGet(url, cfg={}){ return axios.get(url, cfg); }
function escapeXml(s = "") {
  return s.replace(/[<>&'"]/g, c => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
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
    .replace(/<[\s\S]*?>/g,"")
    .replace(/\[(.?)\]\((.?)\)/g,"$1")
    .replace(/\s{2,}/g," ")
    .trim();
}
async function speakULaw(ws, text){
  if (!text || !ws._streamSid) return;
  const clean = cleanTTS(text);
  ws._ttsQ = ws._ttsQ || Promise.resolve();
  ws._ttsQ = ws._ttsQ.then(async ()=>{
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await httpPost(url, { text: clean }, {
      headers:{ "xi-api-key":ELEVENLABS_API_KEY, accept:"*/*" },
      responseType:"stream", timeout:20000
    });
    await new Promise((resolve,reject)=>{
      resp.data.on("data", chunk=>{
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          event:"media",
          streamSid: ws._streamSid,
          media:{ payload: Buffer.from(chunk).toString("base64") }
        }));
      });
      resp.data.on("end", resolve);
      resp.data.on("error", reject);
    });
  }).catch(()=>{});
  return ws._ttsQ;
}

/* ===== LLM with tools - EXACT SCHEMAS MATCHING PROMPT ===== */
const toolSchema = [
  { type:"function", function:{ name:"read_availability",
    description:"Check if a time slot is available. REQUIRED: startISO and endISO in ISO format (e.g., '2025-10-16T14:00:00'). Returns: {ok, available, conflicts}",
    parameters:{ type:"object", properties:{
      startISO:{type:"string", description:"REQUIRED: ISO timestamp for start (e.g., '2025-10-16T14:00:00')"},
      endISO:{type:"string", description:"REQUIRED: ISO timestamp for end (e.g., '2025-10-16T15:00:00')"}
    }, required:["startISO","endISO"] } } },
  { type:"function", function:{ name:"book_appointment",
    description:"Create appointment. REQUIRED: name, phone (+1XXXXXXXXXX), service, startISO, endISO, meeting_type ('in-person'/'virtual'), location, title ('{Type} — {Name}'). Returns: {ok, appointmentId, title, startTime, endTime}",
    parameters:{ type:"object", properties:{
      name:{type:"string", description:"REQUIRED: Caller's full name"},
      phone:{type:"string", description:"REQUIRED: Normalized phone +1XXXXXXXXXX"},
      service:{type:"string", description:"REQUIRED: Service type (buyer/seller/investor)"},
      startISO:{type:"string", description:"REQUIRED: ISO timestamp start"},
      endISO:{type:"string", description:"REQUIRED: ISO timestamp end"},
      meeting_type:{type:"string", description:"REQUIRED: 'in-person' or 'virtual'"},
      location:{type:"string", description:"REQUIRED: Address if in-person, '' if virtual"},
      title:{type:"string", description:"REQUIRED: Format '{Type} — {Name}'"},
      notes:{type:"string", description:"OPTIONAL: Appointment details"}
    }, required:["name","phone","service","startISO","endISO","meeting_type","location","title"] } } },
  { type:"function", function:{ name:"cancel_appointment",
    description:"Cancel appointment. REQUIRED: event_id from find_customer_events. Returns: {ok, cancelled, appointmentId, title}",
    parameters:{ type:"object", properties:{
      event_id:{type:"string", description:"REQUIRED: Event ID from find_customer_events"}
    }, required:["event_id"] } } },
  { type:"function", function:{ name:"find_customer_events",
    description:"Find appointments for customer. REQUIRED: name, phone (+1XXXXXXXXXX), days (use 30). Returns: {ok, events[{event_id, title, start, end, location}]}",
    parameters:{ type:"object", properties:{
      name:{type:"string", description:"REQUIRED: Customer's name"},
      phone:{type:"string", description:"REQUIRED: Normalized phone +1XXXXXXXXXX"},
      days:{type:"number", description:"REQUIRED: Days to search (use 30)"}
    }, required:["name","phone","days"] } } },
  { type:"function", function:{ name:"lead_upsert",
    description:"Create/update lead. REQUIRED: name, phone (+1XXXXXXXXXX). OPTIONAL: intent, notes. Returns: {ok, leadId, name, phone}",
    parameters:{ type:"object", properties:{
      name:{type:"string", description:"REQUIRED: Lead's name"},
      phone:{type:"string", description:"REQUIRED: Normalized phone +1XXXXXXXXXX"},
      intent:{type:"string", description:"OPTIONAL: What they're interested in"},
      notes:{type:"string", description:"OPTIONAL: Call details"}
    }, required:["name","phone"] } } },
  { type:"function", function:{ name:"faq",
    description:"Log FAQ call. OPTIONAL: topic, service. Returns: {ok}",
    parameters:{ type:"object", properties:{ 
      topic:{type:"string", description:"OPTIONAL: What they asked about"},
      service:{type:"string", description:"OPTIONAL: Related service"}
    }, required:[] } } },
  { type:"function", function:{ name:"transfer",
    description:"Transfer to human agent. OPTIONAL: reason. callSid auto-filled. Call transfers immediately.",
    parameters:{ type:"object", properties:{ 
      reason:{type:"string", description:"OPTIONAL: Why transfer needed"},
      callSid:{type:"string", description:"AUTO-FILLED by system"}
    }, required:[] } } },
  { type:"function", function:{ name:"end_call",
    description:"End the call. OPTIONAL: reason. callSid auto-filled. Call ends immediately.",
    parameters:{ type:"object", properties:{ 
      callSid:{type:"string", description:"AUTO-FILLED by system"},
      reason:{type:"string", description:"OPTIONAL: Why call ending"}
    }, required:[] } } }
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
[Prompt-Version: 2025-10-12T02:20Z • confirm-before-book • include-meeting-type+location • same-turn end_call • status+tool pairing • single-flight • pinned-ISO • no-tool-speech]

You are the AI phone receptionist for ${DASH_BIZ} (VictoryTeamSells.com) — Maryland real estate.
Timezone: ${BIZ_TZ}. Hours: Mon–Fri 09:00–17:00.

Brand
- Friendly, concise, confident, local.
- Office: 1316 E Churchville Rd, Bel Air MD 21014. Main: 833-888-1754.
- Services: buyer consults and tours; seller/listing consults (mention 1.75% if asked); investors; general Q&A.

Opening
- Say EXACTLY: "Thanks for calling The Victory Team. How can I help you today?"

Question Phrasing (use natural variations)
- Instead of "What brings you in?" → "What can I help you with?" OR "Are you looking to buy or sell?"
- Keep responses brief, conversational, and natural

Core Interaction Rules
- Prompt-driven only. Transport executes exactly the tool calls you request.
- One question at a time. ≤15 words unless reading back details.
- Respect barge-in. No repeats. Check your scratchpad before asking.

Scratchpad
- Name, Phone (+1XXXXXXXXXX normalized), Role, Service, Property/MLS, Date, Time, Meeting Type, Location, Notes.

Identity and Numbers
- Use caller ID if they say "this number." Never speak full phone numbers. If pressed, confirm only the last two digits.

Status/Tool Pairing Contract
- A status line MUST be followed by the matching tool call in the SAME turn.
- After the tool result, say one short outcome line, then ask one question.
- Single-flight: never call the same tool twice for the same ISO window; dedupe by "startISO|endISO."
- Never say function names, arguments, or ISO strings.

Required Fields BEFORE any read_availability or book_appointment
- You MUST have: service, name, phone, meeting type (in-person or virtual), and location (if in-person).
- If any are missing, ask exactly one question to get the next missing item.

Confirm-Then-Book (strict)
1) Propose the time and get an explicit "yes."
2) Encode the exact local hour in ${BIZ_TZ} with correct offset, e.g., 2025-10-13T15:00:00-04:00 to 16:00:00-04:00.
3) Call read_availability(startISO,endISO) in the SAME turn.
4) If free → outcome "That hour is open." Then call book_appointment in the SAME turn with the SAME startISO/endISO. Include meeting_type and location, and copy them into Notes.
5) If busy or booking fails → outcome line (≤12 words). Offer 2–3 nearby in-hours options and ask one question.
6) After booking, confirm weekday + full date, time, meeting type, location, and notes. Then ask if they need anything else.

Reschedule / Cancel
- Use find_customer_events(name, phone, days=30). If one future match, capture event_id.
- Reschedule: verify new hour via read_availability → cancel_appointment(event_id) → book_appointment with the verified ISOs.
- Cancel: cancel_appointment(event_id). Outcome line. Ask if they want to rebook.

Transfer / End
- If caller asks for a human, call transfer(reason, callSid) and stop.
- When the caller declines more help or says goodbye, say "Thanks for calling The Victory Team. Have a great day. Goodbye." and in the SAME TURN call end_call(callSid).

Latency / Failure
- If a tool will run, first say one short status line, then call the tool in the same turn.
- If a tool fails, give a 5–10 word outcome and propose one concrete next step.

Tools you may call
- read_availability(dateISO?, startISO?, endISO?, name?, phone?)
- book_appointment(name, phone, service, startISO, endISO, title?, notes?, meeting_type?, location?)
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
    try { const { data } = await httpGet(URLS.PROMPT_FETCH, { params:{ biz:DASH_BIZ }, timeout:8000 }); if (data?.prompt) return data.prompt; } catch {}
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
  if (/this (is )?my number|this number/.test(t) && ws._from) ws._slots.phone = normalizePhone(ws._from);
  const mPhone = text.match(/(?:\+?1[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/);
  if (mPhone) ws._slots.phone = normalizePhone(mPhone[0]);
  if (/\b(in[-\s]?person|at your office|meet in person)\b/.test(t)) ws._slots.meeting_type = "in-person";
  if (/\b(virtual|zoom|phone call|google meet|teams)\b/.test(t)) ws._slots.meeting_type = "virtual";
  const mAddr = text.match(/\b\d{2,5}\s+[A-Za-z0-9.\- ]{3,40}\b/);
  if (mAddr && !ws._slots.location && ws._slots.meeting_type === "in-person") ws._slots.location = mAddr[0];
  const mName = text.match(/\b(?:i[' ]?m|this is|my name is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (mName) ws._slots.name = mName[1].trim();
  if (/\b(buyer|buy a home|tour)\b/.test(t)) ws._slots.service = "buyer";
  if (/\b(seller|list my home|listing)\b/.test(t)) ws._slots.service = "seller";
  if (/\binvest(ing|or)?\b/.test(t)) ws._slots.service = "investor";
}
function scratchpadMessage(ws){
  const S = ws._slots;
  const lines = [
    "Scratchpad",
    `- Name: ${S.name||""}`,
    `- Phone: ${S.phone||""}`,
    `- Service: ${S.service||""}`,
    `- Meeting Type: ${S.meeting_type||""}`,
    `- Location: ${S.location||""}`,
    `- Notes: ${S.notes||""}`
  ].join("\n");
  return { role:"system", content: lines };
}

/* ===== ✅ RECEPTORX HELPER FUNCTIONS (NEW) ===== */

// Calculate duration in minutes from ISO timestamps
function calculateDuration(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  return Math.round((end - start) / 60000); // milliseconds to minutes
}

// Transform voice agent data to ReceptorX format
function transformToReceptorX(voiceData) {
  // Build notes only if we have actual data
  let notes = '';
  const parts = [];
  
  if (voiceData.meeting_type) parts.push(voiceData.meeting_type);
  if (voiceData.location) parts.push(voiceData.location);
  if (parts.length > 0) notes = parts.join(' - ');
  if (voiceData.notes) {
    notes = notes ? `${notes}: ${voiceData.notes}` : voiceData.notes;
  }
  
  return {
    customerName: voiceData.name,
    customerPhone: voiceData.phone,
    appointmentTime: voiceData.startISO,
    duration: calculateDuration(voiceData.startISO, voiceData.endISO),
    timezone: BIZ_TZ,
    propertyInterest: voiceData.service,
    notes: notes,
    source: "voice",
    userId: RECEPTORX_USER_ID
  };
}

/* ===== ✅ FIXED TOOLS FOR RECEPTORX ===== */
const Tools = {
  // Check calendar availability using your existing DASH_CAL_READ_URL
  async read_availability(args){
    if (!URLS.CAL_READ) {
      log("[ERROR] DASH_CAL_READ_URL not configured!");
      return { ok:false, error:"CAL_READ_URL_MISSING" };
    }
    
    try {
      const { startISO, endISO } = args || {};
      if (!startISO || !endISO) return { ok:false, error:"MISSING_TIME_WINDOW" };

      const payload = {
        startTime: startISO,
        endTime: endISO,
        userId: RECEPTORX_USER_ID
      };

      log("[TOOL][read_availability] Calling:", URLS.CAL_READ);
      log("[TOOL][read_availability] Payload:", JSON.stringify(payload));

      // POST to your existing read endpoint
      const { data } = await httpPost(URLS.CAL_READ, payload, { timeout:12000 });
      
      log("[TOOL][read_availability] ✅ Success:", JSON.stringify({ available: data.available, conflicts: data.conflicts?.length || 0 }));
      return { 
        ok: true, 
        available: data.available, 
        conflicts: data.conflicts || []
      };
    } catch(e){
      log("[TOOL][read_availability] ❌ FAILED");
      log("  URL:", URLS.CAL_READ);
      log("  Status:", e?.response?.status || "NO_RESPONSE");
      log("  Error:", e?.message);
      log("  Response data:", e?.response?.data);
      return { ok:false, status:e.response?.status||0, error:"READ_FAILED", message: e?.response?.data?.message || e?.message };
    }
  },

  // Book appointment using your existing DASH_CAL_CREATE_URL
  async book_appointment(args){
    if (!URLS.CAL_CREATE) return { ok:false, error:"CAL_CREATE_URL_MISSING" };
    try {
      const payload = transformToReceptorX(args);
      
      log("[TOOL][book_appointment] Calling:", URLS.CAL_CREATE);
      const { data } = await httpPost(URLS.CAL_CREATE, payload, { timeout:12000 });
      
      if (data.success) {
        log("[TOOL][book_appointment] ✅ Success:", JSON.stringify({ id: data.appointment?.id }));
        return { 
          ok: true, 
          appointmentId: data.appointment?.id,
          title: data.appointment?.title,
          startTime: data.appointment?.startTime,
          endTime: data.appointment?.endTime
        };
      } else {
        log("[TOOL][book_appointment] ⚠️ Conflict:", data.reason);
        return { 
          ok: false, 
          reason: data.reason, 
          alternatives: data.alternatives || []
        };
      }
    } catch(e){
      const status = e?.response?.status;
      const msg = e?.response?.data?.message || e?.message;
      log("[TOOL][book_appointment] ❌ Failed:", status, msg?.slice?.(0,160));
      return { ok:false, status: status||0, error:"CREATE_FAILED", message: msg };
    }
  },

  // Cancel appointment using your existing DASH_CAL_CANCEL_URL
  async cancel_appointment(args){
    if (!URLS.CAL_CANCEL) return { ok:false, error:"CAL_CANCEL_URL_MISSING" };
    try {
      const appointmentId = args.event_id;
      if (!appointmentId) return { ok:false, error:"MISSING_EVENT_ID" };

      const payload = { 
        appointmentId,
        userId: RECEPTORX_USER_ID
      };
      
      log("[TOOL][cancel_appointment] Calling:", URLS.CAL_CANCEL);
      const { data } = await httpPost(URLS.CAL_CANCEL, payload, { timeout:12000 });
      
      const ok = data?.ok || data?.cancelled;
      log("[TOOL][cancel_appointment]", ok ? "✅ Success" : "❌ Failed");
      return { 
        ok: !!ok, 
        cancelled: !!ok,
        appointmentId: appointmentId,
        title: data?.title || ""
      };
    } catch(e){
      log("[TOOL][cancel_appointment] ❌ Failed:", e?.response?.status, e?.response?.data?.message || e?.message);
      return { ok:false, status:e.response?.status||0, error:"DELETE_FAILED", message: e?.response?.data?.message || e?.message };
    }
  },

  // Find customer events (extracts base URL from your existing URLs)
  async find_customer_events(args){
    // Extract base URL from any of your existing URLs
    const baseUrl = URLS.CAL_READ.replace(/\/api\/calendar\/read$/, '') || 
                    URLS.CAL_CREATE.replace(/\/api\/calendar\/create$/, '');
    
    if (!baseUrl) return { ok:false, error:"NO_BASE_URL_FOUND", events:[] };
    
    try {
      const { name, phone, days = 30 } = args;
      
      // Calculate date range
      const now = new Date();
      const futureDate = new Date();
      futureDate.setDate(now.getDate() + days);

      const params = {
        userId: RECEPTORX_USER_ID,
        startTime: now.toISOString(),
        endTime: futureDate.toISOString()
      };

      const url = `${baseUrl}/api/appointments`;
      log("[TOOL][find_customer_events] Calling:", url);
      
      const { data } = await httpGet(url, { params, timeout:12000 });
      
      // Filter by customer name/phone
      let customerAppointments = Array.isArray(data) ? data : [];
      if (name || phone) {
        customerAppointments = customerAppointments.filter(apt => {
          const matchName = name && apt.title?.toLowerCase().includes(name.toLowerCase());
          const matchPhone = phone && (apt.notes?.includes(phone) || apt.title?.includes(phone));
          return matchName || matchPhone;
        });
      }

      // Transform to voice agent format with event_id
      const events = customerAppointments.map(apt => ({
        event_id: apt.id,
        title: apt.title,
        start: apt.startTime,
        end: apt.endTime,
        location: apt.location || ""
      }));

      log("[TOOL][find_customer_events] ✅ Success, found:", events.length);
      return { ok:true, events };
    } catch(e){
      log("[TOOL][find_customer_events] ❌ Failed:", e?.response?.status, e?.response?.data?.message || e?.message);
      return { ok:false, status:e.response?.status||0, error:"FIND_FAILED", events:[], message: e?.response?.data?.message || e?.message };
    }
  },

  // Upsert lead using your existing DASH_LEAD_UPSERT_URL
  async lead_upsert(args){
    if (!URLS.LEAD_UPSERT) return { ok:false, error:"LEAD_UPSERT_URL_MISSING" };
    try {
      const payload = {
        name: args.name,
        phone: args.phone,
        source: "voice",
        status: "new",
        notes: args.notes || args.intent || "",
        userId: RECEPTORX_USER_ID
      };

      log("[TOOL][lead_upsert] Calling:", URLS.LEAD_UPSERT);
      const { data } = await httpPost(URLS.LEAD_UPSERT, payload, { timeout:8000 });
      log("[TOOL][lead_upsert] ✅ Success");
      return { 
        ok:true, 
        leadId: data?.id,
        name: args.name,
        phone: args.phone
      };
    } catch(e){
      log("[TOOL][lead_upsert] ❌ Failed:", e?.response?.status, e?.response?.data?.message || e?.message);
      return { ok:false, status:e.response?.status||0, error:"LEAD_FAILED", message: e?.response?.data?.message || e?.message };
    }
  },

  // ✅ UNCHANGED: FAQ logging (keep as is or send to ReceptorX calls endpoint)
  async faq(args){
    try {
      if (URLS.FAQ_LOG) {
        await httpPost(URLS.FAQ_LOG, { biz:DASH_BIZ, source:DASH_SRC, ...args }, { timeout:8000 });
        log("[TOOL][faq] ok");
      }
    } catch(e){
      log("[TOOL][faq] fail:", e?.message);
    }
    return { ok:true };
  },

  // ✅ UNCHANGED: Transfer call (Twilio logic untouched)
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
        headers:{ "Content-Type":"application/x-www-form-urlencoded" },
        timeout:10000
      });
      log("[TOOL][transfer] ok");
      return { ok:true };
    } catch(e){
      log("[TOOL][transfer] fail:", e?.response?.status, e?.response?.data?.message || e?.message);
      return { ok:false, status:e.response?.status||0, error:"TRANSFER_FAILED", message: e?.response?.data?.message || e?.message };
    }
  },

  // ✅ UNCHANGED: End call (Twilio logic untouched)
  async end_call(args){
    const callSid = args.callSid || "";
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return { ok:false, error:"HANGUP_CONFIG_MISSING" };
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
    const params = new URLSearchParams({ Status:"completed" });
    try {
      await httpPost(url, params, {
        auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN },
        headers:{ "Content-Type":"application/x-www-form-urlencoded" },
        timeout:8000
      });
      log("[TOOL][end_call] ok");
      return { ok:true };
    } catch(e){
      log("[TOOL][end_call] fail:", e?.response?.status, e?.response?.data?.message || e?.message);
      return { ok:false, status:e.response?.status||0, error:"HANGUP_FAILED", message: e?.response?.data?.message || e?.message };
    }
  }
};

/* ===== ✅ UNCHANGED: Turn runner (LLM flow untouched) ===== */
async function runTurn(ws, baseMessages){
  if (ws._llmBusy) { ws._turnQueue = baseMessages; return; }
  ws._llmBusy = true;

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
        ws._mem.push({ role:"assistant", content:text });
      }

      messages = [...messages, assistantMsg];

      if (!calls?.length) {
        log("[LLM] no tool calls]");
        return;
      }

      const seenIds = new Set();
      for (const tc of calls){
        if (!tc?.id || seenIds.has(tc.id)) continue;
        seenIds.add(tc.id);

        const name = tc.function?.name || "";
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}

        if ((name === "transfer" || name === "end_call") && !args.callSid) args.callSid = ws._callSid || "";

        let windowKey = "";
        if (args?.startISO && args?.endISO) windowKey = `${args.startISO}|${args.endISO}`;

        if ((name === "read_availability" || name === "book_appointment") && windowKey){
          if (ws._windowFlights.has(windowKey) && name === "read_availability") {
            log("[DEDUP] skip read_availability", windowKey);
            messages.push({ role:"tool", tool_call_id: tc.id, content: JSON.stringify({ ok:true, deduped:true }) });
            messages.push({ role:"system",
              content:"Tool response received. Now, in THIS SAME TURN, say one short outcome line (≤12 words) and ask ONE next question. Do not mention tools or ISO strings." });
            continue;
          }
          ws._windowFlights.add(windowKey);
        }

        if (name === "book_appointment") {
          args.meeting_type = args.meeting_type ?? ws._slots.meeting_type ?? "";
          args.location     = args.location     ?? ws._slots.location ?? "";
          args.name  = args.name  ?? ws._slots.name  ?? "";
          args.phone = args.phone ?? ws._slots.phone ?? "";
          args.service = args.service ?? ws._slots.service ?? "";
        }

        log("[LLM→TOOL]", name, JSON.stringify(args).slice(0, 180));
        const impl = Tools[name];
        const result = impl ? await impl(args) : { ok:false, error:"TOOL_NOT_FOUND" };
        log("[TOOL→LLM]", name, result?.ok ? "ok" : "fail");

        if (name === "book_appointment" && result?.ok) ws._lastBooked = { startISO: args.startISO, endISO: args.endISO };

        messages.push({ role:"tool", tool_call_id: tc.id, content: JSON.stringify(result) });
        messages.push({ role:"system",
          content:"Tool response received. Now, in THIS SAME TURN, say one short outcome line (≤12 words) and ask ONE next question. Do not repeat the greeting. Do not mention tools or ISO strings." });
      }
    }
  } finally {
    ws._llmBusy = false;
    if (ws._turnQueue) { const q = ws._turnQueue; ws._turnQueue = null; runTurn(ws, q); }
  }
}

/* ===== ✅ UNCHANGED: Call loop (WebSocket/Twilio/Deepgram logic untouched) ===== */
wss.on("connection", (ws)=>{
  let dg = null;
  let pending = [];
  const BATCH = 6;
  let timer = null;

  ws._streamSid = "";
  ws._callSid = "";
  ws._from = "";
  ws._mem = [];
  ws._slots = { name:"", phone:"", service:"", meeting_type:"", location:"", notes:"" };
  ws._windowFlights = new Set();
  ws._llmBusy = false;
  ws._turnQueue = null;
  ws._lastBooked = null;

  ws.on("message", async raw=>{
    try {
      const msg = JSON.parse(raw.toString());
      const { event } = msg;

      if (event === "start"){
        ws._streamSid = msg.start?.streamSid || "";
        ws._callSid   = msg.start?.customParameters?.CallSid || msg.start?.customParameters?.callSid || "";
        ws._from      = msg.start?.customParameters?.from || "";
        log("[WS] start", ws._callSid, "from", ws._from);
        if (ws._from) ws._slots.phone = normalizePhone(ws._from);

        dg = newDeepgram(async text=>{
          log("[USER]", text);
          extractSlots(ws, text);
          ws._mem.push({ role:"user", content:text });
          clearTimeout(timer);
          timer = null;
          pending.push(text);
          if (pending.length >= BATCH){
            const p = pending.slice(); pending = [];
            const prompt = await getPrompt();
            const sys = systemMessages(prompt);
            const userMsgs = p.map(t=>({ role:"user", content:t }));
            runTurn(ws, [...sys, ...ws._mem.slice(-10), ...userMsgs]);
          } else {
            timer = setTimeout(async ()=>{
              const p = pending.slice(); pending = [];
              if (!p.length) return;
              const prompt = await getPrompt();
              const sys = systemMessages(prompt);
              const userMsgs = p.map(t=>({ role:"user", content:t }));
              runTurn(ws, [...sys, ...ws._mem.slice(-10), ...userMsgs]);
            }, 800);
          }
        });

        const prompt = await getPrompt();
        const sys = systemMessages(prompt);
        runTurn(ws, sys);
      }
      else if (event === "media" && dg?.readyState === WebSocket.OPEN){
        const chunk = Buffer.from(msg.media?.payload || "", "base64");
        dg.send(chunk);
      }
      else if (event === "stop"){
        log("[WS] stop", ws._callSid);
        if (dg) dg.close();
        ws.close();
      }
    } catch(e){
      log("[WS] parse error:", e?.message);
    }
  });

  ws.on("close", ()=>{
    log("[WS] closed", ws._callSid);
    if (dg) dg.close();
    clearTimeout(timer);
  });

  ws.on("error", e=> log("[WS] error:", e?.message));
});

log(`[READY] Voice agent with ReceptorX integration on port ${PORT}`);
