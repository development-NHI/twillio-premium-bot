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
  return `${`${hh}:${mm}`.replace(":00","")} ${ampm}`;
}
function humanWhen(dateISO, timeStr) {
  const dSpoken = formatDateSpoken(dateISO);
  const tSpoken = to12h(timeStr);
  return tSpoken ? `${dSpoken} at ${tSpoken}` : dSpoken;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

/* ----------------------- Timers: silence & goodbye ----------------------- */

function clearQuestionTimers(ws) {
  if (ws.__questionSilenceTimer) { clearTimeout(ws.__questionSilenceTimer); ws.__questionSilenceTimer = null; }
  if (ws.__questionFinalTimer)   { clearTimeout(ws.__questionFinalTimer);   ws.__questionFinalTimer   = null; }
  ws.__questionRetried = false;
  ws.__lastAskText = "";
}

async function sayAndHangUp(ws, msg) {
  try {
    await say(ws, msg);
    await sleep(8000); // let audio fully play out (8 seconds)
    try { ws.close(); } catch {}
  } catch {}
}

/**
 * Arms a silence handler for any question the bot just asked.
 * - After 25s: if no reply, say "Sorry, I didn’t catch that — could you repeat?" + same question (one time).
 * - Then arm 25s: if still no reply, say goodbye and hang up.
 */
function armQuestionSilence(ws, questionText) {
  clearQuestionTimers(ws);
  ws.__lastAskText = questionText;
  ws.__questionRetried = false;

  ws.__questionSilenceTimer = setTimeout(async () => {
    if (ws.__questionRetried) return;
    ws.__questionRetried = true;
    await say(ws, `Sorry, I didn’t catch that — could you repeat? ${questionText}`);
    // After retry, arm final goodbye if still nothing
    ws.__questionFinalTimer = setTimeout(async () => {
      await sayAndHangUp(ws, "Thanks for calling Old Line Barbershop, have a great day!");
    }, 25000); // <-- was 7000, now 25s
  }, 25000); // <-- was 5000, now 25s
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
    lastAskAt: 0
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

  let line = "";
  if (missing === "service") {
    line = "Which service would you like — haircut, beard trim, or combo?";
  } else if (missing === "datetime") {
    if (s.date && !s.time) line = `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`;
    else if (!s.date && s.time) line = `What day works for your ${s.service} at ${to12h(s.time)}?`;
    else line = `What date and time would you like for your ${s.service || "appointment"}?`;
  } else if (missing === "date") {
    line = `What date works for your ${s.service}${s.time ? ` at ${to12h(s.time)}` : ""}?`;
  } else if (missing === "time") {
    line = `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`;
  } else if (missing === "name") {
    line = "Can I get your first name?";
  } else if (missing === "phone") {
    line = "What phone number should I use for confirmations?";
  } else if (missing === "done") {
    return triggerConfirm(ws, state);
  }

  await say(ws, line);
  armQuestionSilence(ws, line);
}

function confirmSnapshot(slots) { return JSON.stringify(slots); }

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
    ? `Updated. ${s.service} for ${s.name} on ${when}.${numLine} You’re all set. Anything else I can help with?`
    : `Great — I’ve got a ${s.service} for ${s.name} on ${when}.${numLine} Anything else I can help with?`;

  await say(ws, line);
  // Arm question silence on the final "Anything else?" with one retry then 25s -> goodbye -> 8s drain
  armQuestionSilence(ws, "Is there anything else I can help you with?");
}

