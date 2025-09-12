// server.js — Old Line Barbershop AI Receptionist (Deepgram + GPT + ElevenLabs)
// Minimal diffs: smalltalk+segue, confirm-before-ask, weekday→date, human dates, caller-ID phone, no double prompts, correction re-confirm, transfer failsafe.

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
app.post("/twiml", (req, res) => {
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

// ------------ Utilities -------------
const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const NY_TZ = "America/New_York"; // informational; we’ll use JS Date relative to server UTC consistently

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear(); const mm = String(d.getMonth()+1).padStart(2,"0"); const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}
function addDaysISO(iso, days) {
  const d = new Date(iso); d.setDate(d.getDate()+days);
  const yyyy = d.getFullYear(); const mm = String(d.getMonth()+1).padStart(2,"0"); const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}
function nextWeekdayISO(label) {
  const idx = WEEKDAYS.indexOf(String(label||"").toLowerCase());
  if (idx < 0) return "";
  const now = new Date();
  const todayIdx = now.getDay();
  let delta = idx - todayIdx;
  if (delta <= 0) delta += 7; // next occurrence
  return addDaysISO(todayISO(), delta);
}
function normalizeDate(s) {
  if (!s) return "";
  const t = s.toLowerCase().trim();
  if (t === "today") return todayISO();
  if (t === "tomorrow") return addDaysISO(todayISO(), 1);
  if (WEEKDAYS.includes(t)) return nextWeekdayISO(t);
  // already ISO? keep
  return s;
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
function humanDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const m = months[d.getMonth()];
    const day = d.getDate();
    const suffix = (n)=> (n%10===1 && n%100!==11)?"st":(n%10===2 && n%100!==12)?"nd":(n%10===3 && n%100!==13)?"rd":"th";
    return `${m} ${day}${suffix(day)}`;
  } catch { return iso; }
}
function humanTime(t) {
  if (!t) return t;
  // accept "15:00" or "3PM"
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(t);
  if (!m) return t.toUpperCase();
  let hh = parseInt(m[1],10);
  let mm = m[2] ? m[2] : "00";
  const ap = m[3];
  if (!ap) {
    // assume 24h -> convert
    const apx = hh>=12 ? "PM" : "AM";
    hh = ((hh+11)%12)+1;
    return `${hh}:${mm} ${apx}`.replace(":00 "," ");
  }
  return `${hh}:${mm} ${ap.toUpperCase()}`.replace(":00 "," ");
}
function debounceSameLine(state, text) {
  const now = Date.now();
  if (text && state.lastLine === text && now - (state.lastLineAt||0) < 1500) return true;
  state.lastLine = text; state.lastLineAt = now; return false;
}

// ------------ Deepgram WS -------------
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

// μ-law → PCM16
function ulawByteToPcm16(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << (exponent + 2)) - 0x84 * 4;
  if (sign) sample = -sample;
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}
function ulawBufferToPCM16LEBuffer(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i*2);
  return out;
}

// ------------ GPT -------------
async function askGPT(systemPrompt, userPrompt, asJson=false) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        ...(asJson ? { response_format: { type: "json_object" } } : {})
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return resp.data.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.error("[GPT ERROR]", e.message);
    return "";
  }
}

// ------------ TTS -------------
async function say(ws, text) {
  if (!text) return;
  if (debounceSameLine(ws.__state, text)) return; // prevent duplicate lines
  const streamSid = ws.__streamSid; if (!streamSid) return;

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
    resp.data.on("end", () => {
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }));
    });
  } catch (e) {
    console.error("[TTS ERROR]", e.message);
  }
}

