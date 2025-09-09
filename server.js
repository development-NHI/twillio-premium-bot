// server.js — Premium phone agent with phased flow (one question at a time) + deep logs
// Pipeline: Twilio Media Streams (μ-law 8k) -> Deepgram (ASR) -> OpenAI (extraction JSON + NLG) -> Make (READ/CREATE/DELETE/FAQ) -> ElevenLabs (TTS)

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;
const LOCAL_TZ = process.env.LOCAL_TZ || "America/New_York";

// ====== YOUR MAKE WEBHOOKS (unchanged) ======
const MAKE_CREATE = "https://hook.us2.make.com/7hd4nxdrgytwukxw57cwyykhotv6hxrm";
const MAKE_READ   = "https://hook.us2.make.com/6hmur673mpqw4xgy2bhzx4be4o32ziax";
const MAKE_DELETE = "https://hook.us2.make.com/noy0e27knj7e1jlomtznw34z246i3xtv";

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
  return ""; // unknown -> will trigger clarification
}
function digitsOnlyPhone(p) {
  if (!p) return "";
  return (""+p).replace(/\D+/g, "").slice(-10); // last 10 digits
}
function formatPhone(d10) {
  if (!d10 || d10.length !== 10) return d10 || "";
  return `(${d10.slice(0,3)}) ${d10.slice(3,6)}-${d10.slice(6)}`;
}

// ---------- network helpers (timeouts, faster fail) ----------
async function fetchJson(url, opts = {}, tag = "") {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), opts.timeoutMs || 6000); // 6s timeout
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    log(`[${tag}] HTTP ${res.status} resp(${text.length}B)`);
    return { ok: res.ok, status: res.status, data, text };
  } catch (e) {
    err(`[${tag}] net`, e?.message || e);
    return { ok: false, status: 0, data: null, text: "" };
  } finally {
    clearTimeout(to);
  }
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
    else { onPartial?.(txt); }
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

// ---------- Make helper (with timeout) ----------
async function callMake(url, payload, tag) {
  const preview = JSON.stringify(payload);
  log(`[Make ${tag}] POST ${url} body(${preview.length}B): ${preview}`);
  return await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: preview,
    timeoutMs: 6000
  }, `Make ${tag}`);
}

// ---------- Persona (default) + Render-supplied prompt ----------
const DEFAULT_PROMPT = `
You are a friendly, confident receptionist for Old Line Barbershop.
Keep sentences short and natural. Never guess.
For booking/reschedule/cancel, collect/confirm: name, phone, service type, date and time.
Book only Mon–Fri 9am–5pm (local). No double-booking. Confirm details before finalizing.
Keep caller informed: “Let me check…”, “That works.”, “You’re confirmed.”
If you truly can’t help, say: “I’m not sure about that, let me transfer you to someone who can help.” Then end the call politely.
`;
const AGENT_PROMPT = (process.env.AGENT_PROMPT || DEFAULT_PROMPT).toString().slice(0, 8000);
log("[agent] Using AGENT_PROMPT (first 120 chars):", AGENT_PROMPT.replace(/\s+/g, " ").slice(0, 120), "…");

// ---------- OpenAI extraction (JSON + suggested reply) ----------
async function extractBookingData(userText, memory, callId) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const text = userText || "";
    const intent =
      /cancel|reschedule.*cancel/i.test(text) ? "DELETE" :
      /availability|what.*appointments|any.*appointments|do you have|are you open|free slots|openings/i.test(text) ? "READ" :
      /book|appointment|schedule|reserve|make.*appointment/i.test(text) ? "CREATE" :
      /price|how much|cost/i.test(text) ? "FAQ" :
      "UNKNOWN";
    return {
      intent,
      faq_topic: /price|how much|cost/i.test(text) ? "PRICES" : "",
      Event_Name: "", Start_Time: "", End_Time: "",
      Customer_Name: "", Customer_Phone: "", Customer_Email: "",
      id: "", Notes: "", window: { start: "", end: "" },
      ask: "NONE",
      reply: ""
    };
  }

  const { nowISO, tz } = nowContext();
  const sys = `You are a warm, efficient phone receptionist.
Return ONLY JSON. Current time: ${nowISO} ${tz}.
- Interpret times in ${tz}. If user says "tomorrow at 1", resolve to full ISO in ${tz}.
- Use empty string "" for unknown fields.
- Tone: natural, brief, micro-acks ("Got it.", "Sure."). Ask ONE thing at a time.
Schema:
{
  "intent": "CREATE|READ|DELETE|FAQ|SMALLTALK|UNKNOWN",
  "faq_topic": "HOURS|PRICES|LOCATION|\"\"",
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
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    temperature: 0.2, // structure-first
    max_tokens: 220,
    messages: [
      // Render-supplied behavior prompt FIRST
      { role: "system", content: AGENT_PROMPT },
      // Then the extractor schema/contract
      { role: "system", content: sys },
      { role: "user", content: `State:
