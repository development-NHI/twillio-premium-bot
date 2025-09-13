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

/* === NEW: Make READ/DELETE endpoints and simple identifiers (no api_key sent) === */
const MAKE_READ_URL = process.env.MAKE_READ_URL || "";
const MAKE_DELETE_URL = process.env.MAKE_DELETE_URL || "";
const MAKE_BIZ = process.env.MAKE_BIZ || "oldline";
const MAKE_SOURCE = process.env.MAKE_SOURCE || "voice";

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
  return `${hh}:${mm}`.replace(":00","") + ` ${ampm}`;
}
function humanWhen(dateISO, timeStr) {
  const dSpoken = formatDateSpoken(dateISO);
  const tSpoken = to12h(timeStr);
  return tSpoken ? `${dSpoken} at ${tSpoken}` : dSpoken;
}

/* ----- Business hours (Mon–Fri, 9AM–5PM) ----- */
function isWeekend(dateISO) {
  const d = new Date(dateISO);
  const day = d.getDay(); // 0=Sun,6=Sat
  return day === 0 || day === 6;
}
function isWithinHours(timeStr) {
  if (!timeStr) return false;
  let hh = 0, mm = 0;
  const ampm = /am|pm/i.test(timeStr);
  if (ampm) {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(timeStr.trim().toUpperCase());
    if (!m) return false;
    hh = parseInt(m[1] || "0", 10);
    mm = parseInt(m[2] || "0", 10);
    const isPM = m[3] === "PM";
    if (hh === 12) hh = isPM ? 12 : 0;
    else if (isPM) hh += 12;
  } else {
    const m = /^(\d{1,2}):?(\d{2})$/.exec(timeStr.trim());
    if (!m) return false;
    hh = parseInt(m[1] || "0", 10);
    mm = parseInt(m[2] || "0", 10);
  }
  const minutes = hh * 60;
  const start = 9 * 60;
  const end = 17 * 60;
  return minutes + mm >= start && minutes + mm <= end;
}
function enforceBusinessWindow(state) {
  const s = state.slots;
  if (!s.date || !s.time) return { ok: false, reason: "incomplete" };
  if (isWeekend(s.date)) {
    const oldDate = s.date;
    s.date = "";
    return { ok: false, reason: "weekend", oldDate };
  }
  if (!isWithinHours(s.time)) {
    const oldTime = s.time;
    s.time = "";
    return { ok: false, reason: "hours", oldTime };
  }
  return { ok: true };
}