// ------------ State / Slots -------------
function newState() {
  return {
    phase: "idle",                   // idle | booking | confirming | done
    lastLine: "", lastLineAt: 0,
    lastAskedSlot: "",              // for no-double-ask
    clarify: { service:0, date:0, time:0, name:0, phone:0 },
    slots: { service:"", date:"", time:"", name:"", phone:"" }
  };
}
function mergeSlots(state, parsed) {
  const before = { ...state.slots };
  let changed = false;

  if (parsed.service) {
    const svc = normalizeService(parsed.service);
    if (svc && svc !== state.slots.service) { state.slots.service = svc; changed = true; state.clarify.service = 0; }
  }
  if (parsed.date) {
    const nd = normalizeDate(parsed.date);
    if (nd && nd !== state.slots.date) { state.slots.date = nd; changed = true; state.clarify.date = 0; }
  }
  if (parsed.time) {
    if (parsed.time !== state.slots.time) { state.slots.time = parsed.time; changed = true; state.clarify.time = 0; }
  }
  if (parsed.name) {
    if (parsed.name !== state.slots.name) { state.slots.name = parsed.name; changed = true; state.clarify.name = 0; }
  }
  if (parsed.phone) {
    const ph = normalizePhone(parsed.phone);
    if (ph && ph !== state.slots.phone) { state.slots.phone = ph; changed = true; state.clarify.phone = 0; }
  }

  if (changed) console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
}
function nextMissing(state) {
  if (!state.slots.service) return "service";
  if (!state.slots.date || !state.slots.time) return "datetime";
  if (!state.slots.name) return "name";
  if (!state.slots.phone) return "phone";
  return "done";
}
function buildQuestionFor(slot, state) {
  if (slot === "service") return "What service would you like — a haircut, beard trim, or the combo?";
  if (slot === "datetime") return `What date and time would you like for your ${state.slots.service || "appointment"}?`;
  if (slot === "name") return "Can I get your first name?";
  if (slot === "phone") return "What phone number should I use for confirmations?";
  return "";
}
function summarizeForConfirm(state) {
  const d = humanDate(state.slots.date);
  const t = humanTime(state.slots.time);
  const line = `Great — I’ve got a ${state.slots.service} for ${state.slots.name} on ${d} at ${t}. I have your number as (${state.slots.phone.slice(0,3)}) ${state.slots.phone.slice(3,6)}-${state.slots.phone.slice(6)}. You’re all set. Anything else I can help with?`;
  console.log(JSON.stringify({ event:"CONFIRM_READY", slots: state.slots, whenSpoken:`${d} at ${t}` }));
  return line;
}

