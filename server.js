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
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

const tzNow = () => new Date(); // Render uses UTC; we only need relative math
const todayISO = () => {
  const d = tzNow();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const addDaysISO = (iso, days) => {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const nextWeekdayISO = (name) => {
  const idx = WEEKDAYS.indexOf(name.toLowerCase());
  if (idx < 0) return "";
  const now = tzNow();
  const todayIdx = now.getDay();
  let delta = (idx - todayIdx + 7) % 7;
  if (delta === 0) delta = 7; // next occurrence
  const d = new Date(now);
  d.setDate(now.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const ordinal = (n) => {
  const s = ["th","st","nd","rd"], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
};
function humanDate(iso, timeStr) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  const m = MONTHS[d.getMonth()];
  const day = d.getDate();
  const dayStr = ordinal(day);
  const t = (timeStr || "").toUpperCase().replace(/\s+/g," ").trim();
  return `${m} ${dayStr}${t ? " at " + t : ""}`;
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
function prettyPhone(d) {
  if (!d || d.length < 10) return d || "";
  const p = d.slice(-10);
  return `(${p.slice(0,3)}) ${p.slice(3,6)}-${p.slice(6)}`;
}
function normalizeDate(d) {
  if (!d) return "";
  const t = d.toLowerCase().trim();
  if (t === "today") return todayISO();
  if (t === "tomorrow") return addDaysISO(todayISO(), 1);
  if (WEEKDAYS.includes(t)) return nextWeekdayISO(t);
  // already like YYYY-MM-DD -> keep
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return d; // leave as-is if GPT already normalized
}
function isAffirmative(s="") {
  return /\b(yes|yeah|yup|sure|please|of course|ok|okay|sounds good|let's do it)\b/i.test(s);
}
function isConfirmQuestion(s="") {
  return /\b(is (it )?(booked|confirmed)|did you (book|schedule)|am i booked|are we set)\b/i.test(s);
}

// ---------- Deepgram WS ----------
function startDeepgram({ onFinal }) {
  const url = "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16&sample_rate=8000&channels=1&model=nova-2-phonecall"
    + "&interim_results=true&smart_format=true&language=en-US&endpointing=250";

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });

  dg.on("open", () => console.log("[Deepgram] ws open"));
  dg.on("message", (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    const text = (alt?.transcript || "").trim();
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

// μ-law → PCM16LE
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
  for (let i = 0; i < ulawBuf.length; i++) out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i*2);
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
    resp.data.on("end", () => ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } })));
  } catch (e) {
    console.error("[TTS ERROR]", e.message);
  }
}

// ---------- State / Slots ----------
function newState() {
  return {
    phase: "idle",          // 'idle' | 'booking' | 'done'
    confirmed: false,
    slots: { service: "", date: "", time: "", name: "", phone: "" },
    lastMissing: null,      // 'service' | 'datetime' | 'name' | 'phone' | null
    lastQuestion: null      // 'ask_book_cta' | null
  };
}
function nextMissing(state) {
  if (!state.slots.service) return "service";
  if (!state.slots.date || !state.slots.time) return "datetime";
  if (!state.slots.name) return "name";
  if (!state.slots.phone) return "phone";
  return "done";
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
    const t = parsed.time.trim();
    if (t && t !== state.slots.time) { state.slots.time = t; changed = true; }
  }
  if (parsed.name) {
    const n = parsed.name.trim();
    if (n && n !== state.slots.name) { state.slots.name = n; changed = true; }
  }
  if (parsed.phone) {
    const ph = normalizePhone(parsed.phone);
    if (ph && ph !== state.slots.phone) { state.slots.phone = ph; changed = true; }
  }

  if (changed) console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
}

async function askForMissing(ws, state) {
  const missing = nextMissing(state);
  console.log(JSON.stringify({ event: "SLOTS", slots: state.slots, missing }));
  state.lastMissing = (missing !== "done") ? missing : null;

  if (missing === "service") return say(ws, "What service would you like — a haircut, beard trim, or the combo?");
  if (missing === "datetime") return say(ws, `What date and time would you like for your ${state.slots.service || "appointment"}?`);
  if (missing === "name") return say(ws, "Can I get your first name?");
  if (missing === "phone") return say(ws, "What phone number should I use for confirmations?");
  if (missing === "done") return confirmAndFinalize(ws, state);
}