/* === NEW: time helpers for Make payloads === */
function to24h(timeStr) {
  // "1PM" | "1:30 PM" | "13:30" -> "HH:MM"
  if (!timeStr) return "";
  const s = timeStr.trim().toUpperCase();
  let hh = 0, mm = 0;
  const m12 = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/.exec(s);
  if (m12) {
    hh = parseInt(m12[1] || "0", 10);
    mm = parseInt(m12[2] || "0", 10);
    const isPM = m12[3] === "PM";
    if (hh === 12) hh = isPM ? 12 : 0;
    else if (isPM) hh += 12;
  } else {
    const m24 = /^(\d{1,2}):?(\d{2})$/.exec(s);
    if (!m24) return "";
    hh = parseInt(m24[1] || "0", 10);
    mm = parseInt(m24[2] || "0", 10);
  }
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
function durationMinutesForService(service) {
  const s = (service || "").toLowerCase();
  if (s === "haircut") return 30;
  if (s === "beard trim") return 15;
  if (s === "combo") return 45;
  return 30; // default
}
function buildStartEndISO(dateISO, timeStr, service) {
  const hhmm = to24h(timeStr);
  if (!dateISO || !hhmm) return { startISO: "", endISO: "" };
  const [hh, mm] = hhmm.split(":").map(Number);
  const start = new Date(`${dateISO}T${hhmm}:00`);
  const mins = durationMinutesForService(service);
  const end = new Date(start.getTime() + mins * 60000);
  const iso = (d) => `${d.toISOString().slice(0,19)}`; // no timezone
  return { startISO: iso(start), endISO: iso(end) };
}

/* === NEW: Make.com helpers === */
async function makeReadWindow(startISO, endISO) {
  if (!MAKE_READ_URL) return { ok: false, events: [] };
  try {
    const payload = {
      intent: "READ",
      biz: MAKE_BIZ,
      source: MAKE_SOURCE,
      window: { start: startISO, end: endISO }
    };
    const { data } = await axios.post(MAKE_READ_URL, payload, { timeout: 10000 });

    // ****** ONLY CHANGE: normalize Make's `events` to an array (object or array) ******
    let raw = data?.events;
    let events = [];
    if (Array.isArray(raw)) {
      events = raw;
    } else if (raw && typeof raw === "object") {
      // Some Make aggregators return { array: [...] } or a single object
      if (Array.isArray(raw.array)) events = raw.array;
      else events = [raw];
    } else {
      events = [];
    }
    // ***********************************************************************************

    return { ok: !!data?.ok, events };
  } catch (e) {
    console.error("[MAKE READ ERROR]", e.message);
    return { ok: false, events: [] };
  }
}
async function makeCreateEvent({ name, phone, email, notes, startISO, endISO, service }) {
  if (!MAKE_CREATE_URL) return { ok: false, event: null };
  try {
    const payload = {
      Event_Name: `${service || "Appointment"} (${name || "Guest"})`,
      Start_Time: startISO,
      End_Time: endISO,
      Customer_Name: name || "",
      Customer_Phone: phone || "",
      Customer_Email: email || "",
      Notes: notes || service || ""
    };
    const { data } = await axios.post(MAKE_CREATE_URL, payload, { timeout: 10000 });
    return { ok: true, event: data || null };
  } catch (e) {
    console.error("[MAKE CREATE ERROR]", e.message);
    return { ok: false, event: null };
  }
}
async function makeDeleteEvent(event_id) {
  if (!MAKE_DELETE_URL) return { ok: false };
  try {
    const payload = {
      intent: "DELETE",
      biz: MAKE_BIZ,
      source: MAKE_SOURCE,
      event_id
    };
    const { data } = await axios.post(MAKE_DELETE_URL, payload, { timeout: 10000 });
    return { ok: !!data?.ok };
  } catch (e) {
    console.error("[MAKE DELETE ERROR]", e.message);
    return { ok: false };
  }
}
function eventsOverlap(aStart, aEnd, bStart, bEnd) {
  const A1 = new Date(aStart).getTime();
  const A2 = new Date(aEnd).getTime();
  const B1 = new Date(bStart).getTime();
  const B2 = new Date(bEnd).getTime();
  return A1 < B2 && B1 < A2;
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

/* ----------------------- Silence handling ----------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clearQuestionTimers(ws) {
  if (ws.__qTimer1) { clearTimeout(ws.__qTimer1); ws.__qTimer1 = null; }
  if (ws.__qTimer2) { clearTimeout(ws.__qTimer2); ws.__qTimer2 = null; }
  ws.__lastQuestion = "";
}

async function askWithReaskAndGoodbye(ws, questionText) {
  clearQuestionTimers(ws);
  ws.__lastQuestion = questionText;
  await say(ws, questionText);
  ws.__qTimer1 = setTimeout(async () => {
    await say(ws, `Sorry, I didn’t hear that. ${questionText}`);
    ws.__qTimer2 = setTimeout(async () => {
      await say(ws, "Thanks for calling Old Line Barbershop, have a great day!");
      await sleep(8000);
      try { ws.close(); } catch {}
    }, 8000);
  }, 20000);
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

/* ------ Goodbye handling (post-confirmation) ------ */
function clearGoodbyeTimers(ws) {
  if (ws.__goodbyeSilenceTimer) { clearTimeout(ws.__goodbyeSilenceTimer); ws.__goodbyeSilenceTimer = null; }
  if (ws.__hangTimer) { clearTimeout(ws.__hangTimer); ws.__hangTimer = null; }
}
function armGoodbyeSilence(ws, state) {
  clearGoodbyeTimers(ws);
  ws.__goodbyeSilenceTimer = setTimeout(async () => {
    await say(ws, "Thanks for calling Old Line Barbershop, have a great day!");
    ws.__hangTimer = setTimeout(() => {
      try { ws.close(); } catch {}
    }, 8000);
  }, 7000);
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
    return askWithReaskAndGoodbye(ws, "Which service would you like — haircut, beard trim, or combo?");

  if (missing === "datetime") {
    if (s.date && !s.time) return askWithReaskAndGoodbye(ws, `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`);
    if (!s.date && s.time) return askWithReaskAndGoodbye(ws, `What day works for your ${s.service} at ${to12h(s.time)}?`);
    return askWithReaskAndGoodbye(ws, `What date and time would you like for your ${s.service || "appointment"}?`);
  }

  if (missing === "date")
    return askWithReaskAndGoodbye(ws, `What date works for your ${s.service}${s.time ? ` at ${to12h(s.time)}` : ""}?`);

  if (missing === "time")
    return askWithReaskAndGoodbye(ws, `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`);

  if (missing === "name")
    return askWithReaskAndGoodbye(ws, "Can I get your first name?");

  if (missing === "phone")
    return askWithReaskAndGoodbye(ws, "What phone number should I use for confirmations?");

  if (missing === "done") {
    // Enforce business hours before confirming
    const check = enforceBusinessWindow(state);
    if (!check.ok) {
      if (check.reason === "weekend") {
        return askWithReaskAndGoodbye(ws, "We’re closed on weekends. We’re open Monday to Friday, 9 AM to 5 PM. What weekday works?");
      }
      if (check.reason === "hours") {
        return askWithReaskAndGoodbye(ws, "We’re open 9 AM to 5 PM. What time that day works within business hours?");
      }
      // If incomplete, fall through to resume
      return askForMissing(ws, state);
    }
    return triggerConfirm(ws, state);
  }
}

function confirmSnapshot(slots) { return JSON.stringify(slots); }

/* === NEW: check availability + create on Make before we “finalize” with the caller === */
async function createViaMakeIfFree(ws, state) {
  const s = state.slots;
  const { startISO, endISO } = buildStartEndISO(s.date, s.time, s.service);
  if (!startISO || !endISO) return { ok: false, reason: "bad_time" };

  // Read window = exact appt window
  const read = await makeReadWindow(startISO, endISO);
  if (!read.ok) {
    console.log(JSON.stringify({ event: "MAKE_READ_FAILED" }));
    // If read fails, to avoid double-booking, do NOT auto-create.
    return { ok: false, reason: "unverified" };
  }

  // If any event overlaps our desired window, it's taken
  const conflict = read.events?.some(ev => {
    const evStart = ev.Start_Time || ev.start || ev.start_time || ev.startISO;
    const evEnd = ev.End_Time || ev.end || ev.end_time || ev.endISO || evStart;
    return evStart && evEnd && eventsOverlap(startISO, endISO, evStart, evEnd);
  });

  if (conflict) return { ok: false, reason: "conflict" };

  // Create
  const created = await makeCreateEvent({
    name: s.name,
    phone: s.phone,
    email: "", // not collected in current flow
    notes: s.service,
    startISO,
    endISO,
    service: s.service
  });
  if (!created.ok) return { ok: false, reason: "create_failed" };

  // Echo event_id back on state for potential cancel
  const eventId = created.event?.event_id || created.event?.id || created.event?.eventId || null;
  if (eventId) state.__lastEventId = eventId;

  return { ok: true, startISO, endISO, eventId };
}

async function triggerConfirm(ws, state, { updated=false } = {}) {
  const s = state.slots;
  const when = humanWhen(s.date, s.time);
  console.log(JSON.stringify({ event: "CONFIRM_READY", slots: s, whenSpoken: when }));

  const snap = confirmSnapshot(s);
  if (snap === state.lastConfirmSnapshot && state.phase === "confirmed") return;

  // === NEW: verify availability + create in Make ===
  const makeRes = await createViaMakeIfFree(ws, state);
  if (!makeRes.ok) {
    if (makeRes.reason === "conflict") {
      await say(ws, "That time just became unavailable. What other time that day works?");
      // Clear only time so we stay on same date
      state.slots.time = "";
      state.phase = "booking";
      return askForMissing(ws, state);
    }
    // If unverified or create_failed, ask for another time (safer than double-booking)
    await say(ws, "I couldn’t lock that time just now. What other time works?");
    state.slots.time = "";
    state.phase = "booking";
    return askForMissing(ws, state);
  }

  state.phase = "confirmed";
  state.lastConfirmSnapshot = snap;

  const last4 = s.phone ? s.phone.slice(-4) : "";
  const numLine = last4 ? ` I have your number ending in ${last4}.` : "";

  const line = updated
    ? `Updated — I’ve got a ${s.service} for ${s.name} on ${when}.${numLine} You’re all set. Anything else I can help with?`
    : `Great — I’ve got a ${s.service} for ${s.name} on ${when}.${numLine} You’re all set. Anything else I can help with?`;

  // Ask and wait (your silence timers handle re-ask → goodbye)
  await askWithReaskAndGoodbye(ws, line);
}

/* ----------------------- Classify & Handle ----------------------- */
async function classifyAndHandle(ws, state, transcript) {
  // Any speech cancels the pending question timers
  clearQuestionTimers(ws);

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
 "intent": "FAQ" | "BOOK" | "CANCEL" | "DECLINE_BOOK" | "TRANSFER" | "END" | "SMALLTALK" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",
 "date": "",
 "time": "",
 "name": "",
 "phone": ""
}
Rules:
- Detect booking only if the user asks to schedule, book, reschedule, or gives date/time.
- If user wants to cancel an appointment, set intent = "CANCEL" and include any date/time/name/phone mentioned.
- If user says they do NOT want to book or they say "that's it / goodbye", set intent = "END".
- If the user says "this number", leave phone empty (we fill from caller ID).
- Keep values minimal; leave blank if unsure.
`.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  // Reset goodbye silence if user talks after confirmation
  if (state.phase === "confirmed") {
    clearGoodbyeTimers(ws);
  }

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

  // End / post-confirm wrap
  if (parsed.intent === "END") {
    if (state.phase === "confirmed") {
      await say(ws, "Thanks for calling Old Line Barbershop, have a great day!");
      setTimeout(() => { try { ws.close(); } catch {} }, 8000);
      return;
    }
    await say(ws, "Thanks for calling Old Line Barbershop, have a great day!");
    setTimeout(() => { try { ws.close(); } catch {} }, 8000);
    return;
  }

  // Declined booking (keep idle)
  if (parsed.intent === "DECLINE_BOOK") {
    state.phase = "idle";
    return say(ws, "No problem. How else can I help?");
  }

  /* === NEW: Cancellation flow === */
  if (parsed.intent === "CANCEL") {
    // Try to find matching event and delete it
    const name = parsed.name || state.slots.name || "";
    const phone = parsed.phone ? normalizePhone(parsed.phone) : state.slots.phone || "";
    const dateISO = normalizeDate(parsed.date) || state.slots.date || nowNY();
    const timeStr = parsed.time || state.slots.time || "12:00";
    const { startISO, endISO } = buildStartEndISO(dateISO, timeStr, state.slots.service || parsed.service || "haircut");
    // Read around that window (same as booking window)
    const read = await makeReadWindow(startISO, endISO);
    if (!read.ok || !Array.isArray(read.events) || read.events.length === 0) {
      await say(ws, "I couldn’t find that appointment. Could you share the date and time?");
      state.phase = "idle";
      return;
    }
    // Pick the event that best matches by time and (if available) phone/name
    let target = null;
    for (const ev of read.events) {
      const evStart = ev.Start_Time || ev.start || ev.start_time || ev.startISO;
      const evEnd = ev.End_Time || ev.end || ev.end_time || ev.endISO || evStart;
      const evName = (ev.Customer_Name || ev.name || "").toString().toLowerCase();
      const evPhone = normalizePhone(ev.Customer_Phone || ev.phone || "");
      const timeMatch = evStart && evEnd && eventsOverlap(startISO, endISO, evStart, evEnd);
      const phoneMatch = phone && evPhone ? evPhone.endsWith(phone.slice(-4)) : true;
      const nameMatch = name ? evName.includes(name.toLowerCase()) : true;
      if (timeMatch && phoneMatch && nameMatch) { target = ev; break; }
    }
    if (!target) target = read.events[0];
    const eventId = target.event_id || target.id || target.eventId;
    if (!eventId) {
      await say(ws, "I found an appointment but couldn’t cancel it. Would you like me to try again?");
      return;
    }
    const del = await makeDeleteEvent(eventId);
    if (del.ok) {
      await say(ws, "All set — your appointment has been canceled. Anything else I can help with?");
      // Let silence timers handle follow-up; do not auto-hang yet.
      return;
    } else {
      await say(ws, "I couldn’t cancel that just now. Would you like me to try again or cancel a different time?");
      return;
    }
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
      answer = "We’re open Monday to Friday, nine A M to five P M. Closed weekends.";
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
      answer = "We’re at one two three Blueberry Lane.";
    } else {
      answer = "Happy to help. What else can I answer?";
    }

    if (state.phase === "booking") {
      await say(ws, answer);
      return askForMissing(ws, state);
    }
    if (state.phase === "confirmed") {
      return say(ws, answer);
    }
    return say(ws, `${answer} Would you like to book an appointment or do you have another question?`);
  }

  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that. Let me transfer you. Please hold.");
    try { ws.close(); } catch {}
    return;
  }

  // Booking gate: only enter booking if the user asked to book OR already in booking
  if (parsed.intent === "BOOK" || state.phase === "booking") {
    if (state.phase !== "booking") state.phase = "booking";

    const missing = nextMissing(state);
    if (missing === "done") {
      const check = enforceBusinessWindow(state);
      if (!check.ok) {
        if (check.reason === "weekend") {
          return askWithReaskAndGoodbye(ws, "We’re closed on weekends. We’re open Monday to Friday, 9 AM to 5 PM. What weekday works?");
        }
        if (check.reason === "hours") {
          return askWithReaskAndGoodbye(ws, "We’re open 9 AM to 5 PM. What time that day works within business hours?");
        }
      }
      return triggerConfirm(ws, state);
    }

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
Do NOT ask open-ended questions. Examples: "Totally!", "Got it.", "No worries.", "Sounds good."
`.trim();

      const bridge = (await askGPT(bridgePrompt, transcript)) || "Sure.";
      await say(ws, bridge);
      return askWithReaskAndGoodbye(ws, targetAsk);
    }

    return askForMissing(ws, state);
  }

  // SMALLTALK / UNKNOWN outside booking — short + pivot to help
  if (parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
    if (state.phase === "idle") {
      const polite = `I'm doing great, thanks! How can I help today — would you like to book an appointment or do you have a question?`;
      return say(ws, polite);
    }
    if (state.phase === "confirmed") {
      const nlg = "Happy to help!";
      return say(ws, nlg);
    }
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
      clearGoodbyeTimers(ws);
      clearQuestionTimers(ws);
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
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
    }
  });

  ws.on("close", () => {
    clearQuestionTimers(ws);
    clearGoodbyeTimers(ws);
    try { dg?.close(); } catch {}
    console.log("[INFO] WS closed", { convoId: ws.__convoId });
  });
});
