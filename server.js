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

app.post("/twiml", (req, res) => {
  res.set("Content-Type", "text/xml");
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || localhost:${PORT};
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

const server = app.listen(PORT, () => console.log([INFO] Server running on ${PORT}));
const wss = new WebSocketServer({ server });

/* ----------------------- Utilities ----------------------- */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function nowNY() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return ${yyyy}-${mm}-${dd};
}
function addDaysISO(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return ${yyyy}-${mm}-${dd};
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
  return d.length >= 10 ? d.slice(-10) : "";
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
  return ${MONTHS[mm - 1]} ${ordinal(dd)};
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
  return ${${hh}:${mm}.replace(":00","")} ${ampm};
}
function humanWhen(dateISO, timeStr) {
  const dSpoken = formatDateSpoken(dateISO);
  const tSpoken = to12h(timeStr);
  return tSpoken ? ${dSpoken} at ${tSpoken} : dSpoken;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ----- Business hours ----- */
function isWeekend(dateISO) {
  const d = new Date(dateISO);
  const day = d.getDay();
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
  const minutes = hh * 60 + mm;
  return minutes >= 540 && minutes <= 1020;
}
function enforceBusinessWindow(state) {
  const s = state.slots;
  if (!s.date || !s.time) return { ok: false, reason: "incomplete" };
  if (isWeekend(s.date)) { s.date = ""; return { ok: false, reason: "weekend" }; }
  if (!isWithinHours(s.time)) { s.time = ""; return { ok: false, reason: "hours" }; }
  return { ok: true };
}

/* ---------------- Silence & Goodbye Timers ---------------- */
function clearTimers(ws) {
  if (ws._silenceTimer) { clearTimeout(ws.silenceTimer); ws._silenceTimer = null; }
  if (ws._retryTimer)   { clearTimeout(ws.retryTimer);   ws._retryTimer = null; }
  if (ws._hangTimer)    { clearTimeout(ws.hangTimer);    ws._hangTimer = null; }
  ws.__retried = false;
}
async function sayAndHang(ws, msg) {
  await say(ws, msg);
  await sleep(8000);
  try { ws.close(); } catch {}
}
function armSilence(ws, questionText) {
  clearTimers(ws);
  ws.__retried = false;
  ws.__silenceTimer = setTimeout(async () => {
    if (ws.__retried) return;
    ws.__retried = true;
    await say(ws, Sorry, I didn’t catch that — could you repeat? ${questionText});
    ws.__retryTimer = setTimeout(async () => {
      await sayAndHang(ws, "Thanks for calling Old Line Barbershop, have a great day!");
    }, 25000);
  }, 25000);
}
async function askAndArm(ws, text) {
  await say(ws, text);
  armSilence(ws, text);
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
      { headers: { Authorization: Bearer ${OPENAI_API_KEY} } }
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

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return;
  try {
    const url = https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000;
    const resp = await axios.post(url,
      { text, voice_settings: { stability: 0.4, similarity_boost: 0.8 } },
      { headers: { "xi-api-key": ELEVENLABS_API_KEY }, responseType: "stream" }
    );
    resp.data.on("data", (chunk) => {
      const b64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
    });
    resp.data.on("end", () => ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } })));
  } catch (e) { console.error("[TTS ERROR]", e.message); }
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

  const key = ask:${missing}:${s.service}:${s.date}:${s.time}:${s.name}:${s.phone};
  const now = Date.now();
  if (state.lastAskKey === key && (now - state.lastAskAt) < 1200) return;
  state.lastAskKey = key;
  state.lastAskAt = now;

  let line = "";
  if (missing === "service") {
    line = "Which service would you like — haircut, beard trim, or combo?";
  } else if (missing === "datetime") {
    if (s.date && !s.time) line = What time on ${formatDateSpoken(s.date)} works for your ${s.service}?;
    else if (!s.date && s.time) line = What day works for your ${s.service} at ${to12h(s.time)}?;
    else line = What date and time would you like for your ${s.service || "appointment"}?;
  } else if (missing === "date") {
    line = `What date works for your ${s.service}${s.time ? ` at ${to12h(s.time)}` : ""}?`;
  } else if (missing === "time") {
    line = What time on ${formatDateSpoken(s.date)} works for your ${s.service}?;
  } else if (missing === "name") {
    line = "Can I get your first name?";
  } else if (missing === "phone") {
    line = "What phone number should I use for confirmations?";
  } else if (missing === "done") {
    return triggerConfirm(ws, state);
  }

  await say(ws, line);
  armQuestionSilence(ws, line); // << added silence/retry timer
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
    ? Updated — I’ve got a ${s.service} for ${s.name} on ${when}.${numLine} You’re all set. Anything else I can help with?
    : Great — I’ve got a ${s.service} for ${s.name} on ${when}.${numLine} You’re all set. Anything else I can help with?;

  await say(ws, line);
  armQuestionSilence(ws, "Is there anything else I can help you with?"); // << added silence/retry timer
}

/* ----------------------- Classify & Handle ----------------------- */
async function classifyAndHandle(ws, state, transcript) {
  if (!state.slots.phone && ws.__callerFrom && /\b(this|my)\s+(number|phone)\b/i.test(transcript)) {
    const filled = normalizePhone(ws.__callerFrom);
    if (filled) {
      const before = { ...state.slots };
      state.slots.phone = filled;
      console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots, via: "callerFrom" }));
    }
  }

  // (systemPrompt unchanged...)

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  // reset silence timers if caller speaks
  clearSilenceTimers(ws);

  // (rest of your classify logic unchanged — make sure after every await say(ws,line) where a question is asked, you also call armQuestionSilence(ws,line))

}

/* ----------------------- WS wiring ----------------------- */
wss.on("connection",(ws)=>{
  let dg=null;
  let pendingULaw=[];
  const BATCH_FRAMES=5;

  ws.on("message",async(raw)=>{
    let msg;
    try{msg=JSON.parse(raw.toString());}catch{return;}

    if(msg.event==="start"){
      ws.__streamSid=msg.start.streamSid;
      ws.__convoId=uuidv4();
      ws.__state=newState();
      ws.__callerFrom=msg.start?.customParameters?.from || "";
      clearSilenceTimers(ws);

      dg=startDeepgram({
        onFinal:async(text)=>{
          try{
            clearSilenceTimers(ws); // reset on user speech
            await classifyAndHandle(ws,ws.__state,text);
          }catch(e){console.error("[handle error]",e.message);}
        }
      });

      const greet="Hi, thanks for calling Old Line Barbershop. How can I help you today?";
      await say(ws,greet);
      armQuestionSilence(ws,greet); // << added
      return;
    }

    if(msg.event==="media"){ /* (unchanged audio handling) */ }
    if(msg.event==="stop"){ try{dg?.close();}catch{} try{ws.close();}catch{} }
  });

  ws.on("close",()=>{ clearSilenceTimers(ws); try{dg?.close();}catch{} });
});