async function confirmAndFinalize(ws, state) {
  try {
    const whenSpoken = humanDate(state.slots.date, state.slots.time);
    const phonePretty = prettyPhone(state.slots.phone);
    console.log(JSON.stringify({ event: "CONFIRM_READY", slots: state.slots, whenSpoken }));

    // Optional: send to Make.com if configured
    if (MAKE_CREATE_URL) {
      try {
        // Best-effort payload (30 min block). If parsing fails, still send basic info.
        const startISO = `${state.slots.date}T${to24h(state.slots.time)}:00`;
        const endISO = addMinutesISO(startISO, 30);
        const payload = {
          Event_Name: `${state.slots.service} – ${state.slots.name}`,
          Start_Time: startISO,
          End_Time: endISO,
          Customer_Name: state.slots.name,
          Customer_Phone: state.slots.phone,
          Notes: "Booked by phone agent"
        };
        const r = await axios.post(MAKE_CREATE_URL, payload, { timeout: 5000 });
        console.log(JSON.stringify({ event: "MAKE_CREATE_OK", status: r.status }));
      } catch (e) {
        console.warn("[MAKE_CREATE] error:", e.message);
      }
    }

    await say(ws, `Great — I’ve booked a ${state.slots.service} for ${state.slots.name} on ${whenSpoken}. I have your number as ${phonePretty}. You’re all set. Anything else I can help with?`);
    state.phase = "done";
    state.confirmed = true;
  } catch (e) {
    // Human fallback transfer if anything feels off
    await transferOwner(ws);
  }
}

function to24h(t="") {
  // naive: handles "3 PM", "3PM", "15:00"
  const s = t.trim().toUpperCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return s; // already 24h or unknown
  let hh = parseInt(m[1], 10);
  let mm = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3];
  if (ap === "PM" && hh < 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
}
function addMinutesISO(startISO, minutes) {
  const d = new Date(startISO);
  if (isNaN(d.getTime())) return "";
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString().slice(0,19);
}

async function maybeResume(ws, state) {
  if (state.phase === "booking" && !state.confirmed) {
    const missing = nextMissing(state);
    if (missing !== "done") {
      await askForMissing(ws, state);
      return true;
    } else {
      await confirmAndFinalize(ws, state);
      return true;
    }
  }
  return false;
}

async function transferOwner(ws) {
  await say(ws, "I’m not sure about that—let me transfer you to the owner. Please hold.");
  try { ws.close(); } catch {}
}

// ---------- Classify + Orchestrate ----------
async function classifyAndHandle(ws, state, transcript) {
  // If we just asked a CTA and caller says "yes", kick off booking
  if (state.lastQuestion === "ask_book_cta" && isAffirmative(transcript)) {
    state.phase = "booking";
    state.lastQuestion = null;
    await askForMissing(ws, state);
    return;
  }

  // If caller asks "is it booked?" → confirm or ask next piece
  if (isConfirmQuestion(transcript)) {
    const missing = nextMissing(state);
    if (missing === "done") return confirmAndFinalize(ws, state);
    await say(ws, "Not yet—let’s finish up.");
    return askForMissing(ws, state);
  }

  const systemPrompt = `
Return STRICT JSON:
{
 "intent": "FAQ" | "BOOK" | "TRANSFER" | "SMALLTALK" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",
 "date": "",   // "today" | "tomorrow" | weekday ("monday") | "YYYY-MM-DD"
 "time": "",   // "3 PM" | "15:00"
 "name": "",
 "phone": ""
}
Rules:
- If user says "ASAP" or similar urgency, set intent="BOOK" but leave date/time empty.
- If user answers "yes/please/sure" right after a booking invitation, treat as intent="BOOK".
- Do NOT start booking on FAQ unless they ask to book.
- Keep values short; leave blank if unsure.
  `.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  // Merge slots and set phase if needed
  mergeSlots(state, parsed);
  if (parsed.intent === "BOOK") state.phase = "booking";

  // Branches
  if (parsed.intent === "FAQ") {
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    if (!answer) answer = "Happy to help.";

    if (state.phase === "booking" && !state.confirmed) {
      await say(ws, answer);
      await maybeResume(ws, state);
    } else {
      await say(ws, `${answer} Would you like to book an appointment?`);
      state.lastQuestion = "ask_book_cta";
    }
    return;
  }

  if (parsed.intent === "TRANSFER") return transferOwner(ws);

  if (state.phase === "booking" || parsed.intent === "BOOK") {
    state.phase = "booking";
    state.lastQuestion = null;
    return askForMissing(ws, state);
  }

  // SMALLTALK / UNKNOWN
  // If we’re in booking, avoid filler—resume flow.
  if (state.phase === "booking" && !state.confirmed) {
    return maybeResume(ws, state);
  }

  // Otherwise one short receptionist line
  const fallbackPrompt = `
You are a friendly receptionist. Reply with ONE short, casual sentence (<= 14 words), no explanations.
Examples: "Sure—what do you need?" / "Got it—how can I help?" / "Happy to help—what’s up?"
  `.trim();
  const nlg = await askGPT(fallbackPrompt, transcript);
  await say(ws, nlg || "Sure—how can I help?");
}

// ---------- WS ----------
wss.on("connection", (ws) => {
  let dg = null;
  let pendingULaw = [];
  const BATCH_FRAMES = 5;

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      ws.__convoId = uuidv4();
      ws.__state = newState();
      console.log(JSON.stringify({ event: "CALL_START", streamSid: ws.__streamSid, convoId: ws.__convoId }));

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
