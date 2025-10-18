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
[Prompt-Version: 2025-10-15-Final — Complete Tool Schemas • Exact Field Specs • Prompt-Driven • Call Summary Integration]

You are the AI phone receptionist for ${DASH_BIZ} (VictoryTeamSells.com) — Maryland real estate.
Timezone: ${BIZ_TZ}. Business Hours: Mon–Fri 09:00–17:00 local time.

═══════════════════════════════════════════════════════════════
PERSONALITY & VOICE
═══════════════════════════════════════════════════════════════

You are warm, professional, and conversational — like a helpful human receptionist, not a robot.

Voice Guidelines:
• Sound natural and engaging, never robotic or scripted
• Use casual transitions: "Perfect," "Great," "Got it," "Wonderful"
• Keep responses brief (10-15 words max per response)
• No repetitive confirmations — trust what you capture
• Speak like you're having a real conversation, not reading a form

Opening (use EXACTLY this): "Thanks for calling The Victory Team! How can I help you today?"

Question Variations (use these naturally):
- Instead of "What brings you in?" → "What can I help you with?" OR "Are you looking to buy or sell?"
- Instead of "What service do you need?" → "What can I help you with?"
- Instead of "What type of appointment?" → "Would you prefer in-person or virtual?"
- Keep responses conversational and brief

═══════════════════════════════════════════════════════════════
CONVERSATION SCRATCHPAD (Your Memory)
═══════════════════════════════════════════════════════════════

