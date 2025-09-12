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
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL; // optional (non-blocking)
const MAKE_FAQ_URL = process.env.MAKE_FAQ_URL;       // optional (non-blocking)

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

/* ----------------- Small safe utils ----------------- */
const TZ_OFFSET_MIN = new Date().getTimezoneOffset(); // keep simple; we only need day math
const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

const todayISO = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
};
const addDaysISO = (iso, days) => {
  const d = new Date(iso);
  d.setDate(d.getDate()+days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
};
function nextWeekdayISO(word) {
  const idx = WEEKDAYS.indexOf(word.toLowerCase());
  if (idx < 0) return "";
  const now = new Date();
  const todayIdx = now.getDay();
  let delta = (idx - todayIdx + 7) % 7;
  if (delta === 0) delta = 7; // next occurrence of that weekday
  const next = new Date(now);
  next.setDate(now.getDate() + delta);
  const yyyy = next.getFullYear();
  const mm = String(next.getMonth()+1).padStart(2,"0");
  const dd = String(next.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}
function normalizeDate(d) {
  if (!d) return "";
  const t = d.toLowerCase().trim();
  if (t === "today") return todayISO();
  if (t === "tomorrow") return addDaysISO(todayISO(), 1);
  if (WEEKDAYS.includes(t)) return nextWeekdayISO(t);
  // already a date? pass through
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
function ordinal(n) {
  const s = ["th","st","nd","rd"], v = n%100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
function dateToSpeak(iso) {
  // iso "YYYY-MM-DD" → "September 15th"
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "";
  const d = new Date(iso+"T12:00:00Z");
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const day = d.getUTCDate();
  return `${month} ${ordinal(day)}`;
}
function timeToSpeak(t) {
  // accepts "15:00" | "3PM" | "3 PM" | "3 pm"
  if (!t) return "";
  const m = t.trim().toUpperCase();
  if (/^\d{1,2}:\d{2}$/.test(m)) {
    const [H, MM] = m.split(":").map(x => parseInt(x,10));
    const h12 = ((H+11)%12)+1;
    const ampm = H>=12 ? "PM" : "AM";
    return `${h12}${MM!==0 ? ":"+String(MM).padStart(2,"0") : ""} ${ampm}`.trim();
  }
  const m2 = m.replace(/\s+/g,"");
  if (/^\d{1,2}(AM|PM)$/.test(m2)) {
    const H = parseInt(m2,10);
    const ampm = m2.endsWith("AM") ? "AM":"PM";
    return `${H} ${ampm}`;
  }
  return t; // fallback unchanged
}

/* ----------------- Deepgram Realtime ----------------- */
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

/* ----------------- GPT ----------------- */
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

/* ----------------- TTS (ElevenLabs) ----------------- */
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

/* ----------------- Slot state + helpers ----------------- */
function newState() {
  return {
    phase: "idle", // 'idle' | 'booking' | 'done'
    slots: { service: "", date: "", time: "", name: "", phone: "" },
    lastConfirmed: null,     // snapshot of last confirmed slots
    askCounts: { service:0, datetime:0, name:0, phone:0 } // for loop-detect
  };
}

// returns list of fields that changed
function mergeSlots(state, parsed) {
  const before = { ...state.slots };
  const changed = [];

  if (parsed.service) {
    const svc = normalizeService(parsed.service);
    if (svc && svc !== state.slots.service) { state.slots.service = svc; changed.push("service"); }
  }
  if (parsed.date) {
    const nd = normalizeDate(parsed.date);
    if (nd && nd !== state.slots.date) { state.slots.date = nd; changed.push("date"); }
  }
  if (parsed.time) {
    if (parsed.time !== state.slots.time) { state.slots.time = parsed.time; changed.push("time"); }
  }
  if (parsed.name) {
    if (parsed.name !== state.slots.name) { state.slots.name = parsed.name; changed.push("name"); }
  }
  if (parsed.phone) {
    const ph = normalizePhone(parsed.phone);
    if (ph && ph !== state.slots.phone) { state.slots.phone = ph; changed.push("phone"); }
  }

  if (changed.length) {
    console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
  }
  return changed;
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

  // loop guard → after 3 tries on same slot, transfer
  if (missing !== "done") {
    const key = missing;
    state.askCounts[key] = (state.askCounts[key] || 0) + 1;
    if (state.askCounts[key] >= 3) {
      await transferOwner(ws, "Let me transfer you to the owner to finish this up.");
      return;
    }
  }

  if (missing === "service") return say(ws, "What service would you like — a haircut, beard trim, or the combo?");
  if (missing === "datetime") return say(ws, `What date and time would you like for your ${state.slots.service || "appointment"}?`);
  if (missing === "name") return say(ws, "Can I get your first name?");
  if (missing === "phone") return say(ws, "What phone number should I use for confirmations?");
  if (missing === "done") return confirmAndFinalize(ws, state, /*updated*/ false);
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

function whenSpoken(state) {
  const dSpeak = dateToSpeak(state.slots.date);
  const tSpeak = timeToSpeak(state.slots.time);
  const sSpeak = state.slots.service || "appointment";
  const nSpeak = state.slots.name || "";
  return { dSpeak, tSpeak, sSpeak, nSpeak };
}

async function confirmAndFinalize(ws, state, updated) {
  const { dSpeak, tSpeak, sSpeak } = whenSpoken(state);
  const human = `${dSpeak} at ${tSpeak}`;
  console.log(JSON.stringify({ event: "CONFIRM_READY", slots: state.slots, whenSpoken: human }));

  // non-blocking Make create (if provided)
  if (MAKE_CREATE_URL) {
    const payload = {
      Event_Name: sSpeak || "Appointment",
      Start_Time: `${state.slots.date} ${state.slots.time}`,
      End_Time: "", // keep same behavior as before; Make scenario can add +30m
      Customer_Name: state.slots.name || "",
      Customer_Phone: state.slots.phone || "",
      Notes: `Booked by phone agent`
    };
    axios.post(MAKE_CREATE_URL, payload).catch(() => {});
  }

  const line = updated
    ? `Updated — I’ve got a ${sSpeak} on ${human}. I have your number as (${state.slots.phone.slice(0,3)}) ${state.slots.phone.slice(3,6)}-${state.slots.phone.slice(6)}. Anything else I can help with?`
    : `Great — I’ve booked a ${sSpeak} on ${human}. I have your number as (${state.slots.phone.slice(0,3)}) ${state.slots.phone.slice(3,6)}-${state.slots.phone.slice(6)}. You’re all set. Anything else I can help with?`;

  // mark done & snapshot
  state.phase = "done";
  state.lastConfirmed = { ...state.slots };
  state.askCounts = { service:0, datetime:0, name:0, phone:0 };
  await say(ws, line);
}

async function transferOwner(ws, line = "I’m not sure about that, let me transfer you to the owner. Please hold.") {
  await say(ws, line);
  try { ws.close(); } catch {}
}

/* ----------------- Classify + handle ----------------- */
async function classifyAndHandle(ws, state, transcript) {
  const systemPrompt = `
Return STRICT JSON:
{
 "intent": "FAQ" | "BOOK" | "TRANSFER" | "SMALLTALK" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",  // "haircut" | "beard trim" | "combo" or phrase
 "date": "",     // "today" | "tomorrow" | weekday | "YYYY-MM-DD"
 "time": "",     // "3 PM" | "15:00"
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

  // Merge & detect changes
  const changedFields = mergeSlots(state, parsed);

  // If we already confirmed and any slot changed → re-confirm
  if (state.phase === "done" && changedFields.length > 0) {
    await confirmAndFinalize(ws, state, /*updated*/ true);
    return;
  }

  // FAQ path
  if (parsed.intent === "FAQ") {
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    if (!answer) answer = "Happy to help. What else can I answer?";

    // track CTA for “Yes, please”
    state.awaitingBookYes = true;

    if (state.phase === "booking") {
      await say(ws, answer);
      await maybeResume(ws, state);
    } else {
      await say(ws, `${answer} Would you like to book an appointment?`);
    }
    // optional Make FAQ ping (non-blocking)
    if (MAKE_FAQ_URL && parsed.faq_topic) {
      axios.post(MAKE_FAQ_URL, { intent:"FAQ", topic: parsed.faq_topic }).catch(()=>{});
    }
    return;
  }

  // Explicit transfer
  if (parsed.intent === "TRANSFER") {
    await transferOwner(ws);
    return;
  }

  // Booking path
  if (parsed.intent === "BOOK") {
    state.phase = "booking";
    state.awaitingBookYes = false;
    await askForMissing(ws, state);
    return;
  }

  // “Yes, please” etc after CTA → enter booking
  if (!parsed.intent || parsed.intent === "UNKNOWN" || parsed.intent === "SMALLTALK") {
    const low = transcript.trim().toLowerCase();
    if (state.awaitingBookYes && /^(y(es|ep|eah)|sure|ok|okay|please)\b/.test(low)) {
      state.awaitingBookYes = false;
      state.phase = "booking";
      await askForMissing(ws, state);
      return;
    }

    // If already booked and they ask "is it booked?" → summarize
    if (state.phase === "done" && /\b(book(ed)?|confirm(ed)?|set|scheduled)\b/.test(low)) {
      const { dSpeak, tSpeak, sSpeak } = whenSpoken(state);
      await say(ws, `Yes — you’re booked for a ${sSpeak} on ${dSpeak} at ${tSpeak}.`);
      return;
    }

    // Otherwise: micro-ack and resume if needed
    const fallbackPrompt = `
You are a friendly receptionist. Reply with ONE short, conversational sentence (<= 16 words).
Avoid meta talk; be helpful. Examples: "Sure—what do you need?" / "Got it—how can I help?"
`.trim();
    const nlg = await askGPT(fallbackPrompt, transcript);
    await say(ws, nlg || "Okay—how can I help?");
    await maybeResume(ws, state);
    return;
  }
}

/* ----------------- Twilio WS handlers ----------------- */
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

      // Deepgram
      dg = startDeepgram({
        onFinal: async (text) => {
          try { await classifyAndHandle(ws, ws.__state, text); } catch (e) { 
            console.error("[handle error]", e.message);
            await transferOwner(ws);
          }
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
