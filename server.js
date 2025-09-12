// server.js — Old Line Barbershop AI Receptionist (Deepgram + GPT + ElevenLabs + Make.com)
// Minimal, safe edits: confirm-before-ask, CTA→BOOK override, clarifications with transfer,
// lastPrompt tracking, and cleaner resume logic. No new deps.

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const PORT = process.env.PORT || 5000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL;
const MAKE_FAQ_URL = process.env.MAKE_FAQ_URL;

if (!OPENAI_API_KEY) console.warn("(!) OPENAI_API_KEY missing");
if (!DEEPGRAM_API_KEY) console.warn("(!) DEEPGRAM_API_KEY missing");
if (!ELEVENLABS_API_KEY) console.warn("(!) ELEVENLABS_API_KEY missing");

const app = express();
app.use(bodyParser.json());
app.get("/", (_, res) => res.status(200).send("✅ Old Line Barbershop AI Receptionist running"));
app.post("/twiml", (_, res) => {
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME || "localhost:"+PORT}"/>
      </Connect>
    </Response>
  `);
});
const server = app.listen(PORT, () => console.log(`[INFO] Server running on ${PORT}`));

const wss = new WebSocketServer({ server });

// ---------- Utilities ----------
const nowNY = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};
function addDaysISO(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function normalizeDate(d) {
  if (!d) return "";
  const t = String(d).toLowerCase();
  if (t === "today") return nowNY();
  if (t === "tomorrow") return addDaysISO(nowNY(), 1);
  return d; // leave as-is (GPT often resolves weekdays to YYYY-MM-DD)
}
function normalizeService(s) {
  if (!s) return "";
  const t = s.toLowerCase();
  if (/\b(combo|both|haircut\s*(?:\+|and|&)\s*beard)\b/.test(t)) return "combo";
  if (/\bbeard/.test(t)) return "beard trim";
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return "haircut";
  return "";
}
function normalizePhone(num) {
  if (!num) return "";
  const d = num.replace(/\D/g, "");
  return d.length >= 10 ? d : "";
}
function monthName(i){return ["January","February","March","April","May","June","July","August","September","October","November","December"][i]||"";}
function ordinal(n){const s=["th","st","nd","rd"],v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);}
function toHumanDate(dateISO, timeText) {
  // dateISO: "YYYY-MM-DD" (preferred) or anything Date can parse
  try {
    const d = new Date(dateISO);
    if (!isNaN(d)) {
      const m = monthName(d.getMonth());
      const day = ordinal(d.getDate());
      // timeText normalization to 12h
      let t = (timeText || "").trim();
      if (/^\d{1,2}:\d{2}$/.test(t)) {
        // "15:00" -> "3:00 PM"
        const [hh, mm] = t.split(":").map(x=>parseInt(x,10));
        const ampm = hh>=12 ? "PM" : "AM";
        const hr = ((hh+11)%12)+1;
        t = `${hr}:${String(mm).padStart(2,"0")} ${ampm}`;
      } else if (/^\d{1,2}\s*(am|pm)$/i.test(t)) {
        t = t.replace(/\s*/,' ').toUpperCase();
      } else if (/^\d{1,2}\s*pm$/i.test(t) || /^\d{1,2}\s*am$/i.test(t)) {
        t = t.toUpperCase();
      }
      return `${m} ${day} at ${t || "the selected time"}`;
    }
  } catch {}
  return `${dateISO} at ${timeText || ""}`.trim();
}

// ---------- Deepgram WS ----------
function startDeepgram({ onFinal }) {
  const url =
    "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16"
    + "&sample_rate=8000"
    + "&channels=1"
    + "&model=nova-2-phonecall"
    + "&interim_results=true"
    + "&smart_format=true"
    + "&language=en-US"
    + "&endpointing=250";

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });

  dg.on("open", () => console.log("[Deepgram] ws open"));
  dg.on("message", (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || "").trim();
    if (!text) return;
    if (ev.is_final || ev.speech_final) {
      console.log(JSON.stringify({ event: "ASR_FINAL", transcript: text }));
      onFinal?.(text);
    }
  });
  dg.on("error", (e) => console.error("[Deepgram error]", e.message));
  dg.on("close", () => console.log("[Deepgram closed]"));

  return {
    sendPCM16LE(buf) { try { dg.send(buf); } catch {} },
    close() { try { dg.close(); } catch {} }
  };
}

// μ-law decode
function ulawByteToPcm16(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << (exponent + 2)) - 0x84 * 4;
  if (sign) sample = -sample;
  return Math.max(-32768, Math.min(32767, sample));
}
function ulawBufferToPCM16LEBuffer(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    const s = ulawByteToPcm16(ulawBuf[i]);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

// ---------- GPT ----------
async function askGPT(systemPrompt, userPrompt, response_format = "text") {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(response_format === "json" ? { response_format: { type: "json_object" } } : {}),
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return resp.data.choices[0].message.content.trim();
  } catch (e) {
    console.error("[GPT ERROR]", e.message);
    return "";
  }
}

// ---------- TTS ----------
async function say(ws, text, tag = "") {
  if (!text) return;
  const streamSid = ws.__streamSid;
  if (!streamSid) return;

  console.log(JSON.stringify({ event: "BOT_SAY", reply: text }));
  // Track lastPrompt tag for flow control
  if (ws.__state) ws.__state.lastPrompt = tag || ws.__state.lastPrompt || "";

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn("[WARN] No ElevenLabs credentials, skipping TTS");
    return;
  }

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await axios.post(
      url,
      { text, voice_settings: { stability: 0.4, similarity_boost: 0.8 } },
      { headers: { "xi-api-key": ELEVENLABS_API_KEY }, responseType: "stream" }
    );
    resp.data.on("data", (chunk) => {
      const b64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
    });
    resp.data.on("end", () =>
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }))
    );
  } catch (e) {
    console.error("[TTS ERROR]", e.message);
  }
}

// ---------- Slot state helpers ----------
function newState() {
  return {
    phase: "idle",                 // 'idle' | 'booking' | 'booked'
    lastPrompt: "",                // tracks last bot question/cta
    clarify: { slot: "", count: 0 }, // smart clarification per slot
    slots: { service: "", date: "", time: "", name: "", phone: "" }
  };
}
function mergeSlots(state, parsed) {
  const before = { ...state.slots };
  const updated = [];

  if (parsed.service) {
    const svc = normalizeService(parsed.service);
    if (svc && svc !== state.slots.service) { state.slots.service = svc; updated.push("service"); }
  }
  if (parsed.date) {
    const nd = normalizeDate(parsed.date);
    if (nd && nd !== state.slots.date) { state.slots.date = nd; updated.push("date"); }
  }
  if (parsed.time) {
    if (parsed.time !== state.slots.time) { state.slots.time = parsed.time; updated.push("time"); }
  }
  if (parsed.name) {
    if (parsed.name !== state.slots.name) { state.slots.name = parsed.name; updated.push("name"); }
  }
  if (parsed.phone) {
    const ph = normalizePhone(parsed.phone);
    if (ph && ph !== state.slots.phone) { state.slots.phone = ph; updated.push("phone"); }
  }

  if (updated.length) {
    console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
    // reset clarification if the asked slot just got filled
    if (state.clarify.slot && updated.includes(state.clarify.slot)) {
      state.clarify = { slot: "", count: 0 };
    }
  }
  return updated;
}
function nextMissing(state) {
  if (!state.slots.service) return "service";
  if (!state.slots.date || !state.slots.time) return "datetime";
  if (!state.slots.name) return "name";
  if (!state.slots.phone) return "phone";
  return "done";
}
async function askForMissing(ws, state) {
  const missing = nextMissing(state);
  console.log(JSON.stringify({ event: "SLOTS", slots: state.slots, missing }));
  if (missing === "service") {
    state.clarify = { slot: "service", count: 0 };
    return say(ws, "Okay—let’s get you booked. What service would you like — a haircut, beard trim, or the combo?", "ask_service");
  }
  if (missing === "datetime") {
    state.clarify = { slot: "datetime", count: 0 };
    const svc = state.slots.service || "appointment";
    return say(ws, `What date and time would you like for your ${svc}?`, "ask_datetime");
  }
  if (missing === "name") {
    state.clarify = { slot: "name", count: 0 };
    return say(ws, "Can I get your first name?", "ask_name");
  }
  if (missing === "phone") {
    state.clarify = { slot: "phone", count: 0 };
    return say(ws, "What phone number should I use for confirmations?", "ask_phone");
  }
  if (missing === "done") {
    return finalizeBooking(ws, state);
  }
}
async function maybeResume(ws, state) {
  if (state.phase === "booking") {
    const missing = nextMissing(state);
    if (missing !== "done") {
      await askForMissing(ws, state);
      return true;
    }
  }
  return false;
}
async function clarifyOrEscalate(ws, state, parsed, updatedThisTurn) {
  const missing = nextMissing(state);
  // Only clarify when we just asked for this slot and it still isn't filled
  if (!state.clarify.slot || missing !== state.clarify.slot) return false;

  // If we actually filled it this turn, no clarify
  if (updatedThisTurn.includes(state.clarify.slot)) return false;

  state.clarify.count += 1;
  console.log(JSON.stringify({ event: "CLARIFY", slot: state.clarify.slot, count: state.clarify.count }));

  if (state.clarify.count >= 3) {
    console.log(JSON.stringify({ event: "FAILSAFE_TRANSFER", slot: state.clarify.slot }));
    await say(ws, "Let me transfer you to the owner to finish this up.", "transfer");
    try { ws.close(); } catch {}
    return true;
  }

  // Vary the clarifying prompt
  const slot = state.clarify.slot;
  const lines = {
    service: [
      "Sorry—was that a haircut, beard trim, or the combo?",
      "Just to confirm, which service would you like: haircut, beard trim, or combo?"
    ],
    datetime: [
      "Got it—what date and time should I put you down for?",
      "Which day and time works best for you?"
    ],
    name: [
      "Sorry—what’s your first name?",
      "Just your first name is fine."
    ],
    phone: [
      "Could you share the phone number to confirm your booking?",
      "What’s the best number to text the confirmation to?"
    ]
  };
  const opts = lines[slot] || ["Could you please clarify that?"];
  const line = opts[state.clarify.count % opts.length];
  await say(ws, line, `clarify_${slot}`);
  return true;
}

async function finalizeBooking(ws, state) {
  // Say confirmation in natural format
  const when = toHumanDate(state.slots.date, state.slots.time);
  console.log(JSON.stringify({ event: "CONFIRM_READY", slots: state.slots, whenSpoken: when }));
  await say(ws,
    `Great — I’ve booked a ${state.slots.service} for ${state.slots.name} on ${when}. I have your number as ${formatPhoneForSpeech(state.slots.phone)}. You’re all set. Anything else I can help with?`,
    "confirmed"
  );

  // Optional: send to Make.com (non-blocking)
  try {
    if (MAKE_CREATE_URL) {
      const startISO = toISODateTime(state.slots.date, state.slots.time);
      const endISO = addMinutesISO(startISO, 30);
      await axios.post(MAKE_CREATE_URL, {
        Event_Name: state.slots.service || "Appointment",
        Start_Time: startISO,
        End_Time: endISO,
        Customer_Name: state.slots.name || "",
        Customer_Phone: state.slots.phone || "",
        Customer_Email: "",
        Notes: "Booked by phone agent."
      }, { timeout: 4000 });
    }
  } catch (e) {
    console.error("[Make CREATE] error", e.message);
    // Silent fail; voice confirmation already sent. Fallback would be owner transfer if you want.
  }

  state.phase = "booked";
  state.lastPrompt = "confirmed";
  state.clarify = { slot: "", count: 0 };
}
function toISODateTime(dateText, timeText) {
  // Accept "YYYY-MM-DD" (preferred) and "3 PM"/"15:00"
  // Produce ISO with no timezone assumption; for Make it’s fine.
  if (!dateText) return "";
  let t = (timeText || "09:00").trim();
  if (/^\d{1,2}\s*(AM|PM)$/i.test(t)) {
    const m = t.match(/^\s*(\d{1,2})\s*(AM|PM)\s*$/i);
    let h = parseInt(m[1],10);
    const ap = m[2].toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    t = `${String(h).padStart(2,"0")}:00`;
  }
  if (/^\d{1,2}$/.test(t)) t = `${t}:00`;
  if (/^\d{1,2}:\d{2}$/.test(t)) t = `${t}:00`;
  return `${dateText}T${t}`;
}
function addMinutesISO(iso, mins) {
  try {
    const d = new Date(iso);
    if (!isNaN(d)) {
      d.setMinutes(d.getMinutes()+mins);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,"0");
      const dd = String(d.getDate()).padStart(2,"0");
      const HH = String(d.getHours()).padStart(2,"0");
      const MM = String(d.getMinutes()).padStart(2,"0");
      const SS = String(d.getSeconds()).padStart(2,"0");
      return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}`;
    }
  } catch {}
  return iso;
}
function formatPhoneForSpeech(p) {
  if (!p) return "";
  const d = p.replace(/\D/g,"");
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}

