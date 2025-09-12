// server.js — Old Line Barbershop AI Receptionist (Deepgram + GPT + ElevenLabs)
// Only surgical fixes: natural date formatting + slot-priority/resume + simple "yes" handoff

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

// ---------- Utils ----------
function logJSON(obj) { try { console.log(JSON.stringify(obj)); } catch {} }

function normalizePhone(num = "") {
  const digits = (num || "").replace(/\D/g, "");
  if (digits.length >= 10) return digits;
  return "";
}

function normalizeService(text = "") {
  const t = text.toLowerCase();
  if (/\b(combo|both|haircut\s*(?:\+|and|&)\s*beard|haircut\s*and\s*beard)\b/.test(t)) return "combo";
  if (/\bbeard( trim|)\b/.test(t)) return "beard trim";
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return "haircut";
  return "";
}

function tzNowNY() {
  // America/New_York
  const now = new Date();
  // Use system time; conversions later when formatting
  return now;
}

function toISODateFromKeyword(keyword) {
  const now = tzNowNY();
  if (!keyword) return "";
  const k = keyword.toLowerCase().trim();
  const d = new Date(now);
  if (k === "today") {
    // keep today
  } else if (k === "tomorrow") {
    d.setDate(d.getDate() + 1);
  } else {
    // if already ISO-like, pass through
    if (/^\d{4}-\d{2}-\d{2}$/.test(k)) return k;
    return ""; // unknown string
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ordinal helper for spoken dates
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Natural date-time formatter (America/New_York)
function formatDateTime(dateISO, timeText) {
  try {
    if (!dateISO && !timeText) return "";
    // Build a Date using local parsing; fallback to nice pieces
    let hour = 12, minute = 0;
    if (timeText) {
      // naive parse like "3 PM" / "3:30 pm"
      const m = timeText.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
      if (m) {
        hour = parseInt(m[1], 10);
        minute = m[2] ? parseInt(m[2], 10) : 0;
        const ap = (m[3] || "").toLowerCase();
        if (ap === "pm" && hour < 12) hour += 12;
        if (ap === "am" && hour === 12) hour = 0;
      }
    }
    let d;
    if (dateISO) {
      d = new Date(`${dateISO}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00`);
    } else {
      d = new Date();
      d.setHours(hour, minute, 0, 0);
    }
    // Format parts manually for ordinal day
    const opts = { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" };
    const fmt = new Intl.DateTimeFormat("en-US", opts).formatToParts(d);
    const parts = Object.fromEntries(fmt.map(p => [p.type, p.value]));
    const dayNum = parseInt(parts.day, 10);
    const dateStr = `${parts.weekday}, ${parts.month} ${ordinal(dayNum)}`;
    const tOpts = { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" };
    const timeStr = new Intl.DateTimeFormat("en-US", tOpts).format(d);
    return `${dateStr} at ${timeStr}`;
  } catch {
    // fallback
    return `${dateISO || ""} ${timeText || ""}`.trim();
  }
}

function isAffirmative(utter = "") {
  const t = utter.toLowerCase().trim();
  return ["yes", "yeah", "yup", "sure", "please", "ok", "okay", "sounds good"].some(w => t === w || t.startsWith(w));
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
      logJSON({ event: "ASR_FINAL", transcript: text });
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

  logJSON({ event: "BOT_SAY", reply: text });

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

// ---------- Slot/State helpers ----------
function newState() {
  return {
    id: uuidv4(),
    phase: "idle",                 // 'idle' | 'booking'
    lastAsked: "",                 // track last prompt type
    pendingAction: "",             // e.g., 'offer_book'
    slots: { service: "", date: "", time: "", name: "", phone: "" }
  };
}

function mergeSlots(state, parsed, utterance) {
  const before = { ...state.slots };

  // service from parsed or utterance
  const svc = normalizeService(parsed.service || utterance || "");
  if (svc) state.slots.service = svc;

  // date normalization
  if (parsed.date) {
    const iso = toISODateFromKeyword(parsed.date) || ( /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : "" );
    if (iso) state.slots.date = iso;
  }

  // time (keep as spoken, e.g., "3 PM")
  if (parsed.time) state.slots.time = parsed.time.trim();

  // name/phone always captured, regardless of intent
  if (parsed.name) state.slots.name = parsed.name.trim();
  if (parsed.phone) {
    const p = normalizePhone(parsed.phone);
    if (p) state.slots.phone = p;
  }

  const after = { ...state.slots };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    logJSON({ event: "SLOTS_MERGE", before, after });
    return true;
  }
  return false;
}

function nextMissing(state) {
  if (!state.slots.service) return "service";
  if (!state.slots.date || !state.slots.time) return "datetime";
  if (!state.slots.name) return "name";
  if (!state.slots.phone) return "phone";
  return "done";
}

async function resumeBooking(ws, state) {
  const missing = nextMissing(state);
  logJSON({ event: "SLOTS", slots: state.slots, missing });

  if (missing === "service") {
    state.phase = "booking";
    state.lastAsked = "service";
    await say(ws, "What service would you like — a haircut, beard trim, or the combo?");
    return true;
  }
  if (missing === "datetime") {
    state.phase = "booking";
    state.lastAsked = "datetime";
    await say(ws, `What date and time would you like for your ${state.slots.service || "appointment"}?`);
    return true;
  }
  if (missing === "name") {
    state.phase = "booking";
    state.lastAsked = "name";
    await say(ws, "Can I get your first name?");
    return true;
  }
  if (missing === "phone") {
    state.phase = "booking";
    state.lastAsked = "phone";
    await say(ws, "What phone number should I use for confirmations?");
    return true;
  }

  // done → confirm naturally formatted
  const pretty = formatDateTime(state.slots.date, state.slots.time);
  const phone = state.slots.phone;
  const svc = state.slots.service;
  const name = state.slots.name;

  state.lastAsked = "confirm";
  await say(ws, `Great — I have a ${svc} on ${pretty} for ${name}. I’ll text the confirmation to ${phone}. Anything else I can help with?`);
  return true;
}

// ---------- Classifier prompt ----------
const CLASSIFIER_SYS = `
Return a strict JSON with fields:
{
 "intent": "FAQ" | "BOOK" | "CANCEL" | "RESCHEDULE" | "TRANSFER" | "SMALLTALK" | "UNKNOWN",
 "faq_topic": "HOURS" | "PRICES" | "SERVICES" | "LOCATION" | "",
 "service": "",
 "date": "",     // e.g., "today", "tomorrow", or "YYYY-MM-DD"
 "time": "",     // e.g., "3 PM", "3:30 PM"
 "name": "",
 "phone": ""
}

Rules:
- If caller asks prices/hours/services/location → intent="FAQ" with faq_topic.
- Extract service/name/phone/date/time whenever present (even if intent smalltalk).
- Recognize "combo"/"both"/"haircut + beard" → service="combo".
- Keep replies OUT of JSON; just fill fields.
`.trim();

// ---------- WS ----------
wss.on("connection", (ws) => {
  let dg = null;
  let pendingULaw = [];
  const BATCH_FRAMES = 5;

  const state = newState();
  const convoId = state.id;

  const answerFAQ = async (topic) => {
    let a = "";
    if (topic === "HOURS") a = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (topic === "PRICES") a = "Haircut $30, beard trim $15, combo $40.";
    else if (topic === "SERVICES") a = "We offer haircuts, beard trims, and the combo.";
    else if (topic === "LOCATION") a = "We’re at 123 Blueberry Lane.";
    if (a) await say(ws, a);
  };

  async function handleUtterance(utter) {
    // Quick “yes” handoff if we just offered to book
    if (state.pendingAction === "offer_book" && isAffirmative(utter)) {
      state.pendingAction = "";
      state.phase = "booking";
      await resumeBooking(ws, state); // will ask for service first
      return;
    }

    const parsedRaw = await askGPT(CLASSIFIER_SYS, utter, "json");
    let parsed = {};
    try { parsed = JSON.parse(parsedRaw); } catch { parsed = {}; }
    logJSON({ event: "GPT_CLASSIFY", transcript: utter, parsed });

    // Always merge slots if any found (even if SMALLTALK)
    const changed = mergeSlots(state, parsed, utter);

    // Enter booking if user asked to book OR we just captured any booking slot content
    if (parsed.intent === "BOOK" || changed) {
      state.phase = "booking";
      await resumeBooking(ws, state);
      return;
    }

    // FAQ (only if not in active booking)
    if (parsed.intent === "FAQ" && state.phase !== "booking") {
      await answerFAQ(parsed.faq_topic || "");
      // After answering an FAQ, offer booking once
      state.pendingAction = "offer_book";
      await say(ws, "Would you like to book an appointment?");
      return;
    }

    // Transfer
    if (parsed.intent === "TRANSFER") {
      await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
      try { ws.close(); } catch {}
      return;
    }

    // If we’re already booking, keep going even if GPT said smalltalk/unknown
    if (state.phase === "booking") {
      await resumeBooking(ws, state);
      return;
    }

    // Lightweight fallback (idle only)
    await say(ws, "Sure—what do you need?");
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      logJSON({ event: "CALL_START", streamSid: ws.__streamSid, convoId });

      // Start Deepgram
      dg = startDeepgram({
        onFinal: async (text) => { await handleUtterance(text); }
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
      return;
    }
  });

  ws.on("close", () => {
    try { dg?.close(); } catch {}
    console.log("[INFO] WS closed", { convoId });
  });
});
