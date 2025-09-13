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
    bookingLock: "",           // which slot we're waiting for (prevents two threads)
    lastAskedSlot: "",         // what we last asked
  };
}

/** Merge parsed into state; return {changed, changedKeys, prior} */
function mergeSlots(state, parsed) {
  const before = { ...state.slots };
  let changed = false;
  const changedKeys = [];
  const prior = {};

  if (parsed.service) {
    const svc = normalizeService(parsed.service);
    if (svc && svc !== state.slots.service) {
      prior.service = state.slots.service;
      state.slots.service = svc; changed = true; changedKeys.push("service");
    }
  }
  if (parsed.date) {
    const nd = normalizeDate(parsed.date);
    if (nd && nd !== state.slots.date) {
      prior.date = state.slots.date;
      state.slots.date = nd; changed = true; changedKeys.push("date");
    }
  }
  if (parsed.time) {
    const t = parsed.time.trim();
    if (t && t !== state.slots.time) {
      prior.time = state.slots.time;
      state.slots.time = t; changed = true; changedKeys.push("time");
    }
  }
  if (parsed.name) {
    if (parsed.name !== state.slots.name) {
      prior.name = state.slots.name;
      state.slots.name = parsed.name; changed = true; changedKeys.push("name");
    }
  }
  if (parsed.phone) {
    const ph = normalizePhone(parsed.phone);
    if (ph && ph !== state.slots.phone) {
      prior.phone = state.slots.phone;
      state.slots.phone = ph; changed = true; changedKeys.push("phone");
    }
  }

  if (changed) {
    console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
  }
  return { changed, changedKeys, prior };
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
  state.lastAskedSlot = missing;
  state.bookingLock = missing;
  console.log(JSON.stringify({ event: "SLOTS", slots: s, missing }));

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
    return;
  }
  state.phase = "confirmed";
  state.lastConfirmSnapshot = snap;
  state.bookingLock = ""; // release lock after confirmation
  state.lastAskedSlot = "";

  const phoneFmt = `(${s.phone.slice(0,3)}) ${s.phone.slice(3,6)}-${s.phone.slice(6)}`;
  const line = updated
    ? `Updated — I’ve got a ${s.service} for ${s.name} on ${when}. I have your number as ${phoneFmt}. You’re all set. Anything else I can help with?`
    : `Great — I’ve got a ${s.service} for ${s.name} on ${when}. I have your number as ${phoneFmt}. You’re all set. Anything else I can help with?`;

  await say(ws, line);
}

