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
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL || "";
const MAKE_FAQ_URL = process.env.MAKE_FAQ_URL || "";

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
  // Use last 10 digits if 10+ provided
  const ten = d.length >= 10 ? d.slice(-10) : "";
  return ten;
}
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function formatDateSpoken(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
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
  return `${String(hh).replace(":00","")} ${ampm}`.replace(" ", mm === "00" ? " " : `:${mm} `);
}
function humanWhen(dateISO, timeStr) {
  const dSpoken = formatDateSpoken(dateISO);
  const tSpoken = to12h(timeStr);
  return tSpoken ? `${dSpoken} at ${tSpoken}` : dSpoken;
}

/* END phrase detector — explicit only */
const END_RE = /\b(?:goodbye|bye|that'?s it|that is it|nothing else|we(?:'| a)re done|end (?:call|this)|hang ?up|no thanks(?:,? that'?s (?:it|all))?)\b/i;

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
    bookingLock: false,
    lastAskKey: "",
    lastAskAt: 0,
    // NEW: wrap-up silence timer
    wrapUpTimer: null,
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

  // avoid repeating exact same ask within 1.2s
  const key = `ask:${missing}:${s.service}:${s.date}:${s.time}:${s.name}:${s.phone}`;
  const now = Date.now();
  if (state.lastAskKey === key && (now - state.lastAskAt) < 1200) return;
  state.lastAskKey = key;
  state.lastAskAt = now;

  if (missing === "service")
    return say(ws, "Which service would you like — haircut, beard trim, or combo?");

  if (missing === "datetime") {
    if (s.date && !s.time) return say(ws, `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`);
    if (!s.date && s.time) return say(ws, `What day works for your ${s.service} at ${to12h(s.time)}?`);
    return say(ws, `What date and time would you like for your ${s.service || "appointment"}?`);
  }

  if (missing === "date")
    return say(ws, `What date works for your ${s.service}${s.time ? ` at ${to12h(s.time)}` : ""}?`);

  if (missing === "time")
    return say(ws, `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`);

  if (missing === "name")
    return say(ws, "Can I get your first name?");

  if (missing === "phone")
    return say(ws, "What phone number should I use for confirmations?");

  if (missing === "done")
    return triggerConfirm(ws, state);
}

function confirmSnapshot(slots) { return JSON.stringify(slots); }

/* --- Graceful hangup helper: ensures goodbye line fully plays --- */
async function gracefulHangup(ws) {
  await say(ws, "Thanks for calling Old Line Barbershop, have a great day!");
  setTimeout(() => {
    try { ws.close(); } catch {}
  }, 5000); // prevent cutoff: give TTS + Twilio time to play out
}

/* Arm / clear wrap-up silence detection */
function armWrapUpSilence(ws, state, ms = 7000) {
  if (state.wrapUpTimer) { clearTimeout(state.wrapUpTimer); state.wrapUpTimer = null; }
  state.wrapUpTimer = setTimeout(() => {
    // No speech after wrap-up — end gracefully.
    gracefulHangup(ws);
  }, ms);
}
function clearWrapUpSilence(state) {
  if (state.wrapUpTimer) { clearTimeout(state.wrapUpTimer); state.wrapUpTimer = null; }
}

async function triggerConfirm(ws, state, { updated=false } = {}) {
  const s = state.slots;
  const when = humanWhen(s.date, s.time);
  console.log(JSON.stringify({ event: "CONFIRM_READY", slots: s, whenSpoken: when }));

  const snap = confirmSnapshot(s);
  if (snap === state.lastConfirmSnapshot && state.phase === "confirmed") return;

  state.phase = "confirmed";
  state.lastConfirmSnapshot = snap;

  const last4 = s.phone ? s.phone.slice(-4) : "";
  const numLine = last4 ? ` I have your number ending in ${last4}.` : "";

  const line = updated
    ? `Updated — I’ve got a ${s.service} for ${s.name} on ${when}.${numLine} You’re all set. Anything else I can help with?`
    : `Great — I’ve got a ${s.service} for ${s.name} on ${when}.${numLine} You’re all set. Anything else I can help with?`;

  await say(ws, line);
  // Arm silence-based wrap-up ONLY after we ask the wrap-up question
  armWrapUpSilence(ws, state, 7000);
}