phase: ${memory.phase || "collect_time"}
known: ${JSON.stringify({name:memory.name, phone:memory.phone, email:memory.email, service:memory.service, startISO:memory.startISO, endISO:memory.endISO})}
CallID:${callId}` },
      { role: "user", content: `Caller said: ${userText}` }
    ]
  };

  const res = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 6000
  }, "OpenAI extract");

  if (!res.ok) return { intent: "UNKNOWN", ask: "NONE", reply: "" };

  const raw = res.data?.choices?.[0]?.message?.content || "{}";
  let out; try { out = JSON.parse(raw); } catch { out = { intent: "UNKNOWN", ask: "NONE", reply: "" }; }
  log("[extract JSON]", out);
  return out;
}

// ---------- NLG helper for final human reply (esp. FAQ/READ after facts) ----------
async function generateReply({ userText, memory, phase, intent, faq_topic, facts }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";
  const sys = `You are a warm front-desk receptionist.
Write exactly ONE short, conversational sentence for the phone next.
Use contractions and micro-acks. If facts are provided, state them plainly.
Ask only ONE clear question next (appropriate for the phase). If FAQ, end with a gentle nudge toward booking.
Avoid repeating the same wording just used. Keep it under 25 words.`;
  const body = {
    model: "gpt-4o-mini",
    temperature: 0.55,
    top_p: 0.95,
    max_tokens: 60,
    messages: [
      // Render-supplied behavior prompt FIRST
      { role: "system", content: AGENT_PROMPT },
      // Then style constraints
      { role: "system", content: sys },
      { role: "user", content: `phase=${phase}, intent=${intent}, faq_topic=${faq_topic}` },
      { role: "user", content: `known=${JSON.stringify({ name:memory.name, phone:memory.phone, service:memory.service, startISO:memory.startISO })}` },
      { role: "user", content: `facts=${JSON.stringify(facts || {})}` },
      { role: "user", content: `caller=${userText}` }
    ]
  };

  const res = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 5500
  }, "OpenAI nlg");

  if (!res.ok) return "";
  return (res.data?.choices?.[0]?.message?.content || "").trim();
}

// ---------- FAQ facts via Make (no hardcoding) + in-memory cache ----------
const faqCache = new Map(); // key = topic
async function getFaqFactsFromMake(topic) {
  if (faqCache.has(topic)) return faqCache.get(topic);
  const r = await callMake(MAKE_READ, { intent: "FAQ", topic }, "FAQ");
  // Expect Make to return at least one of: prices/hoursText/address
  let facts = {};
  if (r.ok && r.data) {
    const d = r.data;
    if (d.prices || d.hoursText || d.address) facts = d;
    else if (typeof d === "string") facts = { note: d };
    else if (d.events) facts = {}; // wrong payload (calendar); ignore
  }
  faqCache.set(topic, facts);
  return facts;
}

// ---------- TTS: ElevenLabs (with barge-in support) ----------
let currentTts = { abort: () => {} };
async function speakEleven(ws, streamSid, text) {
  if (!streamSid || !text) return;
  const key = process.env.ELEVEN_API_KEY, voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) { log("(!) ELEVEN vars missing — TTS skipped:", text); return; }
  log("[TTS ->]", text);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  const controller = new AbortController();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_settings: { stability: 0.45, similarity_boost: 0.8 } }),
      signal: controller.signal
    });
  } catch (e) { err("[TTS] net", e?.message || e); return; }
  if (!res.ok || !res.body) { err("[TTS] HTTP", res.status, await res.text()); return; }

  let aborted = false;
  currentTts.abort = () => { try { aborted = true; controller.abort(); res.body?.destroy(); } catch {} };

  return new Promise((resolve) => {
    res.body.on("data", (chunk) => {
      if (aborted) return;
      try {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: Buffer.from(chunk).toString("base64") } }));
      } catch (e) { err("[TTS] ws send]", e?.message || e); }
    });
    res.body.on("end", () => { log("[TTS] end"); resolve(); });
  });
}

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
  let lastSpokenAt = 0;
  let biz = "default";

  // ask/reprompt guards
  let lastAsk = { kind: "", at: 0, text: "" };
  let sameAskCount = 0;
  function recentlyAsked(kind, ms = 4000) { return lastAsk.kind === kind && Date.now() - lastAsk.at < ms; }
  async function ask(kind, text) {
    if (recentlyAsked(kind)) return;
    if (text === lastAsk.text) sameAskCount++; else sameAskCount = 0;
    lastAsk = { kind, at: Date.now(), text };
    await say(text);
  }

  // ping/pong keepalive
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  const pingIv = setInterval(() => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }, 25000);

  // conversational memory
  const memory = { name: "", phone: "", email: "", service: "", startISO: "", endISO: "", phase: "collect_time" };

  // conversation phases: Collect -> Check -> Contact -> Confirm -> Book
  let phase = "collect_time"; // initial phase after greeting
  let lastSaid = "";

  function logSlots(where) { log(`[slots:${where}]`, JSON.stringify({ phase, ...memory })); }

  async function say(text) {
    if (!text) return;
    if (text === lastSaid) { log("[debounce] suppress repeat:", text); return; }
    lastSaid = text;
    await speakEleven(ws, streamSid, text);
    lastSpokenAt = Date.now();
  }

  // gentle inactivity reprompt (smart, non-repeating, with examples)
  const INACTIVITY_MS = 12000;
  const repromptIv = setInterval(() => {
    const now = Date.now();
    if (now - lastSpokenAt < 1500) return; // give space after speaking
    const idle = now - lastUserAt;
    if (idle < INACTIVITY_MS) return;

    if (phase === "collect_time") {
      if (!memory.service) return ask("SERVICE", sameAskCount >= 2
        ? "I can book a haircut or a beard trim. Which do you want?"
        : "Would you like a haircut or a beard trim?");
      if (!memory.startISO) {
        const text = sameAskCount >= 2
          ? "What day and time works for you? (For example: “Tomorrow at 3 pm” or “Friday morning”)"
          : "What day and time works for you?";
        return ask("TIME", text);
      }
    } else if (phase === "collect_contact") {
      if (!memory.name)  return ask("NAME", "What name should I put on it?");
      if (!memory.phone) return ask("PHONE", "What’s the best phone number?");
    } else if (phase === "confirm_booking") {
      const when = pretty(memory.startISO, LOCAL_TZ);
      return ask("CONFIRM", `Should I book ${memory.service} for ${memory.name} at ${when}?`);
    }
  }, 3000);

  // ask only ONE thing depending on phase (with ask-guard)
  async function nextQuestion() {
    if (phase === "collect_time") {
      if (!memory.service) return ask("SERVICE", "Would you like a haircut or a beard trim?");
      if (!memory.startISO) return ask("TIME", "What day and time would you like?");
      // have both → advance
      phase = "check_availability";
      return await handlePhase();
    }
    if (phase === "collect_contact") {
      if (!memory.name)  return ask("NAME", "What name should I put on it?");
      if (!memory.phone) return ask("PHONE", "What’s the best phone number?");
      phase = "confirm_booking";
      return await handlePhase();
    }
    if (phase === "confirm_booking") {
      const when = pretty(memory.startISO, LOCAL_TZ);
      return ask("CONFIRM", `I have you for a ${memory.service} for ${memory.name}, ${when}. Go ahead and book it?`);
    }
  }

  // availability check and booking
  async function handlePhase() {
    if (phase === "check_availability") {
      // business hours gate first
      if (!isBusinessHours(memory.startISO, LOCAL_TZ)) {
        log("[gate] outside business hours:", memory.startISO);
        return ask("TIME", "We book Monday to Friday, 9 to 5. What time works in those hours?");
      }
      await ask("BACKCHANNEL", "One moment while I check availability.");
      const win = { start: memory.startISO, end: memory.endISO || memory.startISO };
      const check = await callMake(MAKE_READ, { intent: "READ", window: win }, "READ-check");
      const events = Array.isArray(check?.data?.events) ? check.data.events : [];
      if (events.length) {
        log("[gate] conflict found]:", events.length);
        return ask("TIME", "That time is already booked. What other time works for you?");
      }
      // available → move to contact collection
      phase = "collect_contact";
      return nextQuestion();
    }
    if (phase === "confirm_booking") {
      // speak confirm line in nextQuestion; actual booking after “yes”
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
    if (ex.Start_Time)     memory.startISO = ex.Start_Time;
    if (ex.End_Time)       memory.endISO = ex.End_Time;

    // if service still unknown but the utterance contains hints, try to infer
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
  function isFlexible(txt="") {
    return /\b(any|whenever|no (preference|pref)|whenever works|any time|you pick|up to you)\b/i.test(txt);
  }

  async function proposeNextAvailable() {
    // Ask Make for next available slot in business hours; implement on Make side.
    await ask("BACKCHANNEL", "Let me find the next available slot.");
    const r = await callMake(MAKE_READ, { intent: "NEXT_AVAILABLE", window: { start: new Date().toISOString(), end: "" } }, "READ-next");
    const slot = r?.data?.next || null; // expect ISO string or { start, end }
    if (slot?.start || slot) {
      const startISO = slot.start || slot;
      memory.startISO = startISO;
      phase = "collect_contact";
      const when = pretty(startISO, LOCAL_TZ);
      return ask("CONFIRM", `I can do ${when}. Want to grab that?`);
    }
    // fallback: ask for a day part
    return ask("TIME", "Morning or afternoon works better for you?");
  }

  async function onUserUtterance(txt) {
    lastUserAt = Date.now();
    currentTts.abort?.(); // barge-in
    sameAskCount = 0;     // reset loop counter on new input

    // Flexible time: user says "any time" → propose next available
    if (phase === "collect_time" && !memory.startISO && isFlexible(txt)) {
      return proposeNextAvailable();
    }

    // Track phase in memory for the extractor
    memory.phase = phase;

    // Use GPT to classify and optionally suggest the next line
    const ex = await extractBookingData(txt, memory, callSid);
    ex.utterance = txt;
    log("[extracted]", ex);
    mergeExtract(ex);

    // FAQ → fetch facts from Make, then let GPT craft reply; return immediately to avoid double ask
    if (ex.intent === "FAQ") {
      const facts = await getFaqFactsFromMake(ex.faq_topic || "");
      const line = await generateReply({
        userText: txt, memory, phase, intent: ex.intent, faq_topic: ex.faq_topic || "", facts
      });
      if (line) { await say(line); return; }
    }

    // DELETE by id
    if (ex.intent === "DELETE") {
      if (!ex.id) return ask("DELETE", "What’s the appointment ID to cancel?");
      await ask("BACKCHANNEL", "Okay—cancelling that now.");
      const r = await callMake(MAKE_DELETE, { id: ex.id }, "DELETE");
      if (r.ok) await say("Your appointment is cancelled. Thanks for calling Old Line Barbershop. Goodbye.");
      else      await say("I couldn’t cancel that one. Want me to try again?");
      return;
    }

    // READ → number of events; GPT phrases it with facts
    if (ex.intent === "READ") {
      const win = ex.window?.start ? ex.window :
        (memory.startISO ? { start: memory.startISO, end: memory.endISO || memory.startISO }
                          : { start: new Date().toISOString(), end: new Date(Date.now()+24*3600e3).toISOString() });
      await ask("BACKCHANNEL", "Let me check our schedule.");
      const r = await callMake(MAKE_READ, { intent: "READ", window: win }, "READ");
      const events = Array.isArray(r?.data?.events) ? r.data.events : [];
      const line = await generateReply({
        userText: txt, memory, phase, intent: "READ", faq_topic: "", facts: { count: events.length, window: win }
      });
      if (line) { await say(line); return; }
      if (!events.length) await ask("TIME", "No appointments in that window. What time works for you?");
      else                await ask("TIME", `I found ${events.length}. What time did you have in mind?`);
      return;
    }

    // Prefer GPT’s suggested natural line if provided (and STOP; avoids double-ask)
    if (ex.reply) { await say(ex.reply); return; }

    // CREATE / UNKNOWN go through phases with guards
    if (phase === "collect_time") {
      if (memory.service && memory.startISO) {
        phase = "check_availability";
        return handlePhase();
      }
      if (!memory.service && (ex.ask === "SERVICE" || /hair|beard|trim|cut/i.test(txt))) {
        const g = normalizeService(txt);
        if (!g) return ask("SERVICE", "Would you like a haircut or a beard trim?");
      }
      if (ex.ask === "SERVICE" && !memory.service) return ask("SERVICE", "Would you like a haircut or a beard trim?");
      if (ex.ask === "TIME" && !memory.startISO)   return ask("TIME", "What day and time works for you?");
      return nextQuestion();
    }

    if (phase === "check_availability") {
      if (memory.service && memory.startISO) return handlePhase();
      return nextQuestion();
    }

    if (phase === "collect_contact") {
      if (memory.name && memory.phone) {
        phase = "confirm_booking";
        return handlePhase().then(nextQuestion);
      }
      if (ex.ask === "NAME" && !memory.name)   return ask("NAME", "What name should I put on it?");
      if (ex.ask === "PHONE" && !memory.phone) return ask("PHONE", "What’s the best phone number?");
      return nextQuestion();
    }

    if (phase === "confirm_booking") {
      if (isAffirmative(txt)) {
        const when = pretty(memory.startISO, LOCAL_TZ);
        const createReq = {
          Event_Name: memory.service || "Appointment",
          Start_Time: memory.startISO,
          End_Time:   memory.endISO || "",
          Customer_Name:  memory.name,
          Customer_Phone: memory.phone,
          Customer_Email: memory.email || "",
          Notes: `Booked by phone agent. CallSid=${callSid}`
        };
        await ask("BACKCHANNEL", "Got it—booking that now.");
        const r = await callMake(MAKE_CREATE, createReq, "CREATE");
        if (r.ok) await say(`All set — your ${memory.service} is booked for ${when}. Thanks for calling Old Line Barbershop. Goodbye.`);
        else      await say("Sorry — I couldn’t complete the booking. Want me to try a different time?");
        return;
      }
      if (isNegative(txt)) {
        return ask("TIME", "Okay, I won’t book it. What other time works for you?");
      }
      // unclear yes/no → rephrase once instead of repeating
      return ask("CONFIRM", "Should I lock that in, or do you want a different time?");
    }

    // fallback
    return ask("HELP", "I can help book, reschedule, or cancel. What would you like to do?");
  }

  // ---------- WS handlers ----------
  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      callSid   = evt.start?.callSid || null;
      const b = evt.start?.customParameters?.biz || "default";
      biz = b; // persist
      log("WS CONNECTED |", streamSid, "| CallSid:", callSid, "| biz:", biz);

      // Deepgram
      const dg = startDeepgram({
        onOpen: () => log("[ASR] ready"),
        onPartial: () => { lastUserAt = Date.now(); currentTts.abort?.(); }, // barge-in ASAP
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

const appServer = server.listen(PORT, () => log(`Server running on ${PORT}`));
