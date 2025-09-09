// server.js — Premium phone agent with phased flow (one question at a time) + deep logs
// Pipeline: Twilio Media Streams (μ-law 8k) -> Deepgram (ASR) -> OpenAI (extraction JSON) -> Make (READ/CREATE/DELETE/FAQ) -> ElevenLabs (TTS)

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;
const LOCAL_TZ = process.env.LOCAL_TZ || "America/New_York";

// ====== YOUR MAKE WEBHOOKS (unchanged) ======
const MAKE_CREATE = process.env.MAKE_CREATE || "https://hook.us2.make.com/7hd4nxdrgytwukxw57cwyykhotv6hxrm";
const MAKE_READ   = process.env.MAKE_READ   || "https://hook.us2.make.com/6hmur673mpqw4xgy2bhzx4be4o32ziax";
const MAKE_DELETE = process.env.MAKE_DELETE || "https://hook.us2.make.com/noy0e27knj7e1jlomtznw34z246i3xtv";
// (Optional) same endpoint handles FAQ in your logs
const MAKE_FAQ    = process.env.MAKE_FAQ    || MAKE_READ;

// ---------- logging helpers ----------
const log = (...a) => console.log(new Date().toISOString(), "-", ...a);
const err = (...a) => console.error(new Date().toISOString(), "!", ...a);

// ---------- time helpers ----------
function nowContext() { return { nowISO: new Date().toISOString(), tz: LOCAL_TZ }; }
function pretty(dtISO, tz = LOCAL_TZ) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "short", day: "2-digit",
      hour: "numeric", minute: "2-digit"
    }).format(new Date(dtISO));
  } catch { return dtISO; }
}
function isBusinessHours(dtISO, tz = LOCAL_TZ) {
  const d = new Date(dtISO);
  if (isNaN(d.getTime())) return false;
  const dayShort = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d);
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(d));
  const isMonFri = ["Mon","Tue","Wed","Thu","Fri"].includes(dayShort);
  return isMonFri && hour >= 9 && hour < 17;
}

// --- NEW: robust end-time helper (adds N minutes; returns ISO Z string) ---
function addMinutesISO(startISO, minutes, tz = LOCAL_TZ) {
  try {
    const d = new Date(startISO);
    if (isNaN(d.getTime())) return "";
    const ms = d.getTime() + minutes * 60000;
    const out = new Date(ms);
    // Using ISO UTC is safest for downstream API parsing
    return out.toISOString();
  } catch { return ""; }
}

// ---------- μ-law -> PCM16 ----------
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
  for (let i = 0; i < ulawBuf.length; i++) out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i * 2);
  return out;
}

// ---------- simple normalization ----------
const SERVICE_ALIASES = {
  "haircut": ["haircut", "cut", "men's cut", "mens cut", "trim hair", "basic haircut", "standard haircut"],
  "Beard Trim": ["beard trim", "trim", "beard", "line up", "line-up", "beard lineup", "beard shape"]
};
function normalizeService(raw) {
  if (!raw) return "";
  const s = String(raw).toLowerCase().trim();
  for (const canonical of Object.keys(SERVICE_ALIASES)) {
    if (SERVICE_ALIASES[canonical].some(a => s.includes(a))) return canonical;
  }
  if (/\bhair\s*cut|haircut\b/.test(s)) return "haircut";
  if (/\bbeard\b/.test(s)) return "Beard Trim";
  return "";
}
function digitsOnlyPhone(p) {
  if (!p) return "";
  return (""+p).replace(/\D+/g, "").slice(-10); // last 10 digits
}
function formatPhone(d10) {
  if (!d10 || d10.length !== 10) return d10 || "";
  return `(${d10.slice(0,3)}) ${d10.slice(3,6)}-${d10.slice(6)}`;
}