/* ----------------------- Classify & Handle ----------------------- */
async function classifyAndHandle(ws, state, transcript) {
  // Any user speech clears wrap-up silence timer
  clearWrapUpSilence(state);

  // “this/my number” -> use caller ID (left as-is per your request)
  if (!state.slots.phone && ws.__callerFrom && /\b(this|my)\s+(number|phone)\b/i.test(transcript)) {
    const filled = normalizePhone(ws.__callerFrom);
    if (filled) {
      const before = { ...state.slots };
      state.slots.phone = filled;
      console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots, via: "callerFrom" }));
    }
  }

  const systemPrompt = `
Return STRICT JSON:
{
 "intent": "FAQ" | "BOOK" | "DECLINE_BOOK" | "TRANSFER" | "SMALLTALK" | "END" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",  // "haircut" | "beard trim" | "combo" or phrase
 "date": "",     // "today" | "tomorrow" | weekday | "YYYY-MM-DD"
 "time": "",     // "3 PM" | "15:00"
 "name": "",
 "phone": ""
}
Rules:
- Detect BOOK only when user asks to schedule/book/reschedule/cancel OR provides date/time details.
- "END" ONLY for explicit closing phrases: "goodbye", "bye", "that's it", "nothing else", "hang up", "end call".
  DO NOT set "END" for "I'm good", "I'm fine", "I'm okay".
- If user changes service/date/time/name/phone, include only the new value.
- If the user says "this number", leave phone blank (server fills from caller ID).
- Keep values minimal; leave blank if unsure.
`.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  // Local safety: force END only on explicit phrases, never on "I'm good"
  if (!parsed.intent || parsed.intent === "UNKNOWN") {
    if (END_RE.test(transcript)) parsed.intent = "END";
  }

  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  const prevPhase = state.phase;
  const { changed, changedKeys } = mergeSlots(state, parsed);

  // Acknowledge slot changes during booking
  if (changed && (state.phase === "booking" || parsed.intent === "BOOK")) {
    const acks = [];
    for (const k of changedKeys) {
      if (k === "service") acks.push(`Got it: ${state.slots.service}.`);
      if (k === "date") acks.push(`Okay: ${formatDateSpoken(state.slots.date)}.`);
      if (k === "time") acks.push(`Noted: ${to12h(state.slots.time)}.`);
      if (k === "name") acks.push(`Thanks, ${state.slots.name}.`);
      if (k === "phone") acks.push(`Thanks. I’ve saved your number.`);
    }
    if (acks.length) await say(ws, acks.join(" "));
  }

  // Declined booking (outside any rigid booking path)
  if (parsed.intent === "DECLINE_BOOK") {
    state.phase = "idle";
    return say(ws, "No problem. What else can I help with?");
  }

  // END: explicit goodbye-type phrases
  if (parsed.intent === "END") {
    return gracefulHangup(ws);
  }

  // FAQs
  if (parsed.intent === "FAQ") {
    let answer = "";
    try {
      if (MAKE_FAQ_URL) {
        await axios.post(MAKE_FAQ_URL, { topic: parsed.faq_topic, service: parsed.service || state.slots.service || "" });
      }
    } catch {}

    const priceTable = { "haircut": "thirty dollars", "beard trim": "fifteen dollars", "combo": "forty dollars" };

    if (parsed.faq_topic === "HOURS") {
      answer = "We’re open Monday to Friday, 9 AM to 5 PM. Closed weekends.";
    } else if (parsed.faq_topic === "PRICES") {
      const svc = normalizeService(parsed.service || state.slots.service);
      if (svc && priceTable[svc]) {
        answer = `${svc} is ${priceTable[svc]}.`;
      } else {
        answer = "Haircut is thirty dollars, beard trim is fifteen, and the combo is forty.";
      }
    } else if (parsed.faq_topic === "SERVICES") {
      answer = "We offer haircuts, beard trims, and the combo.";
    } else if (parsed.faq_topic === "LOCATION") {
      answer = "We’re at 123 Blueberry Lane.";
    } else {
      answer = "Happy to help. What else can I answer?";
    }

    if (state.phase === "booking") {
      await say(ws, answer);
      return askForMissing(ws, state);
    }
    if (state.phase === "confirmed") {
      // Post-confirm: answer, then re-arm wrap-up silence
      await say(ws, answer);
      await say(ws, "Anything else I can help with?");
      armWrapUpSilence(ws, state, 7000);
      return;
    }
    // Idle: lightly offer to book
    return say(ws, `${answer} Would you like to book an appointment?`);
  }

  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that. Let me transfer you. Please hold.");
    try { ws.close(); } catch {}
    return;
  }

  // Booking path: only enter if asked to book OR already in booking
  if (parsed.intent === "BOOK" || state.phase === "booking") {
    if (state.phase !== "booking") state.phase = "booking";

    const missing = nextMissing(state);
    if (missing === "done") return triggerConfirm(ws, state);

    // If caller gave exactly the missing piece, move to the next ask
    if (changed && changedKeys.length === 1 && changedKeys[0] === missing) {
      return askForMissing(ws, state);
    }

    // Smalltalk/Unknown during booking: brief bridge + precise ask
    if (parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
      const targetAsk = {
        "service": "Which service would you like — haircut, beard trim, or combo?",
        "datetime": `What date and time would you like for your ${state.slots.service || "appointment"}?`,
        "date": `What date works for your ${state.slots.service}${state.slots.time ? ` at ${to12h(state.slots.time)}` : ""}?`,
        "time": `What time on ${formatDateSpoken(state.slots.date)} works for your ${state.slots.service}?`,
        "name": "Can I get your first name?",
        "phone": "What phone number should I use for confirmations?"
      }[missing];

      const bridgePrompt = `
Reply with one short, natural sentence (<=12 words) acknowledging the remark.
Do NOT ask open-ended questions. We append the booking question separately.
Examples: "Totally!", "Got it.", "No worries.", "Sounds good."
`.trim();

      const bridge = (await askGPT(bridgePrompt, transcript)) || "Sure.";
      return say(ws, `${bridge} ${targetAsk}`);
    }

    return askForMissing(ws, state);
  }

  // SMALLTALK / UNKNOWN outside booking — short, no follow-up
  if (parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
    // Stay idle. Do not auto-start booking.
    const fallbackPrompt = `
Reply with one short, casual sentence (<=12 words). No follow-up questions.
`.trim();
    const nlg = await askGPT(fallbackPrompt, transcript);
    return say(ws, nlg || "How can I help?");
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
    try { ws.__state && clearWrapUpSilence(ws.__state); } catch {}
    try { dg?.close(); } catch {}
    console.log("[INFO] WS closed", { convoId: ws.__convoId });
  });
});