/* ----------------------- Classify & Handle ----------------------- */
async function classifyAndHandle(ws, state, transcript) {
  // Expand "this number" coverage — only when we were asking for phone
  const thisNumHint = /\b(this|my)\s+(number|phone)\b/i.test(transcript) ||
                      /\bcalling\s+from\b/i.test(transcript) ||
                      /\bthis\s+one\b/i.test(transcript) ||
                      /\bthe\s+number\s+i'?m\s+calling\s+from\b/i.test(transcript);

  if (!state.slots.phone && state.lastAskedSlot === "phone" && ws.__callerFrom && thisNumHint) {
    state.slots.phone = normalizePhone(ws.__callerFrom);
    console.log(JSON.stringify({ event: "SLOTS_MERGE", before: {}, after: state.slots, via: "callerFrom" }));
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
- If the user says "this number"/"the number I'm calling from", leave phone empty (we'll fill it from caller ID).
- Keep values short; leave blank if unsure.
`.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  const beforeMissing = nextMissing(state);
  const { changed, changedKeys, prior } = mergeSlots(state, parsed);

  // ----- Acknowledge corrections if a previously filled slot was updated
  if (changed && state.phase !== "idle") {
    const order = ["service","date","time","name","phone"];
    const key = order.find(k => changedKeys.includes(k) && prior[k]); // only if it had a prior value
    if (key) {
      if (key === "service") await say(ws, `Updated — I’ll book the ${state.slots.service}.`);
      else if (key === "date" && state.slots.date && !state.slots.time) await say(ws, `Updated date — ${formatDateSpoken(state.slots.date)}.`);
      else if (key === "time" && state.slots.time && !state.slots.date) await say(ws, `Updated time — ${to12h(state.slots.time)}.`);
      else if ((key === "date" || key === "time") && state.slots.date && state.slots.time) await say(ws, `Updated — ${humanWhen(state.slots.date, state.slots.time)}.`);
      else if (key === "name") await say(ws, `Got it — I’ll use ${state.slots.name}.`);
      else if (key === "phone") await say(ws, `Thanks — updated your number.`);
    }
  }

  // ----- Booking lock (prevents two-threads): if we asked for slot X, but user didn't provide X, keep clarifying X
  if (state.phase === "booking" && state.bookingLock) {
    const lock = state.bookingLock;
    const providedNow =
      (lock === "service" && state.slots.service) ||
      (lock === "date" && state.slots.date) ||
      (lock === "time" && state.slots.time) ||
      (lock === "name" && state.slots.name) ||
      (lock === "phone" && state.slots.phone) ||
      (lock === "datetime" && state.slots.date && state.slots.time);

    if (!providedNow) {
      // Didn’t provide the locked slot; clarify rather than starting another thread
      state.clarify[lock] = (state.clarify[lock] || 0) + 1;

      if (lock === "phone" && ws.__callerFrom && thisNumHint) {
        state.slots.phone = normalizePhone(ws.__callerFrom);
      }

      if (state.clarify[lock] === 1) {
        const prompt = {
          "service": "Which service would you like — haircut, beard trim, or the combo?",
          "datetime": `What date and time would you like for your ${state.slots.service || "appointment"}?`,
          "date": `What date works for your ${state.slots.service}${state.slots.time ? ` at ${to12h(state.slots.time)}` : ""}?`,
          "time": `What time on ${formatDateSpoken(state.slots.date)} works for your ${state.slots.service}?`,
          "name": "Just your first name is fine.",
          "phone": "What’s the best number to text the confirmation to?"
        }[lock];
        await say(ws, prompt);
        return;
      } else if (state.clarify[lock] === 2) {
        const prompt = {
          "service": "Sorry—just to confirm, is that a haircut, beard trim, or the combo?",
          "datetime": "Just to confirm, what date and start time work best?",
          "date": `Just the date is fine—what date works for you?`,
          "time": `Got it—what start time should I put on ${formatDateSpoken(state.slots.date)}?`,
          "name": "Sorry, I didn’t catch that—what’s your first name?",
          "phone": "Please say the 10-digit phone number, with area code."
        }[lock];
        await say(ws, prompt);
        return;
      } else {
        // failsafe after 3 misses → transfer
        console.log(JSON.stringify({ event: "FAILSAFE_TRANSFER", slot: lock }));
        await say(ws, "Let me transfer you to the owner to finish this up.");
        try { ws.close(); } catch {}
        return;
      }
    } else {
      // Provided the locked slot — release lock
      state.bookingLock = "";
      state.clarify[lock] = 0;
    }
  }

  // ----- Post-confirmation behavior: no “want to book?” prompts
  if (state.phase === "confirmed") {
    if (parsed.intent === "FAQ") {
      let answer = "";
      if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
      else if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
      else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
      else if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
      await say(ws, answer || "Happy to help!");
      return;
    }
    if (parsed.intent === "BOOK") {
      // Allow a second booking explicitly if user asks
      state.phase = "booking";
      state.slots = { service: "", date: "", time: "", name: state.slots.name || "", phone: state.slots.phone || "" };
      state.lastAskedSlot = "";
      state.bookingLock = "";
      return askForMissing(ws, state);
    }
    if (parsed.intent === "TRANSFER") {
      await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
      try { ws.close(); } catch {}
      return;
    }
    // smalltalk/unknown after confirm: be polite, no booking prompts
    const polite = "Thanks! Anything else I can help with?";
    await say(ws, polite);
    return;
  }

  // ----- Handle FAQs (outside or during booking)
  if (parsed.intent === "FAQ") {
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
    else if (parsed.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
    else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (parsed.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
    if (!answer) answer = "Happy to help. What else can I answer?";

    if (state.phase === "booking" || beforeMissing !== "done") {
      await say(ws, answer);
      return askForMissing(ws, state);
    } else {
      // Outside booking — be helpful but don't auto-push to book if not asked
      await say(ws, answer);
      return;
    }
  }

  if (parsed.intent === "TRANSFER") {
    await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
    try { ws.close(); } catch {}
    return;
  }

  // ----- Enter or continue booking
  if (parsed.intent === "BOOK" || state.phase === "booking" || beforeMissing !== "done") {
    state.phase = "booking";

    const missing = nextMissing(state);
    if (missing === "done") {
      return triggerConfirm(ws, state);
    }

    // If they supplied exactly the missing slot, ask the next missing
    if (changed) {
      const newMissing = nextMissing(state);
      if (newMissing !== missing) {
        return askForMissing(ws, state);
      }
    }

    // If smalltalk while booking, acknowledge briefly then targeted ask
    if (parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
      const targetAsk = {
        "service": "Which service would you like — haircut, beard trim, or the combo?",
        "datetime": `What date and time would you like for your ${state.slots.service || "appointment"}?`,
        "date": `What date works for your ${state.slots.service}${state.slots.time ? ` at ${to12h(state.slots.time)}` : ""}?`,
        "time": `What time on ${formatDateSpoken(state.slots.date)} works for your ${state.slots.service}?`,
        "name": "Can I get your first name?",
        "phone": "What phone number should I use for confirmations?"
      }[missing];
      const bridgePrompt = `
You are a friendly receptionist. Reply with ONE short natural sentence (<= 12 words) acknowledging the remark, no open-ended questions.
Examples: "Totally!" "Got it!" "Sounds good!"
`.trim();
      const bridge = await askGPT(bridgePrompt, transcript) || "Got it!";
      await say(ws, `${bridge} ${targetAsk}`);
      return;
    }

    return askForMissing(ws, state);
  }

  // ----- SMALLTALK outside booking → warm, generic redirect
  if (parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
    const nlg = "I’m doing well! How can I help you today?";
    return say(ws, nlg);
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
      ws.__callerFrom = (msg.start?.customParameters?.from || "").replace(/^\+1/, ""); // US normalize
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
