// server.js — Old Line Barbershop AI Receptionist (Deepgram + GPT + ElevenLabs + Make.com)

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
  return d;
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

// Friendly confirmation readout
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function ordinal(n) {
  const s = ["th","st","nd","rd"], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
function humanDate(isoOrWord) {
  // if already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrWord)) {
    const d = new Date(isoOrWord + "T00:00:00");
    if (isNaN(d.getTime())) return isoOrWord;
    const m = MONTHS[d.getMonth()];
    const day = ordinal(d.getDate());
    return `${m} ${day}`;
  }
  // pass through words like "Monday" (GPT may produce ISO upstream, but handle gracefully)
  return isoOrWord;
}
function humanTime(t) {
  // accepts "3 PM", "15:00", "3PM"
  const m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2] ? m[2] : "00";
  const ampm = m[3] ? m[3].toUpperCase() : (h >= 12 ? "PM" : "AM");
  if (!m[3] && h > 12) h = h - 12;
  if (h === 0) h = 12;
  return `${h}:${min !== "00" ? min : ""} ${ampm}`.replace(":  ", " ").replace(": ", " ");
}
function whenSpoken(date, time) {
  const d = humanDate(date);
  const t = humanTime(time);
  return `${d} at ${t}`.replace(/\s+/g, " ").trim();
}

// ---------- Deepgram WebSocket ----------
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
async function say(ws, text) {
  if (!text) return;
  const streamSid = ws.__streamSid;
  if (!streamSid) return;

  console.log(JSON.stringify({ event: "BOT_SAY", reply: text }));

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
    phase: "idle", // 'idle' | 'booking'
    confirmed: false, // <-- NEW: prevents repeat confirmations
    slots: { service: "", date: "", time: "", name: "", phone: "" }
  };
}
function mergeSlots(state, parsed) {
  const before = { ...state.slots };
  let changed = false;

  if (parsed.service) {
    const svc = normalizeService(parsed.service);
    if (svc && svc !== state.slots.service) { state.slots.service = svc; changed = true; }
  }
  if (parsed.date) {
    const nd = normalizeDate(parsed.date);
    if (nd && nd !== state.slots.date) { state.slots.date = nd; changed = true; }
  }
  if (parsed.time) {
    if (parsed.time !== state.slots.time) { state.slots.time = parsed.time; changed = true; }
  }
  if (parsed.name) {
    if (parsed.name !== state.slots.name) { state.slots.name = parsed.name; changed = true; }
  }
  if (parsed.phone) {
    const ph = normalizePhone(parsed.phone);
    if (ph && ph !== state.slots.phone) { state.slots.phone = ph; changed = true; }
  }

  if (changed) {
    // any slot change after confirmation forces re-confirm
    if (state.confirmed) state.confirmed = false;
    console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
  }
}
function nextMissing(state) {
  if (!state.slots.service) return "service";
  if (!state.slots.date || !state.slots.time) return "datetime";
  if (!state.slots.name) return "name";
  if (!state.slots.phone) return "phone";
  return "done";
}

async function confirmOnce(ws, state) {
  // Gate: confirm ONLY once per complete set of slots
  if (state.confirmed) return;
  const spoken = whenSpoken(state.slots.date, state.slots.time);
  console.log(JSON.stringify({ event: "CONFIRM_READY", slots: state.slots, whenSpoken: spoken }));
  await say(ws, `Great — I’ve got a ${state.slots.service} for ${state.slots.name} on ${spoken}. I have your number as (${state.slots.phone.slice(0,3)}) ${state.slots.phone.slice(3,6)}-${state.slots.phone.slice(6)}. You’re all set. Anything else I can help with?`);
  state.confirmed = true;
}

async function askForMissing(ws, state) {
  const missing = nextMissing(state);
  console.log(JSON.stringify({ event: "SLOTS", slots: state.slots, missing }));

  // Only confirm if not yet confirmed
  if (missing === "done") {
    return confirmOnce(ws, state);
  }

  if (missing === "service") return say(ws, "What service would you like — a haircut, beard trim, or the combo?");
  if (missing === "datetime") return say(ws, `What date and time would you like for your ${state.slots.service || "appointment"}?`);
  if (missing === "name") return say(ws, "Can I get your first name?");
  if (missing === "phone") return say(ws, "What phone number should I use for confirmations?");
}

async function maybeResume(ws, state) {
  if (state.phase !== "booking") return false;
  const missing = nextMissing(state);
  if (missing === "done") {
    // already confirmed? do nothing.
    if (!state.confirmed) await confirmOnce(ws, state);
    return true;
  }
  await askForMissing(ws, state);
  return true;
}

// ---------- Classify + handle ----------
async function classifyAndHandle(ws, state, transcript) {
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
- Detect booking requests even if mixed with questions.
- If user changes their mind about service, update "service".
- For FAQs, do NOT start booking unless they ask to book.
- Keep values short; leave blank if unsure.
  `.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  // Merge/normalize & possibly reset confirmation
  mergeSlots(state, parsed);

  // FAQ
  if (parsed.intent === "FAQ") {
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    if (!answer) answer = "Happy to help. What else can I answer?";

    if (state.phase === "booking") {
      await say(ws, answer);
      await maybeResume(ws, state);
    } else {
      await say(ws, `${answer} Would you like to book an appointment?`);
    }
    return;
  }

  // Transfer
  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
    try { ws.close(); } catch {}
    return;
  }

  // Booking
  if (parsed.intent === "BOOK") {
    state.phase = "booking";
    await askForMissing(ws, state);
    return;
  }

  // Smalltalk/Unknown
  const fallbackPrompt = `
You are a friendly receptionist at Old Line Barbershop.
Reply with ONE short, natural sentence (<= 18 words).
If caller is mid-booking, keep it friendly, then continue the flow when possible.
Examples: "I know—wild weather! Can I get your first name?" or "Sure—what do you need?"
  `.trim();
  const nlg = await askGPT(fallbackPrompt, transcript);
  await say(ws, nlg || "Okay—how can I help?");
  // Only resume if not already fully confirmed.
  if (!state.confirmed) await maybeResume(ws, state);
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

      await say(ws, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
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