/* ----------------------- Classify & Handle ----------------------- */
async function classifyAndHandle(ws, state, transcript) {
  // “this/my number” -> use caller ID
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
 "intent": "FAQ" | "BOOK" | "DECLINE_BOOK" | "TRANSFER" | "SMALLTALK" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",
 "date": "",     // "today" | "tomorrow" | weekday | "YYYY-MM-DD"
 "time": "",     // "3 PM" | "15:00"
 "name": "",
 "phone": ""
}
Rules:
- Detect booking only if the user asks to schedule, book, reschedule, or gives date/time.
- If user says they do NOT want to book, set intent = "DECLINE_BOOK".
- If user changes service/date/time/name/phone, include only the new value.
- If the user says "this number", leave phone empty (we fill from caller ID).
- Keep values minimal; leave blank if unsure.
`.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  // Any user speech cancels pending silence timers
  clearQuestionTimers(ws);

  const { changed, changedKeys } = mergeSlots(state, parsed);

  // Acknowledge slot changes during booking
  if (changed && (state.phase === "booking" || parsed.intent === "BOOK")) {
    const acks = [];
    for (const k of changedKeys) {
      if (k === "service") acks.push(`Got it: ${state.slots.service}.`);
      if (k === "date")    acks.push(`Okay: ${formatDateSpoken(state.slots.date)}.`);
      if (k === "time")    acks.push(`Noted: ${to12h(state.slots.time)}.`);
      if (k === "name")    acks.push(`Thanks, ${state.slots.name}.`);
      if (k === "phone")   acks.push(`Thanks. I’ve saved your number.`);
    }
    if (acks.length) await say(ws, acks.join(" "));
  }

  // Declined booking
  if (parsed.intent === "DECLINE_BOOK") {
    state.phase = "idle";
    const line = "No problem. What else can I help with?";
    await say(ws, line);
    armQuestionSilence(ws, line);
    return;
  }

  // FAQs
  if (parsed.intent === "FAQ") {
    let answer = "";
    try {
      if (MAKE_FAQ_URL) {
        await axios.post(MAKE_FAQ_URL, { topic: parsed.faq_topic, service: parsed.service || state.slots.service || "" });
      }
    } catch {}

    const priceTable = { "haircut": 30, "beard trim": 15, "combo": 40 };

    if (parsed.faq_topic === "HOURS") {
      answer = "We’re open Monday to Friday, 9 AM to 5 PM. Closed weekends.";
    } else if (parsed.faq_topic === "PRICES") {
      const svc = normalizeService(parsed.service || state.slots.service);
      if (svc && priceTable[svc]) {
        answer = `${svc} is thirty dollars.`.replace("beard trim is thirty dollars.", "beard trim is fifteen dollars.").replace("combo is thirty dollars.", "combo is forty dollars.");
      } else {
        answer = "Haircut is thirty dollars, beard trim fifteen, and the combo is forty.";
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
      await askForMissing(ws, state);
      return;
    }
    if (state.phase === "confirmed") {
      await say(ws, answer);
      armQuestionSilence(ws, "Is there anything else I can help you with?");
      return;
    }
    const line = `${answer} Would you like to book an appointment?`;
    await say(ws, line);
    armQuestionSilence(ws, "Would you like to book an appointment?");
    return;
  }

  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that. Let me transfer you. Please hold.");
    try { ws.close(); } catch {}
    return;
  }

  // Booking
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
      const s = state.slots;
      const targetAsk = {
        "service": "Which service would you like — haircut, beard trim, or combo?",
        "datetime": `What date and time would you like for your ${s.service || "appointment"}?`,
        "date": `What date works for your ${s.service}${s.time ? ` at ${to12h(s.time)}` : ""}?`,
        "time": `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`,
        "name": "Can I get your first name?",
        "phone": "What phone number should I use for confirmations?"
      }[missing];

      const bridgePrompt = `
Reply with one short, natural sentence (<=12 words) acknowledging the remark.
Do NOT ask open-ended questions. We append the booking question separately.
Examples: "Totally!", "Got it.", "No worries.", "Sounds good."
`.trim();

      const bridge = (await askGPT(bridgePrompt, transcript)) || "Sure.";
      const line = `${bridge} ${targetAsk}`;
      await say(ws, line);
      armQuestionSilence(ws, targetAsk);
      return;
    }

    return askForMissing(ws, state);
  }

  // SMALLTALK / UNKNOWN outside booking — short, no follow-up
  if (parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
    const fallbackPrompt = `
Reply with one short, casual sentence (<=12 words). No follow-up questions.
`.trim();
    const nlg = await askGPT(fallbackPrompt, transcript);
    const line = nlg || "How can I help?";
    await say(ws, line);
    armQuestionSilence(ws, "How can I help?");
    return;
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
          try {
            // any speech cancels silence timers
            clearQuestionTimers(ws);
            await classifyAndHandle(ws, ws.__state, text);
          } catch (e) { console.error("[handle error]", e.message); }
        }
      });

      await say(ws, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
      armQuestionSilence(ws, "How can I help you today?");
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
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
    }
  });

  ws.on("close", () => {
    clearQuestionTimers(ws);
    try { dg?.close(); } catch {}
    console.log("[INFO] WS closed", { convoId: ws.__convoId });
  });
});