// ---------- Deepgram realtime ----------
function startDeepgram({ onOpen, onPartial, onFinal, onError, onAny }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) { log("(!) No DEEPGRAM_API_KEY — ASR disabled."); return null; }

  const url = "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16&sample_rate=8000&channels=1"
    + "&model=nova-2-phonecall&interim_results=true&smart_format=true"
    + "&language=en-US&endpointing=250";

  const dg = new WebSocket(url, { headers: { Authorization: `Token ${key}` }, perMessageDeflate: false });
  let open = false;
  const q = [];

  dg.on("open", () => { open = true; log("[ASR] Deepgram open"); onOpen?.(); while (q.length) { try { dg.send(q.shift()); } catch {} }});
  dg.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    onAny?.(msg);
    if (msg.type !== "Results") return;
    const alt = msg.channel?.alternatives?.[0];
    if (!alt) return;
    const txt = (alt.transcript || "").trim();
    if (!txt) return;
    if (msg.is_final || msg.speech_final) { log("[ASR final]", txt); onFinal?.(txt); }
    else { log("[ASR partial]", txt); onPartial?.(txt); }
  });
  dg.on("error", (e) => { err("[ASR] error", e?.message || e); onError?.(e); });
  dg.on("close", (c, r) => log("[ASR] closed", c, r?.toString?.() || ""));

  return {
    sendPCM16LE(buf) {
      try { if (open && dg.readyState === WebSocket.OPEN) dg.send(buf); else q.push(buf); }
      catch (e) { err("[ASR] send error", e?.message || e); }
    },
    close() { try { dg.close(); } catch {} }
  };
}