// ---------- Classify + handle ----------
async function classifyAndHandle(ws, state, transcript) {
  // CTA→BOOK override: if last was booking CTA and user said yes/ok
  const YES_RX = /\b(yes|yeah|yep|yup|sure|okay|ok|please|let'?s|lets)\b/i;
  const NO_RX  = /\b(no|nah|nope|not now|maybe later)\b/i;

  const systemPrompt = `
Return STRICT JSON:
{
 "intent": "FAQ" | "BOOK" | "TRANSFER" | "SMALLTALK" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",
 "date": "",
 "time": "",
 "name": "",
 "phone": ""
}

Rules:
- Detect booking even if mixed with small talk.
- If caller changes service later, update "service".
- For FAQs, do NOT start booking unless they ask to book.
- Keep values short; leave blank if unsure.
  `.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  // Context override from CTA
  if (state.lastPrompt === "cta_booking") {
    if (YES_RX.test(transcript)) parsed.intent = "BOOK";
    else if (NO_RX.test(transcript)) {
      await say(ws, "No problem. Anything else I can help with?", "idle");
      state.phase = "idle";
      state.lastPrompt = "idle";
      return;
    }
  }

  // Merge slots
  const updatedThisTurn = mergeSlots(state, parsed);

  // If already booked and user corrects a slot → re-confirm
  if (state.phase === "booked" && updatedThisTurn.length) {
    const when = toHumanDate(state.slots.date, state.slots.time);
    await say(ws, `All set — I’ve updated that. Now it’s ${state.slots.service} for ${state.slots.name} on ${when}, confirmation to ${formatPhoneForSpeech(state.slots.phone)}. Anything else?`, "confirmed");
    return;
  }

  // Branches
  if (parsed.intent === "FAQ") {
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    if (!answer) answer = "Happy to help. What else can I answer?";

    if (state.phase === "booking") {
      // Answer then resume booking
      await say(ws, answer, "faq_answer");
      await maybeResume(ws, state);
    } else {
      // Answer with CTA; track that CTA explicitly
      await say(ws, `${answer} Would you like to book an appointment?`, "cta_booking");
    }
    return;
  }

  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.", "transfer");
    try { ws.close(); } catch {}
    return;
  }

  if (parsed.intent === "BOOK") {
    state.phase = "booking";
    // Ask next missing (service prompt includes confirm-before-ask)
    const clarified = await clarifyOrEscalate(ws, state, parsed, updatedThisTurn);
    if (!clarified) await askForMissing(ws, state);
    return;
  }

  // Smalltalk / Unknown
  const fallbackPrompt = `
You are a friendly receptionist at Old Line Barbershop.
Reply with ONE short, conversational sentence (<= 18 words).
Don't explain yourself. Keep it helpful and human.
Examples: "Sure—what do you need?" / "Got it—how can I help?" / "No problem—what's up?"
  `.trim();
  const nlg = await askGPT(fallbackPrompt, transcript);
  await say(ws, nlg || "Okay—how can I help?", "chit");
  // If we were in booking, resume
  await maybeResume(ws, state);

  // If we just asked for a slot and still didn’t get it, clarify
  await clarifyOrEscalate(ws, state, parsed, updatedThisTurn);
}

// ---------- WS ----------
wss.on("connection", (ws) => {
  let dg = null;
  let pendingULaw = [];
  const BATCH_FRAMES = 5;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      ws.__convoId = uuidv4();
      ws.__state = newState();
      console.log(JSON.stringify({ event: "CALL_START", streamSid: ws.__streamSid, convoId: ws.__convoId }));

      // Start Deepgram
      dg = startDeepgram({
        onFinal: async (text) => {
          try { await classifyAndHandle(ws, ws.__state, text); } catch (e) { console.error("[handle error]", e.message); }
        }
      });

      await say(ws, "Hi, thanks for calling Old Line Barbershop. How can I help you today?", "greet");
      return;
    }

    if (msg.event === "media") {
      const b64 = msg.media?.payload || "";
      if (!b64 || !dg) return;
      const ulaw = Buffer.from(b64, "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= BATCH_FRAMES) {
        const ulawChunk = Buffer.concat(pendingULaw);
        const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
        dg.sendPCM16LE(pcm16le);
        pendingULaw = [];
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("[INFO] Twilio stream STOP");
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
    }
  });

  ws.on("close", () => {
    try { dg?.close(); } catch {}
    console.log("[INFO] WS closed", { convoId: ws.__convoId });
  });
});