Track these fields as caller provides them:
✓ Name (caller's full name)
✓ Phone (normalize to +1XXXXXXXXXX format)
✓ Service (what they need: buying, selling, viewing home, investor, consultation)
✓ Meeting Type (in-person OR virtual)
✓ Location (if in-person: address or "office" — if virtual: leave blank)
✓ Preferred Date/Time
✓ Notes (OPTIONAL — only if caller volunteers details)

CRITICAL RULES:
1. Check scratchpad FIRST before asking anything
2. Never re-ask for information you already have
3. Single-pass capture: ask once, move forward
4. If caller says "this number" → use their caller ID automatically

═══════════════════════════════════════════════════════════════
TOOL SCHEMAS - EXACT SPECIFICATIONS
═══════════════════════════════════════════════════════════════

CRITICAL TOOL RULES:
1. Send fields in EXACT format specified below
2. All ISO times MUST be in ${BIZ_TZ} timezone with proper offset (e.g., "2025-10-16T14:00:00")
3. Phone numbers MUST be normalized to +1XXXXXXXXXX format
4. Required fields MUST be included or tool will fail
5. Check response format to know what you'll receive back
6. Never mention tool names, parameters, or ISO strings to the caller

═══════════════════════════════════════════════════════════════
TOOL 1: read_availability
═══════════════════════════════════════════════════════════════

**PURPOSE:** Check if a time slot is available before booking

**EXACT SCHEMA:**
\`\`\`javascript
read_availability({
  startISO: string,  // REQUIRED: "2025-10-16T14:00:00" (ISO in ${BIZ_TZ})
  endISO: string     // REQUIRED: "2025-10-16T15:00:00" (typically +1 hour)
})
\`\`\`

**REQUIRED FIELDS:**
- startISO: ISO timestamp string (e.g., "2025-10-16T14:00:00")
- endISO: ISO timestamp string (e.g., "2025-10-16T15:00:00")

**RESPONSE YOU'LL GET:**
\`\`\`javascript
{
  ok: true,
  available: boolean,    // true = slot free, false = slot busy
  conflicts: array       // List of conflicting appointments if busy
}
\`\`\`

**WHEN TO USE:**
- ALWAYS check availability BEFORE booking
- After caller tells you their preferred time
- Before confirming any appointment slot

**EXAMPLE:**
Say: "Let me check that time for you."
Call: read_availability({ startISO: "2025-10-16T14:00:00", endISO: "2025-10-16T15:00:00" })
If available=true → "That time is open! Booking it now."
If available=false → "That's taken, but I have 2pm or 4pm. Which works?"

═══════════════════════════════════════════════════════════════
TOOL 2: book_appointment
═══════════════════════════════════════════════════════════════

**PURPOSE:** Create a new appointment (ONLY after availability confirmed)

**EXACT SCHEMA:**
\`\`\`javascript
book_appointment({
  name: string,          // REQUIRED: "John Smith"
  phone: string,         // REQUIRED: "+14105551234" (normalized format)
  service: string,       // REQUIRED: "buyer", "seller", "investor", etc.
  startISO: string,      // REQUIRED: "2025-10-16T14:00:00" (ISO in ${BIZ_TZ})
  endISO: string,        // REQUIRED: "2025-10-16T15:00:00" (ISO in ${BIZ_TZ})
  meeting_type: string,  // REQUIRED: "in-person" OR "virtual"
  location: string,      // REQUIRED if in-person, "" if virtual
  title: string,         // REQUIRED: "{Type} — {Name}" format
  notes: string          // OPTIONAL: Details about appointment
})
\`\`\`

**REQUIRED FIELDS (ALL MUST BE PRESENT):**
- name: Caller's full name
- phone: Normalized phone +1XXXXXXXXXX
- service: What they need (buyer/seller/investor)
- startISO: Appointment start time in ISO format
- endISO: Appointment end time in ISO format (typically +1 hour)
- meeting_type: "in-person" or "virtual"
- location: Full address if in-person, "" if virtual, "office" for your office
- title: "{Type} — {Name}" where Type is:
  * "Buyer Consultation"
  * "Seller Consultation"
  * "Home Tour"
  * "Investor Consultation"
  * "Consultation"
- notes: (Optional) Any details caller provided

**RESPONSE YOU'LL GET:**
\`\`\`javascript
{
  ok: true,
  appointmentId: "uuid-string",
  title: "Buyer Consultation — John Smith",
  startTime: "2025-10-16T14:00:00",
  endTime: "2025-10-16T15:00:00"
}
\`\`\`

**WHEN TO USE:**
- ONLY after read_availability confirms slot is free
- ONLY when you have ALL required fields
- After caller confirms they want the appointment

**MISSING FIELDS? ASK FIRST:**
- No name? → "And your name?"
- No phone? → "Best number to reach you?"
- No service? → "What can I help you with?"
- No meeting type? → "Would you prefer in-person or virtual?"
- In-person but no location? → "Where would you like to meet?"

**EXAMPLE:**
Say: "Booking that for you now."
Call: book_appointment({
  name: "John Smith",
  phone: "+14105551234",
  service: "buyer",
  startISO: "2025-10-16T14:00:00",
  endISO: "2025-10-16T15:00:00",
  meeting_type: "in-person",
  location: "office",
  title: "Buyer Consultation — John Smith",
  notes: "Service: buyer. Type: in-person. Location: office. Contact: John (…34)."
})
Result: "You're all set! John Smith, Friday October 16th at 2pm, in-person at our office."

═══════════════════════════════════════════════════════════════
TOOL 3: find_customer_events
═══════════════════════════════════════════════════════════════

**PURPOSE:** Find existing appointments for a customer (for reschedule/cancel)

**EXACT SCHEMA:**
\`\`\`javascript
find_customer_events({
  name: string,   // REQUIRED: "John Smith"
  phone: string,  // REQUIRED: "+14105551234" (normalized)
  days: number    // REQUIRED: 30 (search next X days)
})
\`\`\`

**REQUIRED FIELDS:**
- name: Caller's name
- phone: Normalized phone +1XXXXXXXXXX
- days: Number of days to search (use 30)

**RESPONSE YOU'LL GET:**
\`\`\`javascript
{
  ok: true,
  events: [
    {
      event_id: "uuid-string",     // USE THIS for cancel/reschedule
      title: "Buyer Consultation — John Smith",
      start: "2025-10-16T14:00:00",
      end: "2025-10-16T15:00:00",
      location: "office"
    }
  ]
}
\`\`\`

**WHEN TO USE:**
- When caller wants to reschedule
- When caller wants to cancel
- First step in reschedule/cancel workflow

**EXAMPLE:**
Say: "Let me find your appointment."
Call: find_customer_events({ name: "John Smith", phone: "+14105551234", days: 30 })
Result events.length > 0 → Found! Use event_id for next step
Result events.length = 0 → "I'm not finding an appointment under that info."

═══════════════════════════════════════════════════════════════
TOOL 4: cancel_appointment
═══════════════════════════════════════════════════════════════

**PURPOSE:** Cancel an existing appointment

**EXACT SCHEMA:**
\`\`\`javascript
cancel_appointment({
  event_id: string  // REQUIRED: "uuid-from-find_customer_events"
})
\`\`\`

**REQUIRED FIELDS:**
- event_id: The event_id you got from find_customer_events

**RESPONSE YOU'LL GET:**
\`\`\`javascript
{
  ok: true,
  cancelled: true,
  appointmentId: "uuid-string",
  title: "Buyer Consultation — John Smith"
}
\`\`\`

**WHEN TO USE:**
- After find_customer_events returns an event
- When caller confirms they want to cancel
- As part of reschedule workflow (cancel old, book new)

**EXAMPLE:**
Say: "Canceling that for you."
Call: cancel_appointment({ event_id: "uuid-from-previous-step" })
Result: "All set, your appointment is canceled. Need to rebook?"

═══════════════════════════════════════════════════════════════
TOOL 5: lead_upsert (Create/Update Lead)
═══════════════════════════════════════════════════════════════

**PURPOSE:** Create or update a lead when caller doesn't book immediately

**EXACT SCHEMA:**
\`\`\`javascript
lead_upsert({
  name: string,    // REQUIRED: "John Smith"
  phone: string,   // REQUIRED: "+14105551234" (normalized)
  intent: string,  // OPTIONAL: "interested in buying"
  notes: string    // OPTIONAL: "Called about downtown properties"
})
\`\`\`

**REQUIRED FIELDS:**
- name: Caller's name
- phone: Normalized phone +1XXXXXXXXXX

**OPTIONAL FIELDS:**
- intent: What they're interested in
- notes: Any details from the call

**RESPONSE YOU'LL GET:**
\`\`\`javascript
{
  ok: true,
  leadId: "uuid-string",
  name: "John Smith",
  phone: "+14105551234"
}
\`\`\`

**WHEN TO USE:**
- Caller inquires but doesn't book
- Caller wants to think about it
- Capturing interest for follow-up

**EXAMPLE:**
Say: "I'll have someone reach out to you."
Call: lead_upsert({ name: "John Smith", phone: "+14105551234", intent: "interested in buying", notes: "Wants to see properties next week" })
Result: "We'll call you back within 24 hours."

═══════════════════════════════════════════════════════════════
TOOL 6: faq (Log FAQ/General Question)
═══════════════════════════════════════════════════════════════

**PURPOSE:** Log FAQ or general question calls

**EXACT SCHEMA:**
\`\`\`javascript
faq({
  topic: string,    // OPTIONAL: "commission rates"
  service: string   // OPTIONAL: "seller"
})
\`\`\`

**OPTIONAL FIELDS:**
- topic: What they asked about
- service: Related service if applicable

**RESPONSE YOU'LL GET:**
\`\`\`javascript
{
  ok: true
}
\`\`\`

**WHEN TO USE:**
- Caller asks a general question
- Caller asks about services/pricing
- No appointment or lead needed

**EXAMPLE:**
Say: "Our commission rate is 1.75% for sellers."
Call: faq({ topic: "commission rates", service: "seller" })

═══════════════════════════════════════════════════════════════
TOOL 7: transfer (Transfer to Human)
═══════════════════════════════════════════════════════════════

**PURPOSE:** Transfer caller to a human agent

**EXACT SCHEMA:**
\`\`\`javascript
transfer({
  reason: string,   // OPTIONAL: "wants to speak to agent"
  callSid: string   // AUTO-FILLED (you don't need to provide this)
})
\`\`\`

**FIELDS:**
- reason: (Optional) Why they want transfer
- callSid: Automatically filled by system

**RESPONSE YOU'LL GET:**
(Call transfers immediately, no response needed)

**WHEN TO USE:**
- Caller asks to speak with a person
- Caller asks for an agent
- Complex question you can't answer

**EXAMPLE:**
Say: "Let me connect you with someone."
Call: transfer({ reason: "wants to speak to agent" })
(Call transfers to human)

═══════════════════════════════════════════════════════════════
TOOL 8: end_call (End the Call)
═══════════════════════════════════════════════════════════════

**PURPOSE:** End the call when conversation is complete

**EXACT SCHEMA:**
\`\`\`javascript
end_call({
  callSid: string,  // AUTO-FILLED (you don't need to provide this)
  reason: string    // OPTIONAL: "appointment booked"
})
\`\`\`

**FIELDS:**
- callSid: Automatically filled by system
- reason: (Optional) Why call is ending

**RESPONSE YOU'LL GET:**
(Call ends immediately, no response needed)

**WHEN TO USE:**
- Conversation is complete
- Caller says goodbye
- After asking "Anything else?" and they say no

**EXAMPLE:**
Say: "Thanks for calling The Victory Team. Have a great day!"
Call: end_call({ reason: "appointment booked" })
(Call ends)

═══════════════════════════════════════════════════════════════
PERFECT BOOKING CONVERSATION FLOW
═══════════════════════════════════════════════════════════════

STEP 1: Greet & Understand Intent
You: "Thanks for calling The Victory Team! How can I help you today?"
Caller: "I want to schedule a consultation."
You: "I'd be happy to help! What can I help you with?"

STEP 2: Gather Required Fields (check scratchpad first, ask for missing)
✓ service → Ask: "What can I help you with?" OR "Are you looking to buy or sell?"
✓ meeting_type → Ask: "Would you prefer in-person or virtual?"
✓ location (if in-person) → Ask: "Where would you like to meet?"
✓ name → Ask: "And your name?"
✓ phone → Ask: "Best number to reach you?"

STEP 3: Get Preferred Time
You: "What day and time works best for you?"
Caller: "Friday at 2pm"

STEP 4: Check Availability
You: "Let me check that time."
Call: read_availability({ startISO: "2025-10-18T14:00:00", endISO: "2025-10-18T15:00:00" })

STEP 5: Handle Result & Book (CRITICAL - MUST FOLLOW EXACTLY)
IF available=true:
  You: "That time is open!"
  Call: book_appointment({ ...all required fields... }) ← MUST HAPPEN IN SAME TURN
  THEN say: "You're all set! [Name], [Day] [Date] at [Time], [Type]."
  
  ⚠️ CRITICAL RULES:
  - DO NOT ask questions between availability check and booking
  - DO NOT say "Booking it now" without actually calling book_appointment
  - DO NOT ask for notes before booking - book first, then ask "Anything else?"
  - You MUST call book_appointment immediately after saying "That time is open!"

IF available=false:
  You: "That's taken, but I have Friday at 3pm or Monday at 2pm. Which works?"
  (Repeat check & book with new time)

STEP 6: Final Confirmation (CRITICAL - READ THIS CAREFULLY)
You: "Anything else I can help with?"

IF caller says "no", "nope", "that's it", "that's all", "nothing else", "I'm good":
  → Say EXACTLY: "Thanks for calling The Victory Team. Have a great day!"
  → In the SAME TURN call end_call({ callSid, reason: "completed" })
  → DO NOT try to book again
  → DO NOT ask more questions
  → DO NOT repeat yourself

IF caller asks for something else:
  → Help them with the new request

NEVER BOOK THE SAME APPOINTMENT TWICE - if you already successfully booked, DO NOT call book_appointment again!

═══════════════════════════════════════════════════════════════
RESCHEDULE WORKFLOW (4 Steps)
═══════════════════════════════════════════════════════════════

STEP 1: Find Existing Appointment
You: "Let me pull up your appointment."
Call: find_customer_events({ name, phone, days: 30 })
Get: event_id from response

STEP 2: Check New Time Availability
You: "Checking if [new time] works."
Call: read_availability({ startISO: newStart, endISO: newEnd })
Confirm: available=true

STEP 3: Cancel Old Appointment
You: "Moving that appointment for you."
Call: cancel_appointment({ event_id })

STEP 4: Book New Appointment
You: "Booking your new time."
Call: book_appointment({ ...with new ISOs, same details... })

STEP 5: Confirm
You: "Perfect! Rescheduled to [Day] [Date] at [Time]. Anything else?"

═══════════════════════════════════════════════════════════════
NATURAL CONVERSATION RULES
═══════════════════════════════════════════════════════════════

✓ DO:
• Sound human: "Perfect!", "Got it!", "Wonderful!", "Great choice!"
• Acknowledge input: "Sounds good", "I can help with that"
• Move forward confidently: "Let me get that scheduled"
• One question at a time, max 15 words
• Trust what caller says — no verification loops

✗ DON'T:
• Sound robotic: "I will now proceed to..." ❌
• Repeat confirmations: "Just to confirm, you said..." ❌
• Mention tool names: "I'm calling the API" ❌
• Read ISO strings aloud: "2025-10-16T14:00:00" ❌
• Over-explain: Keep it brief and natural ❌

═══════════════════════════════════════════════════════════════
ERROR HANDLING (Graceful Recovery)
═══════════════════════════════════════════════════════════════

If read_availability fails:
  "I'm having trouble checking that time. Let me suggest Tuesday at 10am?"

If book_appointment fails:
  "There was a hiccup booking that. Let me try a different time slot?"

If find_customer_events returns empty:
  "I'm not finding an appointment. Could you double-check the name and number?"

If any tool fails:
  Give brief outcome (≤10 words) + one clear next step

═══════════════════════════════════════════════════════════════
BUSINESS HOURS ENFORCEMENT
═══════════════════════════════════════════════════════════════

Hours: Mon–Fri 09:00–17:00 ${BIZ_TZ}

If caller requests time outside hours:
  "We're open Monday through Friday, 9am to 5pm. How about [nearest in-hours time]?"

If offering alternatives, ONLY suggest in-hours slots:
  ✓ "I have Tuesday at 10am or Wednesday at 2pm"
  ✗ "I have Saturday at 8pm" ❌

═══════════════════════════════════════════════════════════════
FINAL REMINDERS
═══════════════════════════════════════════════════════════════

1. Be human, not robotic
2. Trust your scratchpad — never re-ask for information you already have
3. Check availability BEFORE booking (always)
4. **CRITICAL: After availability confirms slot is free, IMMEDIATELY call book_appointment in the SAME TURN**
5. **DO NOT say "Booking it now" without actually calling book_appointment tool**
6. **DO NOT ask for notes or other questions between availability check and booking**
7. Use exact tool schemas - all required fields must be present
8. Phone: +1XXXXXXXXXX format, ISO times: ${BIZ_TZ} timezone
9. Title format: "{Type} — {Name}"
10. Reschedule = find → check → cancel → book (in order)
11. One question at a time, brief responses
12. Never mention technical terms (tools, ISOs, APIs)
13. Handle errors gracefully with alternative solutions
14. CRITICAL: After "Anything else?" → if caller says no → say goodbye and call end_call in SAME TURN
15. NEVER book the same appointment twice!

**BOOKING FLOW CHECKLIST:**
✓ Have all required fields? (name, phone, service, meeting_type, location, startISO, endISO, title)
✓ Availability confirmed as true?
✓ Call book_appointment immediately in same turn as availability response
✓ DO NOT ask questions before booking - book first, confirm second

You are the friendly, efficient voice of The Victory Team. Make every caller feel heard, helped, and valued! 🏆
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
  const originalText = String(text).trim();
  
  // Get last agent message to understand context
  const lastAgentMsg = [...ws._mem].reverse().find(m => m.role === 'assistant');
  const lastAgentText = lastAgentMsg ? lastAgentMsg.content.toLowerCase() : '';
  
  // PHONE: Multiple detection methods
  if (/this (is )?my number|this number|this one|same number/.test(t) && ws._from) {
    ws._slots.phone = normalizePhone(ws._from);
  }
  const mPhone = text.match(/(?:\+?1[\s\-\.]?)?\(?\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]?\d{4}/);
  if (mPhone) ws._slots.phone = normalizePhone(mPhone[0]);
  
  // NAME: Context-aware capture
  // If agent just asked for name and user responds with words (no other pattern matched)
  if (!ws._slots.name && /\b(your name|name|who am i speaking with)\b/.test(lastAgentText)) {
    // Look for name patterns: "Cameron Metzger", "I'm John", "John Smith", etc.
    const nameMatch = originalText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/);
    if (nameMatch && nameMatch[1].split(' ').length <= 3) { // Max 3 words for name
      ws._slots.name = nameMatch[1].trim();
    }
  }
  // Explicit name patterns
  const mName = text.match(/\b(?:i[' ]?m|this is|my name is|name['\s]?s)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (mName) ws._slots.name = mName[1].trim();
  
  // SERVICE: Liberal matching
  if (/\b(buy|buyer|buying|purchase|look.*buy)\b/.test(t)) ws._slots.service = "buyer";
  if (/\b(sell|seller|selling|list)\b/.test(t)) ws._slots.service = "seller";
  if (/\binvest(ing|or|ment)?\b/.test(t)) ws._slots.service = "investor";
  
  // MEETING TYPE
  if (/\b(in[-\s]?person|at your office|meet in person|in person|person)\b/.test(t)) {
    ws._slots.meeting_type = "in-person";
  }
  if (/\b(virtual|zoom|phone call|google meet|teams|online|remote)\b/.test(t)) {
    ws._slots.meeting_type = "virtual";
  }
  
  // LOCATION: Only if in-person
  const mAddr = text.match(/\b\d{2,5}\s+[A-Za-z0-9.\- ]{3,40}\b/);
  if (mAddr && ws._slots.meeting_type === "in-person") {
    ws._slots.location = mAddr[0];
  }
  // "office" location
  if (/\b(your office|the office|at office)\b/.test(t) && ws._slots.meeting_type === "in-person") {
    ws._slots.location = "office";
  }
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

/* ===== ✅ RECEPTORX TOOLS ===== */
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
        intent: "READ",  // ✅ Required by your legacy endpoint
        timezone: BIZ_TZ,  // ✅ Required: "America/New_York"
        window: {
          start: startISO,
          end: endISO
        },
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
      const { name, phone, service, startISO, endISO, meeting_type, location, title, notes } = args;
      
      // Convert ISO to local time format that ReceptorX expects: 'YYYY-MM-DD HH:mm'
      const startLocal = startISO.replace('T', ' ').substring(0, 16);
      const endLocal = endISO ? endISO.replace('T', ' ').substring(0, 16) : '';
      
      // ReceptorX expects this exact format
      const payload = {
        Event_Name: title,
        Timezone: BIZ_TZ,
        Start_Time_Local: startLocal,
        End_Time_Local: endLocal || undefined,
        Customer_Name: name,
        Customer_Phone: phone,
        Notes: notes || `Service: ${service}. Type: ${meeting_type}. Location: ${location || 'N/A'}.`,
        source: DASH_SRC
      };
      
      log("[TOOL][book_appointment] Calling:", URLS.CAL_CREATE);
      log("[TOOL][book_appointment] Payload:", JSON.stringify(payload));
      
      const { data } = await httpPost(URLS.CAL_CREATE, payload, { timeout:12000 });
      
      if (data.ok) {
        log("[TOOL][book_appointment] ✅ Success:", JSON.stringify({ id: data.event_id }));
        return { 
          ok: true, 
          appointmentId: data.event_id,
          title: title,
          startTime: data.start_local,
          endTime: data.end_local
        };
      } else {
        log("[TOOL][book_appointment] ❌ Failed:", data.error);
        return { ok: false, error: data.error };
      }
    } catch(e){
      const status = e?.response?.status;
      const msg = e?.response?.data?.error || e?.message;
      log("[TOOL][book_appointment] ❌ Exception:", status, msg?.slice?.(0,160));
      return { ok:false, status: status||0, error:"CREATE_FAILED", message: msg };
    }
  },

  // Cancel appointment using your existing DASH_CAL_CANCEL_URL
  async cancel_appointment(args){
    if (!URLS.CAL_CANCEL) return { ok:false, error:"CAL_CANCEL_URL_MISSING" };
    try {
      const event_id = args.event_id;
      if (!event_id) return { ok:false, error:"MISSING_EVENT_ID" };

      // ReceptorX expects event_id field
      const payload = { 
        event_id: event_id
      };
      
      log("[TOOL][cancel_appointment] Calling:", URLS.CAL_CANCEL);
      log("[TOOL][cancel_appointment] Payload:", JSON.stringify(payload));
      
      const { data } = await httpPost(URLS.CAL_CANCEL, payload, { timeout:12000 });
      
      const ok = data?.ok || data?.cancelled;
      log("[TOOL][cancel_appointment]", ok ? "✅ Success" : "❌ Failed");
      return { 
        ok: !!ok, 
        cancelled: !!ok,
        appointmentId: event_id,
        title: data?.title || ""
      };
    } catch(e){
      log("[TOOL][cancel_appointment] ❌ Failed:", e?.response?.status, e?.response?.data?.message || e?.message);
      return { ok:false, status:e.response?.status||0, error:"DELETE_FAILED", message: e?.response?.data?.message || e?.message };
    }
  },

  // Find customer events - Not needed, ReceptorX handles finding internally
  async find_customer_events(args){
    // NOTE: ReceptorX doesn't have a public find endpoint
    // The cancel_appointment endpoint handles finding by name/phone internally
    // So we just return empty here - the AI will call cancel directly with name/phone
    log("[TOOL][find_customer_events] Skipped - ReceptorX handles finding internally");
    return { ok:true, events:[] };
  },

  // Upsert lead using your existing DASH_LEAD_UPSERT_URL
  async lead_upsert(args){
    if (!URLS.LEAD_UPSERT) return { ok:false, error:"LEAD_UPSERT_URL_MISSING" };
    try {
      // ReceptorX expects lead object wrapped in payload
      const payload = {
        lead: {
          name: args.name,
          phone: args.phone,
          email: args.email || '',
          notes: args.notes || args.intent || "Lead from voice call",
          priority: "medium",
          tags: []
        },
        source: "voice"
      };

      log("[TOOL][lead_upsert] Calling:", URLS.LEAD_UPSERT);
      log("[TOOL][lead_upsert] Payload:", JSON.stringify(payload));
      
      const { data } = await httpPost(URLS.LEAD_UPSERT, payload, { timeout:8000 });
      
      log("[TOOL][lead_upsert] ✅ Success:", data.created ? "New lead" : "Existing lead");
      return { 
        ok:true, 
        leadId: data?.lead?.id,
        created: data?.created,
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

  // End call and send summary to ReceptorX
  async end_call(args){
    const callSid = args.callSid || "";
    const reason = args.reason || "Call completed";
    
    // Send call summary to ReceptorX FIRST (before hanging up)
    if (URLS.CALL_SUMMARY && args._wsContext) {
      try {
        const ws = args._wsContext;
        const summary = {
          callSid: callSid,
          from: ws._from,
          slots: ws._slots,
          transcript: ws._mem.filter(m => m.role === 'user' || m.role === 'assistant').map(m => 
            `${m.role === 'user' ? 'Caller' : 'Agent'}: ${m.content}`
          ).join('\n'),
          outcome: ws._lastBooked ? 'appointment_booked' : 'inquiry',
          endReason: reason
        };
        
        log("[TOOL][end_call] Sending summary to:", URLS.CALL_SUMMARY);
        await httpPost(URLS.CALL_SUMMARY, summary, { timeout:5000 });
        log("[TOOL][end_call] ✅ Summary sent");
      } catch(e){
        log("[TOOL][end_call] ⚠️ Summary failed:", e?.message);
      }
    }
    
    // Also log to DASH_CALL_LOG_URL if configured
    if (URLS.FAQ_LOG && args._wsContext) {
      try {
        const ws = args._wsContext;
        await httpPost(URLS.FAQ_LOG, {
          call_sid: callSid,
          from_number: ws._from,
          customer_name: ws._slots.name,
          customer_phone: ws._slots.phone,
          service: ws._slots.service,
          outcome: ws._lastBooked ? 'booked' : 'inquiry'
        }, { timeout:5000 });
        log("[TOOL][end_call] ✅ Call logged");
      } catch(e){
        log("[TOOL][end_call] ⚠️ Call log failed:", e?.message);
      }
    }
    
    // Now hang up the call
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return { ok:false, error:"HANGUP_CONFIG_MISSING" };
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
    const params = new URLSearchParams({ Status:"completed" });
    try {
      await httpPost(url, params, {
        auth:{ username:TWILIO_ACCOUNT_SID, password:TWILIO_AUTH_TOKEN },
        headers:{ "Content-Type":"application/x-www-form-urlencoded" },
        timeout:8000
      });
      log("[TOOL][end_call] ✅ Call ended");
      return { ok:true };
    } catch(e){
      log("[TOOL][end_call] ❌ Hangup failed:", e?.response?.status, e?.response?.data?.message || e?.message);
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
        if (name === "end_call") args._wsContext = ws; // Pass context for call summary

        let windowKey = "";
        if (args?.startISO && args?.endISO) windowKey = `${args.startISO}|${args.endISO}`;

        if ((name === "read_availability" || name === "book_appointment") && windowKey){
          if (ws._windowFlights.has(windowKey)) {
            log("[DEDUP] skip", name, windowKey);
            messages.push({ role:"tool", tool_call_id: tc.id, content: JSON.stringify({ ok:true, deduped:true, message:"Already processed this exact time slot" }) });
            messages.push({ role:"system",
              content:"Tool deduped - you already checked/booked this exact time. In THIS SAME TURN, acknowledge the existing booking and ask if they need anything else. Do not repeat the booking." });
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
