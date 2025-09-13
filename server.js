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
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL; // optional
const MAKE_FAQ_URL = process.env.MAKE_FAQ_URL;       // optional

if (!OPENAI_API_KEY) console.warn("(!) OPENAI_API_KEY missing");
if (!DEEPGRAM_API_KEY) console.warn("(!) DEEPGRAM_API_KEY missing");
if (!ELEVENLABS_API_KEY) console.warn("(!) ELEVENLABS_API_KEY missing");

const app = express();
app.use(bodyParser.json());

app.get("/", (_, res) => res.status(200).send("✅ Old Line Barbershop AI Receptionist running"));

/**
 * TwiML: pass caller number & CallSid as custom parameters so we can honor
 * “this number” during phone capture and for logging.
 */
app.post("/twiml", (req, res) => {
  res.set("Content-Type", "text/xml");
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${host}">
          <Parameter name="from" value="{{From}}"/>
          <Parameter name="callSid" value="{{CallSid}}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim());
});

const server = app.listen(PORT, () => console.log(`[INFO] Server running on ${PORT}`));
const wss = new WebSocketServer({ server });

/* ----------------------- Utilities ----------------------- */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function nowNY() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function addDaysISO(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function weekdayToISO(weekday) {
  const map = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const key = (weekday || "").toLowerCase();
  if (!(key in map)) return "";
  const today = new Date();
  const todayIdx = today.getDay();
  let target = map[key];
  let delta = target - todayIdx;
  if (delta <= 0) delta += 7;
  return addDaysISO(nowNY(), delta);
}
function normalizeDate(d) {
  if (!d) return "";
  const t = d.toLowerCase();
  if (t === "today") return nowNY();
  if (t === "tomorrow") return addDaysISO(nowNY(), 1);
  const w = weekdayToISO(t);
  if (w) return w;
  return d; // allow YYYY-MM-DD or raw
}
function normalizeService(s) {
  if (!s) return "";
  const t = s.toLowerCase();
  if (/\b(combo|both|haircut\s*(?:\+|and|&)\s*beard)\b/.test(t)) return "combo";
  if (/\bbeard/.test(t)) return "beard trim";
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return "haircut";
  return "";
}
function stripUSCountry(digits) {
  // "+12232769891" -> "2232769891", "12232769891" -> "2232769891"
  const dd = digits.replace(/\D/g, "");
  if (dd.length === 11 && dd.startsWith("1")) return dd.slice(1);
  return dd;
}
function normalizePhone(num) {
  if (!num) return "";
  const d = stripUSCountry(num);
  return d.length >= 10 ? d.slice(-10) : "";
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function formatDateSpoken(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  return `${MONTHS[mm - 1]} ${ordinal(dd)}`;
}
function to12h(t) {
  if (!t) return "";
  if (/am|pm/i.test(t)) {
    const up = t.toUpperCase().replace(/\s+/g, " ").trim();
    return up.includes("AM") || up.includes("PM") ? up : up + " PM";
  }
  const m = /^(\d{1,2}):?(\d{2})$/.exec(t);
  if (!m) return t;
  let hh = Number(m[1]);
  const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM";
  if (hh === 0) hh = 12;
  if (hh > 12) hh -= 12;
  return `${hh}:${mm}`.replace(":00","") + ` ${ampm}`;
}
function humanWhen(dateISO, timeStr) {
  const dSpoken = formatDateSpoken(dateISO);
  const tSpoken = to12h(timeStr);
  return tSpoken ? `${dSpoken} at ${tSpoken}` : dSpoken;
}
function formatPhoneSpoken(d10) {
  const d = normalizePhone(d10);
  if (d.length !== 10) return d;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

/* ----------------------- Deepgram WS ----------------------- */
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

/* ----------------------- GPT ----------------------- */
async function askGPT(systemPrompt, userPrompt, response_format = "text") {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.35,
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

/* ----------------------- TTS ----------------------- */
async function say(ws, text) {
  if (!text) return;
  const streamSid = ws.__streamSid;
  if (!streamSid) return;

  console.log(JSON.stringify({ event: "BOT_SAY", reply: text }));

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn('{"ts":"'+new Date().toISOString()+'","level":"WARN","msg":"No ElevenLabs credentials, skipping TTS"}');
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

/* ----------------------- State & Slots ----------------------- */
function newState() {
  return {
    phase: "idle", // idle | booking | confirmed
    slots: { service: "", date: "", time: "", name: "", phone: "" },
    lastConfirmSnapshot: "",
    clarify: { service:0, date:0, time:0, name:0, phone:0 },
    pendingAskSlot: null, // the slot we are currently expecting
    postConfirmOffered: false // whether we've already asked "Anything else?"
  };
}

/** Merge parsed into state; return {changed:boolean, changedKeys:string[]} */
function mergeSlots(state, parsed) {
  const before = { ...state.slots };
  let changed = false;
  const changedKeys = [];

  if (parsed.service) {
    const svc = normalizeService(parsed.service);
    if (svc && svc !== state.slots.service) { state.slots.service = svc; changed = true; changedKeys.push("service"); }
  }
  if (parsed.date) {
    const nd = normalizeDate(parsed.date);
    if (nd && nd !== state.slots.date) { state.slots.date = nd; changed = true; changedKeys.push("date"); }
  }
  if (parsed.time) {
    const t = parsed.time.trim();
    if (t && t !== state.slots.time) { state.slots.time = t; changed = true; changedKeys.push("time"); }
  }
  if (parsed.name) {
    if (parsed.name !== state.slots.name) { state.slots.name = parsed.name; changed = true; changedKeys.push("name"); }
  }
  if (parsed.phone) {
    const ph = normalizePhone(parsed.phone);
    if (ph && ph !== state.slots.phone) { state.slots.phone = ph; changed = true; changedKeys.push("phone"); }
  }

  if (changed) {
    console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
  }
  return { changed, changedKeys };
}
function nextMissing(state) {
  const s = state.slots;
  if (!s.service) return "service";
  if (!s.date && !s.time) return "datetime";
  if (!s.date) return "date";
  if (!s.time) return "time";
  if (!s.name) return "name";
  if (!s.phone) return "phone";
  return "done";
}

async function askForMissing(ws, state) {
  const s = state.slots;
  const missing = nextMissing(state);
  console.log(JSON.stringify({ event: "SLOTS", slots: s, missing }));
  state.pendingAskSlot = missing;

  if (missing === "service") return say(ws, "What service would you like — a haircut, beard trim, or the combo?");
  if (missing === "datetime") return say(ws, `What date and time would you like for your ${s.service || "appointment"}?`);
  if (missing === "date") return say(ws, `What date works for your ${s.service}${s.time ? ` at ${to12h(s.time)}` : ""}?`);
  if (missing === "time") return say(ws, `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`);
  if (missing === "name") return say(ws, "Can I get your first name?");
  if (missing === "phone") return say(ws, "What phone number should I use for confirmations?");
  if (missing === "done") return triggerConfirm(ws, state);
}

function confirmSnapshot(slots) { return JSON.stringify(slots); }

async function triggerConfirm(ws, state, { updated=false } = {}) {
  const s = state.slots;
  const when = humanWhen(s.date, s.time);
  console.log(JSON.stringify({ event: "CONFIRM_READY", slots: s, whenSpoken: when }));

  const snap = confirmSnapshot(s);
  if (snap === state.lastConfirmSnapshot && state.phase === "confirmed") {
    return; // avoid repeat
  }
  state.phase = "confirmed";
  state.lastConfirmSnapshot = snap;
  state.pendingAskSlot = null;
  state.postConfirmOffered = false; // allow one "anything else?" after confirm

  const line = updated
    ? `Updated — I’ve got a ${s.service} for ${s.name} on ${when}. I have your number as ${formatPhoneSpoken(s.phone)}. You’re all set. Anything else I can help with?`
    : `Great — I’ve got a ${s.service} for ${s.name} on ${when}. I have your number as ${formatPhoneSpoken(s.phone)}. You’re all set. Anything else I can help with?`;

  await say(ws, line);
}

/* ----------- Clarification helpers (target the slot we just asked) ----------- */
function clarifyLine(slot, count, state) {
  const bySlot = {
    service: [
      "Just to confirm—haircut, beard trim, or the combo?",
      "Which service would you like—haircut, beard trim, or combo?",
    ],
    datetime: [
      "What date and time should I put down?",
      "Which date and time work best for you?",
    ],
    date: [
      `What date works for your ${state.slots.service}?`,
      "What date should I book?",
    ],
    time: [
      `What time on ${formatDateSpoken(state.slots.date)} works?`,
      "What time should I put down?",
    ],
    name: [
      "Just your first name is fine.",
      "What’s your first name?",
    ],
    phone: [
      "What number should I text the confirmation to?",
      "Could you give me the 10-digit phone number to confirm?",
    ]
  };
  const arr = bySlot[slot] || ["Could you clarify that for me?"];
  return arr[Math.min(count, arr.length - 1)];
}

/* ----------------------- Classify & Handle ----------------------- */
async function classifyAndHandle(ws, state, transcript) {
  // Explicit-only Caller ID: only set from caller if they say "this/my number/phone"
  if (!state.slots.phone && ws.__callerFrom && /\b(this|my)\s+(phone|number)\b/i.test(transcript)) {
    const fromDigits = normalizePhone(ws.__callerFrom);
    if (fromDigits) {
      const before = { ...state.slots };
      state.slots.phone = fromDigits;
      console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots, via: "callerFrom" }));
    }
  }

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
- Detect booking even if mixed with smalltalk.
- If user changes service/date/time/name/phone, include only the new value.
- If the user says "this number", leave phone empty (we fill it from caller ID).
- Keep values short; leave blank if unsure.
`.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  const beforeMissing = nextMissing(state);
  const { changed, changedKeys } = mergeSlots(state, parsed);

  // After confirmation: if they explicitly ask to BOOK again, start a fresh booking
  if (state.phase === "confirmed" && parsed.intent === "BOOK") {
    state.slots = { service: "", date: "", time: "", name: "", phone: "" };
    state.phase = "booking";
    state.lastConfirmSnapshot = "";
    state.pendingAskSlot = null;
    return askForMissing(ws, state);
  }

  // If info changed after confirmation, re-confirm or resume asking
  if (state.phase === "confirmed" && changed) {
    const missing = nextMissing(state);
    if (missing === "done") {
      return triggerConfirm(ws, state, { updated: true });
    } else {
      state.phase = "booking";
      return askForMissing(ws, state);
    }
  }

  // FAQ handling
  if (parsed.intent === "FAQ") {
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    if (!answer) answer = "Happy to help. What else can I answer?";

    if (state.phase === "booking") {
      await say(ws, answer);
      return askForMissing(ws, state);
    } else if (state.phase === "confirmed") {
      // No re-pitch after confirmation; just one “anything else?” once
      if (!state.postConfirmOffered) {
        state.postConfirmOffered = true;
        return say(ws, `${answer} Anything else I can help with today?`);
      } else {
        return say(ws, answer);
      }
    } else {
      // idle path: include soft CTA
      return say(ws, `${answer} Would you like to book an appointment?`);
    }
  }

  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
    try { ws.close(); } catch {}
    return;
  }

  // BOOK path or mid-booking
  if (parsed.intent === "BOOK" || state.phase === "booking" || beforeMissing !== "done") {
    state.phase = "booking";

    const missingNow = nextMissing(state);
    // If we were missing both date & time but user gave one of them, immediately target the other
    if (beforeMissing === "datetime" && (changedKeys.includes("date") || changedKeys.includes("time"))) {
      return askForMissing(ws, state); // will target the remaining one
    }

    // If the user provided exactly the missing item, ask next missing (direct, no fluff)
    if (changed && changedKeys.length === 1 && changedKeys[0] === missingNow) {
      return askForMissing(ws, state);
    }

    // Clarify if we previously asked for a slot and they didn't provide it
    if (state.pendingAskSlot && nextMissing(state) === state.pendingAskSlot && !changedKeys.includes(state.pendingAskSlot)) {
      state.clarify[state.pendingAskSlot] = (state.clarify[state.pendingAskSlot] || 0) + 1;
      const tries = state.clarify[state.pendingAskSlot];
      if (tries >= 3) {
        console.log(JSON.stringify({ event: "FAILSAFE_TRANSFER", slot: state.pendingAskSlot }));
        await say(ws, "Let me transfer you to the owner to finish this up.");
        try { ws.close(); } catch {}
        return;
      }
      console.log(JSON.stringify({ event: "CLARIFY", slot: state.pendingAskSlot, count: tries }));
      return say(ws, clarifyLine(state.pendingAskSlot, tries - 1, state));
    }

    // Normal targeted ask
    return askForMissing(ws, state);
  }

  // SMALLTALK/UNKNOWN outside booking
  if (parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
    if (state.phase === "confirmed") {
      // polite, no re-pitch
      if (!state.postConfirmOffered) {
        state.postConfirmOffered = true;
        return say(ws, "Happy to help! Anything else I can assist you with today?");
      }
      return say(ws, "Happy to help!");
    }
    const fallbackPrompt = `
You are a friendly receptionist. Reply with ONE short, conversational sentence (<= 14 words). No follow-up questions.
`.trim();
    const nlg = await askGPT(fallbackPrompt, transcript);
    return say(ws, nlg || "Sure—how can I help?");
  }
}

/* ----------------------- WS wiring ----------------------- */
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
      ws.__callerFrom = msg.start?.customParameters?.from || ""; // "+1XXXXXXXXXX"
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
