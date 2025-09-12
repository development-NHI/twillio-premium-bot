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

/* ---------------- Utilities ---------------- */

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
function weekdayToNextISO(weekday) {
  const map = { sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };
  const target = map[(weekday||"").toLowerCase()];
  if (target === undefined) return "";
  const d = new Date();
  const diff = (target + 7 - d.getDay()) % 7 || 7; // next occurrence, not today
  return addDaysISO(nowNY(), diff);
}
function normalizeDate(d) {
  if (!d) return "";
  const t = d.toLowerCase();
  if (t === "today") return nowNY();
  if (t === "tomorrow") return addDaysISO(nowNY(), 1);
  if (["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].includes(t)) {
    return weekdayToNextISO(t);
  }
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
  return d.length >= 10 ? d.slice(-10) : ""; // last 10 digits if extra
}
function formatPhone(digits) {
  if (!digits || digits.length < 10) return digits || "";
  return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6,10)}`;
}
function ordinal(n) {
  const s = ["th","st","nd","rd"], v = n%100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
function formatDateHuman(iso) {
  // expects YYYY-MM-DD
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const month = d.toLocaleString("en-US",{month:"long"});
  const day = ordinal(d.getDate());
  return `${month} ${day}`;
}
function formatTimeHuman(t) {
  if (!t) return "";
  const m = String(t).trim().toUpperCase();
  // accept "15:00" -> "3 PM"
  if (/^\d{1,2}:\d{2}$/.test(m)) {
    let [hh, mm] = m.split(":").map(Number);
    const ampm = hh >= 12 ? "PM" : "AM";
    hh = ((hh + 11) % 12) + 1;
    if (mm === 0) return `${hh} ${ampm}`;
    return `${hh}:${String(mm).padStart(2,"0")} ${ampm}`;
  }
  // accept "3PM" or "3 PM"
  return m.replace(/\s+/g," ").replace("P.M.","PM").replace("A.M.","AM");
}

/* ---------------- Deepgram WS ---------------- */

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

// μ-law → PCM16
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

/* ---------------- OpenAI ---------------- */

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

/* ---------------- TTS ---------------- */

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

/* ---------------- Slot State ---------------- */

function newState() {
  return {
    phase: "idle",          // 'idle' | 'booking' | 'confirmed'
    confirmed: false,
    lastPrompt: "",         // 'service' | 'datetime' | 'name' | 'phone' (for clarifications)
    clarifyCounts: { service:0, datetime:0, name:0, phone:0 },
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
    console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
    // If user corrects anything post-confirmation, reconfirm
    if (state.phase === "confirmed") state.confirmed = false;
  }
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
  state.lastPrompt = missing === "done" ? "" : missing;

  if (missing === "service")
    return say(ws, "What service would you like — a haircut, beard trim, or the combo?");
  if (missing === "datetime")
    return say(ws, `What date and time would you like for your ${state.slots.service || "appointment"}?`);
  if (missing === "name")
    return say(ws, "Can I get your first name?");
  if (missing === "phone")
    return say(ws, "What phone number should I use for confirmations?");
  if (missing === "done")
    return confirmNow(ws, state);
}

async function clarifySlot(ws, state, slotKey) {
  state.clarifyCounts[slotKey] = (state.clarifyCounts[slotKey] || 0) + 1;

  // Gentle escalation per slot
  const count = state.clarifyCounts[slotKey];
  let line = "";
  if (slotKey === "service") {
    line = count === 1
      ? "Sorry—I didn’t catch the service. Haircut, beard trim, or the combo?"
      : "Just the service please: haircut, beard trim, or combo?";
  } else if (slotKey === "datetime") {
    line = count === 1
      ? `I didn’t catch the time—what date and time work for your ${state.slots.service || "appointment"}?`
      : "Please say the date and time together, like “Monday at 3 PM.”";
  } else if (slotKey === "name") {
    line = count === 1
      ? "Sorry—what’s your first name?"
      : "Just your first name is fine.";
  } else if (slotKey === "phone") {
    line = count === 1
      ? "I didn’t catch the number—could you say it slowly with area code?"
      : "Please say ten digits with area code, for example “two two three, two seven six, nine eight nine one.”";
  }

  console.log(JSON.stringify({ event: "CLARIFY", slot: slotKey, count }));
  await say(ws, line);

  // Safety net: after two failed clarifications, transfer to owner
  if (count >= 3) {
    console.log(JSON.stringify({ event: "FAILSAFE_TRANSFER", slot: slotKey }));
    await say(ws, "Let me transfer you to the owner to finish this up.");
    try { ws.close(); } catch {}
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

async function confirmNow(ws, state) {
  const whenDate = formatDateHuman(state.slots.date);
  const whenTime = formatTimeHuman(state.slots.time);
  const nicePhone = formatPhone(state.slots.phone);
  const line = `Great — I’ve booked a ${state.slots.service} for ${state.slots.name} on ${whenDate} at ${whenTime}. I have your number as ${nicePhone}. You’re all set. Anything else I can help with?`;
  console.log(JSON.stringify({ event: "CONFIRM_READY", slots: state.slots, whenSpoken: `${whenDate} at ${whenTime}` }));
  await say(ws, line);
  state.phase = "confirmed";
  state.confirmed = true;
  state.lastPrompt = "";
  // (Optional) post to MAKE here when you’re ready
  // await postToMakeCreate(state.slots).catch(()=>{});
}

/* ---------------- Classify & Handle ---------------- */

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
- Detect booking even if mixed with questions.
- If user changes a slot (service/date/time/name/phone), include the new value.
- For FAQs, do NOT start booking unless they ask to book.
- Keep values short; leave blank if unsure.
`.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  // Merge slot hints (always keep context)
  mergeSlots(state, parsed);

  // If already confirmed and they correct any slot → reconfirm
  if (state.phase === "confirmed") {
    if (parsed.service || parsed.date || parsed.time || parsed.name || parsed.phone) {
      console.log(JSON.stringify({ event: "CONFIRM_UPDATE_REQUEST", slots: state.slots }));
      await confirmNow(ws, state);
      return;
    }
    // If ask "is it booked?" etc.
    if (parsed.intent === "FAQ" || parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
      const whenDate = formatDateHuman(state.slots.date);
      const whenTime = formatTimeHuman(state.slots.time);
      await say(ws, `Yes—you're set for ${whenDate} at ${whenTime}. Anything else?`);
      return;
    }
  }

  // FAQ path
  if (parsed.intent === "FAQ") {
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    if (!answer) answer = "Happy to help. What else can I answer?";

    if (state.phase === "booking") {
      // Answer briefly, then resume slot flow (single utterance total)
      await say(ws, `${answer}`);
      await maybeResume(ws, state);
    } else {
      await say(ws, `${answer} Would you like to book an appointment?`);
    }
    return;
  }

  // Transfer path
  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
    try { ws.close(); } catch {}
    return;
  }

  // Booking path
  if (parsed.intent === "BOOK") {
    if (state.phase === "idle") state.phase = "booking";
    // After merge, if a slot is still missing, ask or clarify
    const missing = nextMissing(state);
    if (missing === "done") return confirmNow(ws, state);
    // If user’s latest utterance didn’t fill the asked slot and we’re in booking, clarify instead of generic fallback
    if (state.lastPrompt && missing === state.lastPrompt) {
      // was asked already, try clarify
      return clarifySlot(ws, state, missing);
    }
    return askForMissing(ws, state);
  }

  // SMALLTALK / UNKNOWN
  if (state.phase === "booking") {
    // If we’re missing a slot, clarify that slot instead of drifting
    const missing = nextMissing(state);
    if (missing !== "done") {
      // If they gave something we couldn't parse (e.g., "this one"), clarify current slot
      return clarifySlot(ws, state, state.lastPrompt || missing);
    }
    // If somehow everything is present, confirm
    return confirmNow(ws, state);
  } else {
    // Not in booking → keep it short and human
    const fallbackPrompt = `
You are a friendly receptionist at Old Line Barbershop.
Reply with ONE short, conversational sentence (<= 18 words).
Do not explain rules or how you work.
Examples: "Sure—what do you need?" / "Got it—how can I help?" / "No problem—what's up?"
`.trim();
    const nlg = await askGPT(fallbackPrompt, transcript);
    await say(ws, nlg || "Okay—how can I help?");
  }
}

/* ---------------- WebSocket Handler ---------------- */

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
