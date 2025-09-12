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

if (!OPENAI_API_KEY) console.warn("(!) OPENAI_API_KEY missing");
if (!DEEPGRAM_API_KEY) console.warn("(!) DEEPGRAM_API_KEY missing");
if (!ELEVENLABS_API_KEY) console.warn("(!) ELEVENLABS_API_KEY missing");

const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Twilio sends x-www-form-urlencoded
app.use(bodyParser.json());

app.get("/", (_, res) => res.status(200).send("✅ Old Line Barbershop AI Receptionist running"));

app.post("/twiml", (req, res) => {
  const from = (req.body?.From || "").replace(/\D/g, "");
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME || "localhost:"+PORT}">
          <Parameter name="from" value="${from}"/>
        </Stream>
      </Connect>
    </Response>
  `);
});

const server = app.listen(PORT, () => console.log(`[INFO] Server running on ${PORT}`));
const wss = new WebSocketServer({ server });

/* ------------------------ Utilities ------------------------ */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const ORD = n => {
  const s = ["th","st","nd","rd"], v = n%100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
};
function speakableDate(isoOrWord) {
  if (!isoOrWord) return "";
  if (/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(isoOrWord)) return isoOrWord[0].toUpperCase() + isoOrWord.slice(1).toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrWord)) {
    const d = new Date(isoOrWord+"T12:00:00");
    return `${MONTHS[d.getMonth()]} ${ORD(d.getDate())}`;
  }
  return isoOrWord;
}
function normalizePhone(num) {
  if (!num) return "";
  const d = num.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}
function normalizeService(s) {
  if (!s) return "";
  const t = s.toLowerCase();
  if (/\b(combo|both|haircut\s*(?:\+|and|&)\s*beard)\b/.test(t)) return "combo";
  if (/\bbeard/.test(t)) return "beard trim";
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return "haircut";
  return "";
}
const wantsThisNumber = (t) => /\b(this (?:number|phone)|the number i'm calling from|this phone)\b/i.test(t || "");

/* ------------------------ Deepgram WS ------------------------ */
function startDeepgram({ onFinal }) {
  const url = "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16&sample_rate=8000&channels=1"
    + "&model=nova-2-phonecall&interim_results=true&smart_format=true&language=en-US&endpointing=250";
  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });
  dg.on("open", () => console.log("[Deepgram] ws open"));
  dg.on("message", (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0]; if (!alt) return;
    const text = (alt.transcript || "").trim(); if (!text) return;
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
  u = ~u & 0xff; const sign = u & 0x80; const exponent = (u >> 4) & 0x07; const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << (exponent + 2)) - 0x84 * 4;
  if (sign) sample = -sample;
  return Math.max(-32768, Math.min(32767, sample));
}
function ulawBufferToPCM16LEBuffer(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i * 2);
  return out;
}

/* ------------------------ GPT ------------------------ */
async function askGPT(systemPrompt, userPrompt, response_format = "text") {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.3,
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

/* ------------------------ TTS ------------------------ */
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

/* ------------------------ State & Slot Helpers ------------------------ */
function newState() {
  return {
    phase: "idle",            // idle | booking | confirmed
    awaiting: "",             // which slot we just asked for
    clarifyCount: { service:0, date:0, time:0, name:0, phone:0 },
    lastConfirmHash: "",
    confirmed: false,
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
    if (parsed.date !== state.slots.date) { state.slots.date = parsed.date; changed = true; }
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

  if (changed) console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
}

function nextMissing(state) {
  if (!state.slots.service) return "service";
  if (!state.slots.date && !state.slots.time) return "datetime";
  if (state.slots.date && !state.slots.time) return "time";
  if (!state.slots.date && state.slots.time) return "date";
  if (!state.slots.name) return "name";
  if (!state.slots.phone) return "phone";
  return "done";
}

function buildClarifier(state, missing) {
  const svc = state.slots.service || "appointment";
  if (missing === "service") return "What service would you like — a haircut, beard trim, or the combo?";
  if (missing === "datetime") return `What date and time would you like for your ${svc}?`;
  if (missing === "date") return `Which day works for your ${svc}? (e.g., Monday or September 15th)`;
  if (missing === "time") {
    const dSpoken = speakableDate(state.slots.date);
    return `What time on ${dSpoken} works for your ${svc}?`;
  }
  if (missing === "name") return "Can I get your first name?";
  if (missing === "phone") return "What phone number should I use for confirmations?";
  return "";
}

function confirmIfReady(ws, state) {
  const missing = nextMissing(state);
  if (missing !== "done") return false;
  const whenSpoken = `${speakableDate(state.slots.date)} at ${state.slots.time}`;
  const hash = JSON.stringify(state.slots);
  if (hash === state.lastConfirmHash && state.confirmed) return true; // already confirmed
  state.lastConfirmHash = hash;
  state.confirmed = true;
  state.phase = "confirmed";
  console.log(JSON.stringify({ event: "CONFIRM_READY", slots: state.slots, whenSpoken }));
  say(ws, `Great — I’ve got a ${state.slots.service} for ${state.slots.name} on ${whenSpoken}. I have your number as (${state.slots.phone.slice(0,3)}) ${state.slots.phone.slice(3,6)}-${state.slots.phone.slice(6)}. You’re all set. Anything else I can help with?`);
  return true;
}

function clarifyOrTransfer(ws, state, slot) {
  state.clarifyCount[slot] = (state.clarifyCount[slot] || 0) + 1;
  console.log(JSON.stringify({ event: "CLARIFY", slot, count: state.clarifyCount[slot] }));

  if (state.clarifyCount[slot] >= 3) {
    console.log(JSON.stringify({ event: "FAILSAFE_TRANSFER", slot }));
    say(ws, "Let me transfer you to the owner to finish this up.");
    try { ws.close(); } catch {}
    return;
  }
  let msg = buildClarifier(state, slot);
  // micro-hints
  if (slot === "name" && state.clarifyCount[slot] === 2) msg = "Just your first name is fine.";
  if (slot === "phone" && state.clarifyCount[slot] === 2) msg = "Please say the 10-digit number with area code.";
  if (slot === "time" && state.clarifyCount[slot] === 2) msg = `Please give a time, like “3 PM”.`;
  say(ws, msg);
  state.awaiting = slot;
}

async function bookingAsk(ws, state) {
  const missing = nextMissing(state);
  if (missing === "done") { confirmIfReady(ws, state); return; }
  const q = buildClarifier(state, missing);
  console.log(JSON.stringify({ event: "SLOTS", slots: state.slots, missing }));
  say(ws, q);
  state.awaiting = missing;
}

/* ------------------------ Classify & Handle ------------------------ */
async function classifyAndHandle(ws, state, transcript) {
  // “this number” capture (before GPT) if in booking & phone missing
  if (state.phase === "booking" && nextMissing(state) === "phone" && wantsThisNumber(transcript) && ws.__callerFrom) {
    const before = { ...state.slots };
    state.slots.phone = normalizePhone(ws.__callerFrom);
    console.log(JSON.stringify({ event:"SLOTS_MERGE", before, after: state.slots, via:"callerFrom" }));
    if (!confirmIfReady(ws, state)) await bookingAsk(ws, state);
    return;
  }

  const systemPrompt = `
Return STRICT JSON:
{
 "intent": "FAQ" | "BOOK" | "TRANSFER" | "SMALLTALK" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",   // "haircut" | "beard trim" | "combo" or phrase
 "date": "",      // "today"|"tomorrow"|"Monday"|"YYYY-MM-DD"
 "time": "",      // "3 PM" | "15:00"
 "name": "",
 "phone": "",
 "correction": "" // one of "service|date|time|name|phone" if user corrected it, else ""
}
Rules:
- Detect booking even if mixed with small talk.
- If user says “actually/change/correct ...”, set "correction" field and the new value.
- For FAQs, do NOT start booking unless they ask to book.
- Keep values short; leave blank if unsure.
`.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}

  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));
  const priorMissing = nextMissing(state);

  // Apply corrections first
  if (parsed.correction) {
    const before = { ...state.slots };
    if (parsed.correction === "service") state.slots.service = normalizeService(parsed.service);
    if (parsed.correction === "date") state.slots.date = parsed.date || state.slots.date;
    if (parsed.correction === "time") state.slots.time = parsed.time || state.slots.time;
    if (parsed.correction === "name") state.slots.name = parsed.name || state.slots.name;
    if (parsed.correction === "phone") state.slots.phone = normalizePhone(parsed.phone) || state.slots.phone;
    console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots, via:"correction" }));
    // After a correction, if already confirmed, re-confirm with updated details
    if (state.confirmed) {
      state.confirmed = false; // force a fresh confirmation
      confirmIfReady(ws, state);
      return;
    }
  }

  // Merge non-correction extractions
  mergeSlots(state, parsed);

  // Intent routing
  if (parsed.intent === "FAQ") {
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    if (!answer) answer = "Happy to help. What else can I answer?";

    if (state.phase === "booking") {
      // Answer briefly, then resume single targeted clarifier
      await say(ws, answer);
      await bookingAsk(ws, state);
    } else {
      await say(ws, `${answer} Would you like to book an appointment?`);
    }
    return;
  }

  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
    try { ws.close(); } catch {}
    return;
  }

  if (parsed.intent === "BOOK") {
    state.phase = "booking";
    // If we were already asking something and user gave partial info, switch to the most specific clarifier
    const missing = nextMissing(state);
    // If both date/time missing → ask generic; if only time missing → ask “what time on <date>”
    await bookingAsk(ws, state);
    return;
  }

  // SMALLTALK / UNKNOWN
  if (state.phase === "booking") {
    // Polite + targeted → single line
    const missing = nextMissing(state);
    if (missing !== "done") {
      // brief human ack + clarifier in one message
      let ack = "";
      try {
        const ackSys = `Reply with one short friendly clause only (<=10 words), no questions. Examples: "Totally!", "No worries!", "Sounds good!"`;
        ack = await askGPT(ackSys, transcript);
        if (/\?|[\.\!]\s*$/i.test(ack) === false) ack = (ack || "Got it") + ".";
      } catch { ack = "Got it."; }
      const clarifier = buildClarifier(state, missing);
      await say(ws, `${ack} ${clarifier}`);
      state.awaiting = missing;
      return;
    }
    if (!confirmIfReady(ws, state)) await bookingAsk(ws, state);
    return;
  }

  // Idle + smalltalk: keep it short
  const fallbackPrompt = `
You are a friendly receptionist. Reply with ONE short conversational sentence (<= 14 words), no sales pitch.
Examples: "Sure—what do you need?" / "Happy to help—what can I do for you?"
`.trim();
  const nlg = await askGPT(fallbackPrompt, transcript);
  await say(ws, nlg || "Sure—what do you need?");
}

/* ------------------------ WS ------------------------ */
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
      ws.__callerFrom = ""; // from TwiML Parameter
      const params = msg.start?.customParameters || [];
      for (const p of params) {
        if (p.name === "from") ws.__callerFrom = p.value || "";
      }
      console.log(JSON.stringify({ event: "CALL_START", streamSid: ws.__streamSid, convoId: ws.__convoId }));

      // Start Deepgram
      dg = startDeepgram({
        onFinal: async (text) => {
          try {
            // If we’re waiting for a specific slot and we didn’t get it repeatedly, use clarifier throttle
            const beforeMissing = nextMissing(ws.__state);
            await classifyAndHandle(ws, ws.__state, text);
            const afterMissing = nextMissing(ws.__state);
            // If the same slot is still missing and user answered something unrelated, clarify progressively
            if (ws.__state.phase === "booking" && beforeMissing === afterMissing && beforeMissing !== "done") {
              clarifyOrTransfer(ws, ws.__state, beforeMissing);
            }
          } catch (e) {
            console.error("[handle error]", e.message);
            // graceful fallback
            try { await say(ws, "I’m having trouble. Let me transfer you to the owner to finish this up."); } catch {}
            try { ws.close(); } catch {}
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
