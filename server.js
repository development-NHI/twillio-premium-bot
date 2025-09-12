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
const AGENT_PROMPT = process.env.AGENT_PROMPT || "You are a friendly, human-sounding AI receptionist.";

if (!OPENAI_API_KEY) console.warn("(!) OPENAI_API_KEY missing");
if (!DEEPGRAM_API_KEY) console.warn("(!) DEEPGRAM_API_KEY missing");
if (!ELEVENLABS_API_KEY) console.warn("(!) ELEVENLABS_API_KEY missing");

// ---- express
const app = express();
app.use(bodyParser.json());
app.get("/", (_, res) => res.status(200).send("✅ Old Line Barbershop AI Receptionist running"));
app.post("/twiml", (_, res) => {
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME || ("localhost:" + PORT)}"/>
      </Connect>
    </Response>
  `);
});
const server = app.listen(PORT, () => console.log(`[INFO] Server running on ${PORT}`));

const wss = new WebSocketServer({ server });

// ---------- helpers: state/slots ----------
function newState() {
  return {
    convoId: uuidv4(),
    phase: "idle", // idle | booking
    lastPrompt: "",
    lastPromptAt: 0,
    slots: { service: "", date: "", time: "", name: "", phone: "" }
  };
}
function logJSON(obj) {
  try { console.log(JSON.stringify(obj)); } catch {}
}
function normalizeService(s) {
  if (!s) return "";
  const t = s.toLowerCase();
  if (/\b(combo|both|haircut\s*(\+|and|&)\s*beard)\b/.test(t)) return "combo";
  if (/\bbeard\b/.test(t)) return "beard trim";
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return "haircut";
  return "";
}
function mergeSlots(state, info) {
  const before = { ...state.slots };
  if (info.service) state.slots.service = normalizeService(info.service) || state.slots.service;
  if (info.date) state.slots.date = info.date;
  if (info.time) state.slots.time = info.time;
  if (info.name) state.slots.name = info.name;
  if (info.phone) state.slots.phone = info.phone;
  logJSON({ event: "SLOTS_MERGE", before, after: state.slots });
}
function nextMissingSlot(slots) {
  if (!slots.service) return "service";
  if (!slots.date || !slots.time) return "datetime";
  if (!slots.name) return "name";
  if (!slots.phone) return "phone";
  return null;
}
function debouncePrompt(state, text, ms = 1800) {
  const now = Date.now();
  if (text === state.lastPrompt && (now - state.lastPromptAt) < ms) return true;
  state.lastPrompt = text;
  state.lastPromptAt = now;
  return false;
}
function isWeekdayBusinessHours(dateISO, time24) {
  if (!dateISO || !time24) return true; // don’t block if we can’t parse
  try {
    const d = new Date(`${dateISO}T${time24}:00`);
    const day = d.getUTCDay(); // 0 Sun .. 6 Sat (UTC; approximate)
    // business: Mon–Fri
    if (day === 0 || day === 6) return false;
    const hour = parseInt(time24.split(":")[0], 10);
    // 9–17 local desired; we can’t easily TZ-correct here, keep loose
    return hour >= 9 && hour < 17;
  } catch { return true; }
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

// ---------- booking helpers ----------
function promptForNext(ws, state) {
  const missing = nextMissingSlot(state.slots);
  logJSON({ event: "SLOTS", slots: state.slots, missing });
  if (!missing) return false;

  let line = "";
  if (missing === "service") line = "What service would you like — a haircut, beard trim, or the combo?";
  else if (missing === "datetime") {
    const svc = state.slots.service || "that";
    line = `What date and time would you like for your ${svc}?`;
  } else if (missing === "name") line = "Can I get your first name?";
  else if (missing === "phone") line = "What phone number should I use for confirmations?";

  if (!debouncePrompt(state, line)) {
    say(ws, line);
  }
  return true;
}

async function maybeResume(ws, state) {
  if (state.phase === "booking" && nextMissingSlot(state.slots)) {
    await promptForNext(ws, state);
    return true;
  }
  return false;
}

async function finalizeIfReady(ws, state) {
  const { service, date, time, name, phone } = state.slots;
  if (!(service && date && time && name && phone)) return false;

  if (!isWeekdayBusinessHours(date, time)) {
    await say(ws, "We book appointments Monday to Friday, 9 AM to 5 PM. Could you pick a time during business hours?");
    return true;
  }

  const startISO = `${date}T${time}:00`;
  // Add 30 minutes (simple string math not guaranteed; leave end to Make if needed)
  // We’ll send both; if Make expects ISO strictly, it can compute end.
  const payload = {
    Event_Name: service,
    Start_Time: startISO,
    End_Time: "", // let Make compute 30-min end or leave blank if your scenario handles it
    Customer_Name: name,
    Customer_Phone: phone,
    Customer_Email: "",
    Notes: `Booked by phone agent.`
  };

  try {
    if (MAKE_CREATE_URL) {
      await axios.post(MAKE_CREATE_URL, payload, { timeout: 8000 });
      logJSON({ event: "MAKE_CREATE", ok: true, payload });
    }
  } catch (e) {
    logJSON({ event: "MAKE_CREATE", ok: false, error: e.message });
  }

  await say(ws, `Great, I’ve booked a ${service} for ${name} on ${date} at ${time}. You’ll get a confirmation at ${phone}. Anything else I can help with today?`);
  state.phase = "idle"; // done
  return true;
}

// ---------- intent classify ----------
async function classifyAndHandle(ws, state, transcript) {
  // strict JSON extractor that also pulls slot hints even during FAQ/SMALLTALK
  const sys = `
Return ONLY this JSON:
{
 "intent": "FAQ" | "BOOK" | "SMALLTALK" | "TRANSFER" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",
 "date": "",
 "time": "",
 "name": "",
 "phone": ""
}
Rules:
- If user changes service ("actually, make it combo"), set service to the NEW value.
- If user asks about hours/prices/services/location, intent=FAQ and fill faq_topic.
- For booking: prefer extracting service/date/time/name/phone if mentioned.
- Keep answers short and natural when we later ask NLG.
  `.trim();

  let parsed = {};
  try {
    const out = await askGPT(sys, transcript, "json");
    parsed = JSON.parse(out || "{}");
  } catch { parsed = {}; }
  logJSON({ event: "GPT_CLASSIFY", transcript, parsed });

  // Merge slots from ANY intent (so “actually, combo” sticks)
  mergeSlots(state, parsed);

  // FAQ answers
  if (parsed.intent === "FAQ") {
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and a combo package.";
    if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    if (answer) {
      await say(ws, answer);
      // optional: log to Make
      try {
        if (MAKE_FAQ_URL) await axios.post(MAKE_FAQ_URL, { topic: parsed.faq_topic, transcript }, { timeout: 4000 });
      } catch {}
      // >>> resume booking if in progress
      if (await maybeResume(ws, state)) return;
      // else softly invite to book (without hijacking)
      await say(ws, "Would you like to book an appointment?");
      return;
    }
  }

  // Transfer cases
  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
    try { ws.close(); } catch {}
    return;
  }

  // Booking case (or we’re already in booking)
  if (parsed.intent === "BOOK" || state.phase === "booking") {
    state.phase = "booking";
    if (await finalizeIfReady(ws, state)) return;
    await promptForNext(ws, state);
    return;
  }

  // Smalltalk / Unknown → brief reply, then resume if applicable
  const hint = (state.phase === "booking" && nextMissingSlot(state.slots))
    ? `Be brief, then ask ONLY the next missing item: ${nextMissingSlot(state.slots)}.` 
    : "Be brief and helpful.";
  const nlg = await askGPT(AGENT_PROMPT, `${transcript}\n\n${hint}`);
  await say(ws, nlg || "Okay.");
  if (await maybeResume(ws, state)) return;
}

// ---------- WS ----------
wss.on("connection", (ws) => {
  let dg = null;
  let pendingULaw = [];
  const BATCH_FRAMES = 5;

  ws.__state = newState();

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      logJSON({ event: "CALL_START", streamSid: ws.__streamSid, convoId: ws.__state.convoId });

      // Start Deepgram
      dg = startDeepgram({
        onFinal: async (text) => { await classifyAndHandle(ws, ws.__state, text); }
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
        try { dg.sendPCM16LE(pcm16le); } catch {}
        pendingULaw = [];
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("[INFO] Twilio stream STOP");
      if (pendingULaw.length && dg) {
        try {
          const ulawChunk = Buffer.concat(pendingULaw);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          dg.sendPCM16LE(pcm16le);
        } catch {}
        pendingULaw = [];
      }
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
    }
  });

  ws.on("close", () => {
    try { dg?.close(); } catch {}
    console.log("[INFO] WS closed", { convoId: ws.__state?.convoId });
  });
});