// ------------ Classify & Handle -------------
async function classifyAndHandle(ws, state, transcript) {
  // if user says “this one / same number” while missing phone, try callerID
  if (!state.slots.phone && /^(this (one|number)|same number|use this)$/i.test(transcript.trim()) && ws.__callerPhone) {
    state.slots.phone = ws.__callerPhone;
    console.log(JSON.stringify({ event:"SLOTS_MERGE", before:"", after: state.slots, via:"callerID" }));
  }

  const systemPrompt = `
Return STRICT JSON with keys:
{
 "intent": "FAQ" | "BOOK" | "TRANSFER" | "SMALLTALK" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",    // user-stated, e.g., "haircut" | "beard trim" | "combo"
 "date": "",       // "today" | "tomorrow" | weekday | "YYYY-MM-DD"
 "time": "",       // "3 PM" | "15:00"
 "name": "",
 "phone": ""
}
Rules:
- If they ask availability (e.g., "can I book Monday 3 PM?"), set intent "BOOK" and include date/time.
- If they change service, update "service".
- If asking only about info (hours/prices/services/location), intent "FAQ".
- Keep values brief; leave blank if unsure.
  `.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, true);
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event:"GPT_CLASSIFY", transcript, parsed }));

  // Merge new info
  mergeSlots(state, parsed);

  // If we were "done" and user corrects a slot later → re-confirm
  const wasDone = (state.phase === "done");

  // Branch on intent
  if (parsed.intent === "FAQ") {
    const topic = (parsed.faq_topic || "").toUpperCase();
    let answer = "";
    if (topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    else if (topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    else answer = "Happy to help. What else can I answer?";

    if (state.phase === "booking" || state.phase === "confirming") {
      await say(ws, answer);
      // smooth resume
      const missing = nextMissing(state);
      if (missing !== "done") await say(ws, buildQuestionFor(missing, state));
      else {
        state.phase = "done";
        await say(ws, summarizeForConfirm(state));
      }
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

  // If user started / is in booking
  if (parsed.intent === "BOOK" || state.phase === "booking" || state.phase === "confirming" || wasDone) {
    state.phase = (nextMissing(state) === "done") ? "confirming" : "booking";

    // Small talk interjections during booking → human ack + segue back
    if (parsed.intent === "SMALLTALK") {
      const ackPrompt = `
You are a friendly receptionist. Respond to the user's line with ONE short natural sentence (<= 14 words).
Keep it relevant (e.g., "I know, right?"), then STOP. Do not ask a question.
      `.trim();
      const ack = (await askGPT(ackPrompt, transcript)) || "Sure!";
      const missing = nextMissing(state);
      if (missing !== "done") {
        const q = buildQuestionFor(missing, state);
        await say(ws, `${ack} ${q}`);
      } else {
        state.phase = "done";
        await say(ws, summarizeForConfirm(state));
      }
      return;
    }

    // All slots filled → confirmation (or re-confirm if they changed something after "done")
    if (nextMissing(state) === "done") {
      state.phase = "done";
      await say(ws, summarizeForConfirm(state));
      return;
    }

    // Not done yet → confirm-before-ask pattern:
    const missing = nextMissing(state);
    console.log(JSON.stringify({ event:"SLOTS", slots: state.slots, missing }));

    // If a slot was just updated and next is asked, avoid double-ask
    if (state.lastAskedSlot && state.lastAskedSlot === missing) {
      // don’t immediately re-ask the same thing; soft clarify
      state.clarify[missing] = (state.clarify[missing] || 0) + 1;
      if (state.clarify[missing] >= 3) {
        console.log(JSON.stringify({ event:"FAILSAFE_TRANSFER", slot: missing }));
        await say(ws, "Let me transfer you to the owner to finish this up.");
        try { ws.close(); } catch {}
        return;
      }
      await say(ws, missing === "name" ? "Just your first name is fine." :
                 missing === "phone" ? "What’s the best number to text the confirmation to?" :
                 buildQuestionFor(missing, state));
      return;
    }

    // First time asking for this slot in current turn
    state.lastAskedSlot = missing;
    await say(ws, buildQuestionFor(missing, state));
    return;
  }

  // SMALLTALK / UNKNOWN outside booking → natural line, optional CTA
  if (parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
    const smalltalkPrompt = `
You are a friendly receptionist. Respond to the user with ONE short natural sentence (<= 16 words).
Avoid generic "Got it." Make it specific to what they said. No second sentence.
    `.trim();
    const line = (await askGPT(smalltalkPrompt, transcript)) || "Sure—what do you need?";
    await say(ws, line);
    return;
  }
}

// ------------ WS -------------
wss.on("connection", (ws) => {
  let dg = null;
  let pendingULaw = [];
  const BATCH_FRAMES = 5;

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start?.streamSid;
      ws.__convoId = uuidv4();
      ws.__state = newState();

      // capture caller ID if Twilio passes it
      const from = msg.start?.from || msg.start?.customParameters?.from;
      ws.__callerPhone = normalizePhone(from || "");
      console.log(JSON.stringify({ event: "CALL_START", streamSid: ws.__streamSid, convoId: ws.__convoId }));

      dg = startDeepgram({
        onFinal: async (text) => {
          try { await classifyAndHandle(ws, ws.__state, text); }
          catch (e) {
            console.error("[handle error]", e.message);
            await say(ws, "I’m having trouble hearing you—let me transfer you to the owner to finish this up.");
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
        try { dg.sendPCM16LE(pcm16le); } catch {}
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