// ---------- OpenAI extraction (JSON only) ----------
async function extractBookingData(userText, memory, callId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const text = userText || "";
    const intent =
      /cancel|reschedule.*cancel/i.test(text) ? "DELETE" :
      /availability|what.*appointments|any.*appointments|do you have|are you open|free slots|openings|hours|price|cost/i.test(text) ? "READ" :
      /book|appointment|schedule|reserve|make.*appointment/i.test(text) ? "CREATE" :
      "UNKNOWN";
    return {
      intent,
      Event_Name: "", Start_Time: "", End_Time: "",
      Customer_Name: "", Customer_Phone: "", Customer_Email: "",
      id: "", Notes: "", window: { start: "", end: "" }
    };
  }

  const { nowISO, tz } = nowContext();
  const sys = `Return ONLY JSON. Current time: ${nowISO} ${tz}.
- Interpret times in ${tz}.
- Resolve relative times to full ISO in ${tz}.
- If any info is missing, use "" (empty string).
- If caller asks hours/prices/services/location, set "intent":"FAQ" with "faq_topic" among: HOURS|PRICES|SERVICES|LOCATION; otherwise leave faq_topic="".
Schema:
{
  "intent": "CREATE|READ|DELETE|FAQ|SMALLTALK|UNKNOWN",
  "faq_topic": string,
  "Event_Name": string,
  "Start_Time": string,
  "End_Time": string,
  "Customer_Name": string,
  "Customer_Phone": string,
  "Customer_Email": string,
  "id": string,
  "Notes": string,
  "window": { "start": string, "end": string },
  "ask": "NONE|SERVICE|TIME|NAME|PHONE|CONFIRM",
  "reply": string
}`;

  const body = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.2,
    max_tokens: 220,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Known slots: ${JSON.stringify(memory)}\nCallID:${callId}` },
      { role: "user", content: userText }
    ]
  };

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) { err("[OpenAI] net", e?.message || e); return { intent: "UNKNOWN", ask: "NONE", reply: "" }; }

  if (!res.ok) { err("[OpenAI extract] HTTP", res.status, await res.text()); return { intent: "UNKNOWN", ask: "NONE", reply: "" }; }

  const json = await res.json();
  const raw = json?.choices?.[0]?.message?.content || "{}";
  let out; try { out = JSON.parse(raw); } catch { out = { intent: "UNKNOWN", ask: "NONE", reply: "" }; }
  log("[extract JSON]", out);
  return out;
}

// ---------- TTS: ElevenLabs ----------
async function speakEleven(ws, streamSid, text) {
  if (!streamSid || !text) return;
  const key = process.env.ELEVEN_API_KEY, voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) { log("(!) ELEVEN vars missing — TTS skipped:", text); return; }
  log("[TTS ->]", text);

  let res;
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
    });
  } catch (e) { err("[TTS] net", e?.message || e); return; }

  if (!res.ok || !res.body) { err("[TTS] HTTP", res.status, await res.text()); return; }

  return new Promise((resolve) => {
    res.body.on("data", (chunk) => {
      try {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: Buffer.from(chunk).toString("base64") } }));
      } catch (e) { err("[TTS] ws send]", e?.message || e); }
    });
    res.body.on("end", () => { log("[TTS] end"); resolve(); });
  });
}

// ---------- Make helper ----------
async function callMake(url, payload, tag) {
  const preview = JSON.stringify(payload);
  log(`[Make ${tag}] POST ${url} body(${preview.length}B):`, preview);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: preview });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    log(`[Make ${tag}] HTTP ${res.status} resp(${text.length}B):`, data);
    return { ok: res.ok, data, status: res.status };
  } catch (e) { err(`[Make ${tag}] net`, e?.message || e); return { ok: false, data: null, status: 0 }; }
}

// ---------- Persona (short, friendly) ----------
const DEFAULT_PROMPT = `
You are a friendly, confident receptionist for Old Line Barbershop.
Keep sentences short and natural. Never guess.
For booking/reschedule/cancel, collect/confirm: name, phone, service type, date and time.
Book only Mon–Fri 9am–5pm (local). No double-booking. Confirm details before finalizing.
Keep caller informed: “Let me check…”, “That works.”, “You’re confirmed.”
If you truly can’t help, say: “I’m not sure about that, let me transfer you to someone who can help.” Then end the call politely.
`;

// ---------- HTTP boilerplate ----------
const app = express();
app.get("/", (_,res)=>res.type("text/plain").send("OK"));
app.get("/twilio", (_,res)=>res.status(426).type("text/plain").send("Upgrade Required: wss://<host>/twilio"));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname !== "/twilio") { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ---------- Session per call ----------
wss.on("connection", (ws) => {
  let streamSid = null;
  let callSid = null;
  let frames = 0;
  let lastUserAt = Date.now();
  let busy = false; // blocks overlapping TTS/reprompts

  // ping/pong keepalive
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  const pingIv = setInterval(() => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }, 25000);

  // conversational memory
  const memory = { name: "", phone: "", email: "", service: "", startISO: "", endISO: "" };
  const AGENT_PROMPT = process.env.AGENT_PROMPT || DEFAULT_PROMPT;
  log("[agent] Using AGENT_PROMPT (first 120 chars):", (AGENT_PROMPT || "").slice(0,120), "…");

  // conversation phases
  let phase = "collect_time"; // initial phase after greeting
  let lastSaid = "";

  function logSlots(where) { log(`[slots:${where}]`, JSON.stringify({ phase, ...memory })); }

  async function say(text) {
    if (!text) return;
    if (text === lastSaid) { log("[debounce] suppress repeat:", text); return; }
    lastSaid = text;
    busy = true;
    try { await speakEleven(ws, streamSid, text); } finally { busy = false; }
  }

  // gentle inactivity reprompt (only if not busy)
  const INACTIVITY_MS = 12000;
  const repromptIv = setInterval(() => {
    if (busy) return;
    const idle = Date.now() - lastUserAt;
    if (idle < INACTIVITY_MS) return;
    if (phase === "collect_time") {
      if (!memory.service) return say("I can help with a haircut or a beard trim. Which would you like?");
      if (!memory.startISO) return say("What day and time works for you?");
    } else if (phase === "collect_contact") {
      if (!memory.name)  return say("What name should I put on it?");
      if (!memory.phone) return say("What’s the best phone number?");
    } else if (phase === "confirm_booking") {
      const when = pretty(memory.startISO, LOCAL_TZ);
      return say(`Should I book ${memory.service} for ${memory.name} at ${when}?`);
    }
  }, 3000);

  async function nextQuestion() {
    if (busy) return;
    if (phase === "collect_time") {
      if (!memory.service) return say("What service would you like — haircut or beard trim?");
      if (!memory.startISO) return say("What day and time would you like?");
      phase = "check_availability";
      return await handlePhase();
    }
    if (phase === "collect_contact") {
      if (!memory.name)  return say("What name should I put on it?");
      if (!memory.phone) return say("What’s the best phone number?");
      phase = "confirm_booking";
      return await handlePhase();
    }
    if (phase === "confirm_booking") {
      const when = pretty(memory.startISO, LOCAL_TZ);
      return say(`Great — a ${memory.service} for ${memory.name} at ${when}. Should I book it?`);
    }
  }

  // availability check and booking gates
  async function handlePhase() {
    if (phase === "check_availability") {
      // ensure End_Time exists (30 min default)
      if (memory.startISO && !memory.endISO) {
        memory.endISO = addMinutesISO(memory.startISO, 30, LOCAL_TZ);
      }
      // business hours gate first
      if (!isBusinessHours(memory.startISO, LOCAL_TZ)) {
        log("[gate] outside business hours:", memory.startISO);
        return say("We book Monday to Friday, 9 to 5. What time works in those hours?");
      }
      const win = { start: memory.startISO, end: memory.endISO || addMinutesISO(memory.startISO, 30, LOCAL_TZ) };
      const check = await callMake(MAKE_READ, { intent: "READ", window: win }, "READ-check");
      const events = Array.isArray(check?.data?.events) ? check.data.events : [];
      if (events.length) {
        log("[gate] conflict found:", events.length);
        return say("That time is already booked. Do you want to pick a different time?");
      }
      // available → move to contact collection
      phase = "collect_contact";
      return nextQuestion();
    }
    if (phase === "confirm_booking") {
      if (memory.startISO && !memory.endISO) memory.endISO = addMinutesISO(memory.startISO, 30, LOCAL_TZ);
      return;
    }
  }

  function mergeExtract(ex) {
    if (ex.Customer_Name)  memory.name = ex.Customer_Name.trim();
    if (ex.Customer_Phone) {
      const d = digitsOnlyPhone(ex.Customer_Phone);
      memory.phone = d ? formatPhone(d) : memory.phone;
    }
    if (ex.Customer_Email) memory.email = ex.Customer_Email;
    if (ex.Event_Name)     memory.service = normalizeService(ex.Event_Name) || memory.service;

    if (ex.Start_Time) {
      memory.startISO = ex.Start_Time;
      if (!memory.endISO) memory.endISO = addMinutesISO(ex.Start_Time, 30, LOCAL_TZ); // ensure end
    }
    if (ex.End_Time) memory.endISO = ex.End_Time;

    // fallback: infer service from utterance if helpful
    if (!memory.service && ex.utterance) {
      const maybe = normalizeService(ex.utterance);
      if (maybe) memory.service = maybe;
    }

    logSlots("merge");
  }

  function isAffirmative(txt) {
    return /\b(yes|yeah|yep|sure|please|go ahead|book it|confirm|sounds good|that works|okay|ok)\b/i.test(txt || "");
  }
  function isNegative(txt) {
    return /\b(no|nah|nope|stop|wait|hold on|cancel|not now)\b/i.test(txt || "");
  }

  async function onUserUtterance(txt) {
    lastUserAt = Date.now();

    const lower = (txt || "").toLowerCase();
    let preIntent = "";
    if (/cancel/.test(lower)) preIntent = "DELETE";
    else if (/(availability|openings|free|are you open|what.*appointments|any.*appointments|hours|price|cost)/.test(lower)) preIntent = "READ";
    else if (/(book|appointment|schedule|reserve|make.*appointment)/.test(lower)) preIntent = "CREATE";

    const ex = await extractBookingData(txt, memory, callSid);
    ex.intent = ex.intent === "UNKNOWN" && preIntent ? preIntent : ex.intent;
    ex.utterance = txt;
    log("[extracted]", ex);
    mergeExtract(ex);

    // FAQ branch (answer, then optional lead-in)
    if (ex.intent === "FAQ" && ex.faq_topic) {
      // Optionally hit your Make FAQ (as you do in logs)
      await callMake(MAKE_FAQ, { intent: "FAQ", topic: ex.faq_topic }, "FAQ");
      const reply = ex.reply || "";
      if (reply) await say(reply);
      else {
        if (ex.faq_topic === "HOURS") await say("We’re open Monday through Friday, 9 AM to 5 PM, closed weekends. Would you like to book an appointment?");
        else if (ex.faq_topic === "PRICES") await say("A haircut is $30, a beard trim is $15, or $40 for both. Want me to help book one?");
        else if (ex.faq_topic === "SERVICES") await say("We offer haircuts, beard trims, and combo packages. Want me to check availability?");
        else if (ex.faq_topic === "LOCATION") await say("We’re at 123 Blueberry Lane. Want me to help book a visit?");
      }
      return;
    }

    // quick DELETE by id
    if (ex.intent === "DELETE") {
      if (!ex.id) return say("What’s the appointment ID to cancel?");
      const r = await callMake(MAKE_DELETE, { id: ex.id }, "DELETE");
      if (r.ok) await say("Your appointment is cancelled. Thanks for calling Old Line Barbershop. Goodbye.");
      else      await say("I couldn’t cancel that one. Want me to try again?");
      return;
    }

    // READ intent → count in a window
    if (ex.intent === "READ") {
      const win = ex.window?.start ? ex.window :
        (memory.startISO ? { start: memory.startISO, end: memory.endISO || addMinutesISO(memory.startISO, 30, LOCAL_TZ) }
                          : { start: new Date().toISOString(), end: new Date(Date.now()+24*3600e3).toISOString() });
      const r = await callMake(MAKE_READ, { intent: "READ", window: win }, "READ");
      const events = Array.isArray(r?.data?.events) ? r.data.events : [];
      if (!events.length) await say("No appointments in that window.");
      else                await say(`I found ${events.length} appointment${events.length>1?"s":""} in that window.`);
      return;
    }

    // CREATE / UNKNOWN go through phases
    if (phase === "collect_time") {
      if (memory.service && memory.startISO) {
        if (!memory.endISO) memory.endISO = addMinutesISO(memory.startISO, 30, LOCAL_TZ);
        phase = "check_availability";
        return handlePhase();
      }
      return nextQuestion();
    }

    if (phase === "check_availability") {
      if (memory.service && memory.startISO) return handlePhase();
      return nextQuestion();
    }

    if (phase === "collect_contact") {
      if (memory.name && memory.phone) {
        if (memory.startISO && !memory.endISO) memory.endISO = addMinutesISO(memory.startISO, 30, LOCAL_TZ);
        phase = "confirm_booking";
        await handlePhase();
        return nextQuestion();
      }
      return nextQuestion();
    }

    if (phase === "confirm_booking") {
      if (isAffirmative(txt)) {
        if (memory.startISO && !memory.endISO) memory.endISO = addMinutesISO(memory.startISO, 30, LOCAL_TZ);
        const when = pretty(memory.startISO, LOCAL_TZ);
        const createReq = {
          Event_Name: memory.service || "Appointment",
          Start_Time: memory.startISO,
          End_Time:   memory.endISO || addMinutesISO(memory.startISO, 30, LOCAL_TZ),
          Customer_Name:  memory.name,
          Customer_Phone: memory.phone,
          Customer_Email: memory.email || "",
          Notes: `Booked by phone agent. CallSid=${callSid}`
        };
        const r = await callMake(MAKE_CREATE, createReq, "CREATE");
        if (r.ok) await say(`All set — your ${memory.service || "appointment"} is booked for ${when}. Thanks for calling Old Line Barbershop. Goodbye.`);
        else      await say("Sorry — I couldn’t complete the booking. Want me to try a different time?");
        return;
      }
      if (isNegative(txt)) {
        return say("Okay, I won’t book it. Want a different time or service?");
      }
      return nextQuestion();
    }

    // fallback
    return say("I can help book, reschedule, or cancel. What would you like to do?");
  }

  // ---------- WS handlers ----------
  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      callSid   = evt.start?.callSid || null;
      const biz = evt.start?.customParameters?.biz || "default";
      log("WS CONNECTED |", streamSid, "| CallSid:", callSid, "| biz:", biz);

      // (Optional) Pre-fill caller ID if Twilio passes it in customParameters.from
      const ani = evt.start?.customParameters?.from || "";
      const d10 = digitsOnlyPhone(ani);
      if (d10 && !memory.phone) memory.phone = formatPhone(d10);

      // Deepgram
      const dg = startDeepgram({
        onOpen: () => log("[ASR] ready"),
        onPartial: () => { lastUserAt = Date.now(); },
        onFinal: (txt) => onUserUtterance(txt),
        onError: (e) => err("[ASR] err cb", e?.message || e),
        onAny:   (m) => { if (m.type && m.type !== "Results") log("[ASR msg]", JSON.stringify(m)); }
      });
      ws._dg = dg;

      // greet then go to collect_time phase
      await say("Hi, thanks for calling Old Line Barbershop. How can I help you today?");
      phase = "collect_time";
    }

    else if (evt.event === "media") {
      if (!ws._dg) return;
      frames++;
      if (frames % 50 === 1) log("[media] frames:", frames);
      const b64 = evt.media?.payload;
      if (!b64) return;
      try {
        const ulaw = Buffer.from(b64, "base64");
        const pcm = ulawBufferToPCM16LEBuffer(ulaw);
        ws._dg.sendPCM16LE(pcm);
      } catch (e) { err("[media] decode/send", e?.message || e); }
    }

    else if (evt.event === "stop") {
      log("Twilio stream STOP");
      try { ws._dg?.close(); } catch {}
    }
  });

  function cleanup() {
    try { ws._dg?.close(); } catch {};
    clearInterval(pingIv);
    clearInterval(repromptIv);
    log("WS closed");
  }
  ws.on("close", cleanup);
  ws.on("error", (e) => { err("WS error", e?.message || e); cleanup(); });
});

server.listen(PORT, () => log(`Server running on ${PORT}`));
