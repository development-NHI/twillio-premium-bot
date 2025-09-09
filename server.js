// server.js — Old Line Barbershop phone agent (all spoken text from GPT)
// Twilio Media Streams (μ-law 8k) -> Deepgram (ASR) -> OpenAI (extract+NLG, using a single persona prompt) -> Make (READ/CREATE/DELETE/FAQ) -> ElevenLabs (TTS)

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;
const LOCAL_TZ = process.env.LOCAL_TZ || "America/New_York";

// ===== Make webhooks (configure in env) =====
const MAKE_CREATE = process.env.MAKE_CREATE || "https://hook.us2.make.com/7hd4nxdrgytwukxw57cwyykhotv6hxrm";
const MAKE_READ   = process.env.MAKE_READ   || "https://hook.us2.make.com/6hmur673mpqw4xgy2bhzx4be4o32ziax";
const MAKE_DELETE = process.env.MAKE_DELETE || "https://hook.us2.make.com/noy0e27knj7e1jlomtznw34z246i3xtv";

// ===== Logging =====
const log = (...a) => console.log(new Date().toISOString(), "-", ...a);
const err = (...a) => console.error(new Date().toISOString(), "!", ...a);

// ===== Time helpers =====
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
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d);
  const hr  = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(d));
  const monFri = ["Mon","Tue","Wed","Thu","Fri"].includes(day);
  return monFri && hr >= 9 && hr < 17;
}

// ===== μ-law → PCM16 =====
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

// ===== Normalization =====
const SERVICE_ALIASES = {
  "haircut": ["haircut","cut","basic haircut","regular haircut","mens cut","men's cut","trim hair","standard haircut"],
  "Beard Trim": ["beard trim","beard","line up","line-up","beard lineup","beard shape"]
};
function normalizeService(raw) {
  if (!raw) return "";
  const s = String(raw).toLowerCase();
  for (const canonical of Object.keys(SERVICE_ALIASES)) {
    if (SERVICE_ALIASES[canonical].some(a => s.includes(a))) return canonical;
  }
  if (/\bhair\s*cut|haircut\b/.test(s)) return "haircut";
  if (/\bbeard\b/.test(s)) return "Beard Trim";
  return "";
}
function digitsOnlyPhone(p) { return (p || "").replace(/\D+/g, "").slice(-10); }
function formatPhone(d10) { return d10 && d10.length===10 ? `(${d10.slice(0,3)}) ${d10.slice(3,6)}-${d10.slice(6)}` : d10 || ""; }

// ===== Fetch helper (timeout+retry) =====
async function fetchJson(url, opts = {}, tag = "") {
  const attempt = async (ms) => {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      log(`[${tag}] HTTP ${res.status} resp(${text.length}B)`);
      return { ok: res.ok, status: res.status, data, text };
    } catch (e) {
      err(`[${tag}] net`, e?.message || e);
      return { ok: false, status: 0, data: null, text: "" };
    } finally { clearTimeout(to); }
  };
  const a = await attempt(opts.timeoutMs || 4500);
  if (a.ok) return a;
  return await attempt(3000);
}

async function callMake(url, payload, tag) {
  const body = JSON.stringify(payload);
  log(`[Make ${tag}] POST ${url} body(${body.length}B): ${body}`);
  return await fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeoutMs: 4000
  }, `Make ${tag}`);
}

// ===== ASR (Deepgram) =====
function startDeepgram({ onOpen, onPartial, onFinal, onError, onAny }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) { log("(!) No DEEPGRAM_API_KEY — ASR disabled."); return null; }

  const url = "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16&sample_rate=8000&channels=1"
    + "&model=nova-2-phonecall&interim_results=true&smart_format=true"
    + "&language=en-US&endpointing=200";

  const dg = new WebSocket(url, { headers: { Authorization: `Token ${key}` }, perMessageDeflate: false });
  let open = false;
  const q = [];

  dg.on("open", () => { open = true; log("[ASR] Deepgram open"); onOpen?.(); while (q.length) { try { dg.send(q.shift()); } catch {} }});
  dg.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    onAny?.(msg);
    if (msg.type !== "Results") return;
    const alt = msg.channel?.alternatives?.[0];
    const txt = (alt?.transcript || "").trim();
    if (!txt) return;
    if (msg.is_final || msg.speech_final) { log("[ASR final]", txt); onFinal?.(txt); }
    else { onPartial?.(txt); }
  });
  dg.on("error", (e) => { err("[ASR] error", e?.message || e); onError?.(e); });
  dg.on("close", (c, r) => log("[ASR] closed", c, r?.toString?.() || ""));

  return {
    sendPCM16LE(buf) { try { if (open && dg.readyState === 1) dg.send(buf); else q.push(buf); } catch (e) { err("[ASR send]", e?.message || e); } },
    close() { try { dg.close(); } catch {} }
  };
}

// ===== Persona (Render prompt) =====
// We use ONE persona for BOTH extraction and NLG. No separate “mini prompt” with canned wording.
const DEFAULT_PROMPT = `
You are a friendly, human-sounding AI receptionist for Old Line Barbershop.
Your job is to answer the phone, sound natural, and help customers with the same tasks a real receptionist would handle.

Core Responsibilities
- Greet callers warmly and always say the business name right away.
- Answer common questions clearly and directly (hours, pricing, services, location, etc.).
- Handle scheduling: booking, rescheduling, and cancellations.

Booking order:
1) Ask what service they want. 2) Ask preferred date & time. 3) Confirm availability. 4) Ask for name & phone. 5) Finalize.

Rules
- Speak in short, natural sentences. One question at a time.
- Keep FAQs separate from booking. Only enter booking if caller asks to book/reschedule/cancel or clearly agrees to book.
- If you don’t know, say: “I’m not sure about that, let me transfer you to someone who can help.” Then end the call.
- Don’t re-ask details already provided.

Constraints
- Book only Mon–Fri, 9 AM–5 PM local time. Never double-book. Confirm details before finalizing.
- When finishing: thank the caller and hang up promptly.

Tone: Friendly, professional, helpful, confident, natural.
`;
const AGENT_PROMPT = (process.env.AGENT_PROMPT || DEFAULT_PROMPT).toString().slice(0, 8000);
log("[agent] Using AGENT_PROMPT (first 120 chars):", AGENT_PROMPT.replace(/\s+/g," ").slice(0,120), "…");

// ===== OpenAI helpers =====
async function openaiChatJSON(messages, { max_tokens=220, temperature=0.3, timeoutMs=4500, tag="OpenAI" } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok:false, data:null };
  const body = {
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    max_tokens, temperature,
    messages
  };
  const res = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs
  }, tag);
  if (!res.ok) return { ok:false, data:null };
  let raw = res.data?.choices?.[0]?.message?.content || "{}";
  let out; try { out = JSON.parse(raw); } catch { out = {}; }
  return { ok:true, data: out };
}

async function openaiChatLINE(messages, { max_tokens=70, temperature=0.5, timeoutMs=4000, tag="OpenAI nlg" } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok:false, text:"" };
  const body = {
    model: "gpt-4o-mini",
    max_tokens, temperature,
    messages
  };
  const res = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs
  }, tag);
  if (!res.ok) return { ok:false, text:"" };
  const text = (res.data?.choices?.[0]?.message?.content || "").trim();
  return { ok:true, text };
}

// Extraction: single persona; we provide state and ask for pure JSON (no copy).
async function extractBookingData(userText, memory, lastIntent) {
  const { nowISO, tz } = nowContext();
  const sys = `
${AGENT_PROMPT}

Current time: ${nowISO} ${tz}.
Return ONLY this JSON schema. Do not add commentary.

{
  "intent": "CREATE|READ|DELETE|FAQ|SMALLTALK|UNKNOWN",
  "faq_topic": "HOURS|PRICES|LOCATION|SERVICES|\"\"",
  "Event_Name": string,
  "Start_Time": string,   // full ISO if user implied a time; otherwise ""
  "End_Time": string,     // may be ""
  "Customer_Name": string,
  "Customer_Phone": string, // digits or formatted; leave "" if not provided
  "Customer_Email": string,
  "id": string,           // appointment id for DELETE, else ""
  "Notes": string,
  "window": { "start": string, "end": string }, // for reads or flexible time windows
  "ask": "NONE|SERVICE|TIME|NAME|PHONE|CONFIRM",
  "reply": string         // optional short natural sentence for the very next thing to say
}

Rules:
- Interpret times in ${tz} (e.g., “Friday at noon” => next Friday 12:00 in ${tz}).
- Ask ONE thing at a time.
- Never greet again mid-call.
- Don’t push booking unless caller asked or agreed to book.
- Keep reply short and conversational if you include it.
`;

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: JSON.stringify({
        state: { phase: memory.phase, known: { name:memory.name, phone:memory.phone, phoneCandidate:memory.phoneCandidate, service:memory.service, startISO:memory.startISO, endISO:memory.endISO } },
        lastIntent, utterance: userText
      })
    }
  ];

  const r = await openaiChatJSON(messages, { tag:"OpenAI extract", max_tokens: 240, temperature: 0.2 });
  if (!r.ok) return { intent:"UNKNOWN", ask:"NONE", reply:"" };
  return r.data || { intent:"UNKNOWN", ask:"NONE", reply:"" };
}

// NLG: single persona; we give phase/goal and facts, GPT writes one line.
// No miniature “sys prompt” beyond behavioral guardrails — all tone comes from AGENT_PROMPT.
async function nlgLine({ memory, goal, forbidGreet, facts, lastUser }) {
  const behavior = `
Write ONE short, conversational line for a phone call.
- Use contractions, micro-acknowledgements, natural pacing.
- Ask at most ONE question.
- No greeting if forbidGreet=${!!forbidGreet}.
- Avoid repeating earlier wording.
- Keep it under ~20 words.
`;
  const messages = [
    { role: "system", content: AGENT_PROMPT },
    { role: "system", content: behavior },
    { role: "user", content: JSON.stringify({
        phase: memory.phase,
        known: { name:memory.name, phone:memory.phone, phoneCandidate:memory.phoneCandidate, service:memory.service, startISO:memory.startISO },
        goal, facts: facts || {}, lastUser: lastUser || ""
      })
    }
  ];
  const r = await openaiChatLINE(messages, { tag:"OpenAI nlg", max_tokens: 60, temperature: 0.5 });
  return r.ok ? r.text : "";
}

// ===== FAQ caching =====
const faqCache = new Map();
async function getFaqFactsFromMake(topic) {
  if (!topic) return {};
  if (faqCache.has(topic)) return faqCache.get(topic);
  const r = await callMake(MAKE_READ, { intent: "FAQ", topic }, "FAQ");
  let facts = {};
  if (r.ok && r.data) facts = r.data;
  faqCache.set(topic, facts);
  return facts;
}

// ===== TTS (ElevenLabs) =====
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
      } catch (e) { err("[TTS send]", e?.message || e); }
    });
    res.body.on("end", () => { log("[TTS] end"); resolve(); });
  });
}

// ===== HTTP & WS =====
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

// ===== Session per call =====
wss.on("connection", (ws) => {
  let streamSid = null;
  let callSid = null;
  let frames = 0;

  let greetedOnce = false;
  let ended = false;
  let lastUserAt = Date.now();
  let lastSpokenAt = 0;
  let lastSpokenText = "";
  let lastIntent = "UNKNOWN";

  // conversation memory
  const memory = {
    name: "", phone: "", phoneCandidate: "", email: "",
    service: "", startISO: "", endISO: "",
    phase: "idle" // idle → faq_only | collect_time | check_availability | collect_contact | confirm_booking | ended
  };

  function logSlots(where) { log(`[slots:${where}]`, JSON.stringify({ ...memory })); }

  async function speakFromGPT({ goal, facts, lastUser, forbidGreet }) {
    if (ended) return;
    const text = await nlgLine({ memory, goal, facts, lastUser, forbidGreet });
    if (!text) return;
    if (text === lastSpokenText) { log("[debounce] suppress repeat:", text); return; }
    await speakEleven(ws, streamSid, text);
    lastSpokenText = text;
    lastSpokenAt = Date.now();
  }

  // inactivity reprompt — asks are also GPT-generated
  const repromptIv = setInterval(() => {
    if (ended) return;
    const idle = Date.now() - lastUserAt;
    if (idle < 10000) return;

    if (memory.phase === "collect_time") {
      if (!memory.service) return speakFromGPT({ goal: "Ask which service they want", forbidGreet: true });
      if (!memory.startISO) return speakFromGPT({ goal: "Ask for a preferred date and time with 1 example", forbidGreet: true });
    } else if (memory.phase === "collect_contact") {
      if (memory.phoneCandidate && !memory.phone) return speakFromGPT({ goal: `Confirm caller phone ${memory.phoneCandidate} is OK to use`, forbidGreet: true });
      if (!memory.name) return speakFromGPT({ goal: "Ask for their name", forbidGreet: true });
      if (!memory.phone) return speakFromGPT({ goal: "Ask for the best phone number", forbidGreet: true });
    } else if (memory.phase === "confirm_booking") {
      const when = pretty(memory.startISO, LOCAL_TZ);
      return speakFromGPT({ goal: `Ask to confirm booking of ${memory.service} at ${when} for ${memory.name}`, forbidGreet: true });
    }
  }, 3200);

  function mergeExtract(ex) {
    if (ex.Customer_Name)  memory.name = ex.Customer_Name.trim();
    if (ex.Customer_Phone) {
      const d = digitsOnlyPhone(ex.Customer_Phone);
      if (d) memory.phone = formatPhone(d);
    }
    if (ex.Customer_Email) memory.email = ex.Customer_Email;
    if (ex.Event_Name)     memory.service = normalizeService(ex.Event_Name) || memory.service;
    if (ex.Start_Time)     memory.startISO = ex.Start_Time;
    if (ex.End_Time)       memory.endISO = ex.End_Time;
    logSlots("merge");
  }

  function isAffirmative(txt="") { return /\b(yes|yeah|yep|sure|please|book|go ahead|confirm|sounds good|that works|okay|ok)\b/i.test(txt); }
  function isNegative(txt="")   { return /\b(no|nah|nope|stop|wait|cancel|not now|maybe later)\b/i.test(txt); }
  function isFlexible(txt="")   { return /\b(any|whenever|no (preference|pref)|you pick|up to you|either|morning|afternoon)\b/i.test(txt); }
  function looksLikeGreeting(s="") { return /thanks for calling Old Line Barbershop|how can I help you today/i.test(s || ""); }

  async function proposeNextAvailable(lastUser) {
    await speakFromGPT({ goal: "Acknowledge and say you're checking the next open time", forbidGreet: true });
    const r = await callMake(MAKE_READ, { intent: "NEXT_AVAILABLE", window: { start: new Date().toISOString(), end: "" } }, "READ-next");
    const slot = r?.data?.next || null;
    if (slot?.start || slot) {
      const startISO = slot.start || slot;
      memory.startISO = startISO;
      memory.phase = "collect_contact";
      const when = pretty(startISO, LOCAL_TZ);
      return speakFromGPT({ goal: `Offer the ${when} slot and ask if they want it`, forbidGreet: true, lastUser });
    }
    return speakFromGPT({ goal: "Ask if morning or afternoon is better", forbidGreet: true });
  }

  async function handleAvailabilityCheck(lastUser) {
    if (!memory.startISO || !memory.service) { memory.phase = "collect_time"; return; }
    if (!isBusinessHours(memory.startISO, LOCAL_TZ)) {
      return speakFromGPT({ goal: "Explain we book Mon–Fri 9–5 and ask for another time within those hours", forbidGreet: true });
    }

    await speakFromGPT({ goal: "Acknowledge and say you're checking the schedule briefly", forbidGreet: true });
    const win = { start: memory.startISO, end: memory.endISO || memory.startISO };
    const check = await callMake(MAKE_READ, { intent: "READ", window: win }, "READ-check");
    const events = Array.isArray(check?.data?.events) ? check.data.events : [];
    if (events.length) {
      return speakFromGPT({ goal: "Politely say that time is taken and ask for another time", forbidGreet: true, facts: { conflict: true } });
    }
    // available → collect contact
    memory.phase = "collect_contact";
    if (memory.phoneCandidate && !memory.phone) {
      return speakFromGPT({ goal: `Confirm caller phone ${memory.phoneCandidate} is OK to use`, forbidGreet: true, lastUser });
    }
    if (!memory.name)  return speakFromGPT({ goal: "Ask for their name", forbidGreet: true, lastUser });
    if (!memory.phone) return speakFromGPT({ goal: "Ask for the best phone number", forbidGreet: true, lastUser });

    memory.phase = "confirm_booking";
    const when = pretty(memory.startISO, LOCAL_TZ);
    return speakFromGPT({ goal: `Ask to confirm booking of ${memory.service} for ${memory.name} at ${when}`, forbidGreet: true, lastUser });
  }

  async function onUserUtterance(txt) {
    if (ended) return;
    lastUserAt = Date.now();
    currentTts.abort?.(); // barge-in

    if (memory.phase === "collect_time" && !memory.startISO && isFlexible(txt)) {
      return proposeNextAvailable(txt);
    }

    const ex = await extractBookingData(txt, memory, lastIntent);
    ex.utterance = txt;
    lastIntent = ex.intent || lastIntent;

    // Prevent model re-greeting mid-call
    if (looksLikeGreeting(ex.reply) && greetedOnce) ex.reply = "";

    // Merge slot-ish fields
    mergeExtract(ex);

    // Handle FAQs — answer but don’t push into booking unless user later opts in
    if (ex.intent === "FAQ") {
      memory.phase = memory.phase === "idle" ? "faq_only" : memory.phase;
      const facts = await getFaqFactsFromMake(ex.faq_topic || "");
      // Prefer model’s reply; otherwise ask it to produce one line
      const line = ex.reply && ex.reply.trim().length > 0
        ? ex.reply.trim()
        : await nlgLine({ memory, goal: `Answer FAQ topic ${ex.faq_topic || "GENERAL"} and optionally offer help`, forbidGreet: greetedOnce, facts, lastUser: txt });
      if (line) await speakEleven(ws, streamSid, line);
      lastSpokenText = line;
      lastSpokenAt = Date.now();
      return;
    }

    // If user says "yes" after FAQ and we have or can infer service → move to booking
    if (memory.phase === "faq_only" && isAffirmative(txt)) {
      if (!memory.service) { memory.phase = "collect_time"; return speakFromGPT({ goal: "Ask which service they'd like to book", forbidGreet: true }); }
      memory.phase = "collect_time";
      return speakFromGPT({ goal: "Ask for preferred date and time", forbidGreet: true });
    }

    // DELETE
    if (ex.intent === "DELETE") {
      if (!ex.id) {
        return speakFromGPT({ goal: "Ask for the appointment ID to cancel", forbidGreet: true });
      }
      await speakFromGPT({ goal: "Acknowledge and say you're cancelling now", forbidGreet: true });
      const r = await callMake(MAKE_DELETE, { id: ex.id }, "DELETE");
      if (r.ok) {
        await speakFromGPT({ goal: "Confirm cancellation and say goodbye and end the call", forbidGreet: true });
        ended = true; memory.phase = "ended";
        clearInterval(repromptIv); setTimeout(()=>{ try{ws.close();}catch{} }, 600);
      } else {
        await speakFromGPT({ goal: "Apologize, cancellation failed, ask if they want to try again", forbidGreet: true });
      }
      return;
    }

    // READ (availability lookup)
    if (ex.intent === "READ") {
      const win = ex.window?.start ? ex.window :
        (memory.startISO ? { start: memory.startISO, end: memory.endISO || memory.startISO }
                         : { start: new Date().toISOString(), end: new Date(Date.now()+24*3600e3).toISOString() });
      await speakFromGPT({ goal: "Say you're checking the schedule", forbidGreet: true });
      const r = await callMake(MAKE_READ, { intent: "READ", window: win }, "READ");
      const events = Array.isArray(r?.data?.events) ? r.data.events : [];
      await speakFromGPT({ goal: `Summarize availability count and ask if they want to book`, facts: { count: events.length, window: win }, forbidGreet: true, lastUser: txt });
      return;
    }

    // CREATE (booking)
    if (ex.intent === "CREATE" || (isAffirmative(txt) && memory.phase !== "confirm_booking")) {
      // pipeline: service → time → check → name/phone → confirm → create
      if (!memory.service) { memory.phase = "collect_time"; return speakFromGPT({ goal: "Ask which service they'd like to book", forbidGreet: true, lastUser: txt }); }
      if (!memory.startISO) { memory.phase = "collect_time"; return speakFromGPT({ goal: "Ask for preferred date and time with a quick example", forbidGreet: true, lastUser: txt }); }
      memory.phase = "check_availability";
      return handleAvailabilityCheck(txt);
    }

    // If extraction supplied a next reply, use it (still model-generated)
    if (ex.reply && ex.reply.trim()) {
      await speakEleven(ws, streamSid, ex.reply.trim());
      lastSpokenText = ex.reply.trim();
      lastSpokenAt = Date.now();
      return;
    }

    // Contact collection
    if (memory.phase === "collect_contact") {
      if (!memory.name)  return speakFromGPT({ goal: "Ask for their name", forbidGreet: true, lastUser: txt });
      if (memory.phoneCandidate && !memory.phone) {
        if (isAffirmative(txt)) { memory.phone = memory.phoneCandidate; }
        else if (isNegative(txt)) { memory.phoneCandidate = ""; return speakFromGPT({ goal: "Ask for best phone number", forbidGreet: true }); }
      }
      if (!memory.phone) return speakFromGPT({ goal: "Ask for best phone number", forbidGreet: true });
      memory.phase = "confirm_booking";
      const when = pretty(memory.startISO, LOCAL_TZ);
      return speakFromGPT({ goal: `Ask to confirm booking ${memory.service} for ${memory.name} at ${when}`, forbidGreet: true });
    }

    // Confirm booking
    if (memory.phase === "confirm_booking") {
      if (isAffirmative(txt)) {
        const when = pretty(memory.startISO, LOCAL_TZ);
        const createReq = {
          Event_Name: memory.service || "Appointment",
          Start_Time: memory.startISO,
          End_Time:   memory.endISO || "",
          Customer_Name:  memory.name,
          Customer_Phone: memory.phone || memory.phoneCandidate || "",
          Customer_Email: memory.email || "",
          Notes: `Booked by phone agent. CallSid=${callSid}`
        };
        await speakFromGPT({ goal: "Acknowledge and say you're booking it now", forbidGreet: true });
        const r = await callMake(MAKE_CREATE, createReq, "CREATE");
        if (r.ok) {
          await speakFromGPT({ goal: `Confirm booking for ${when}, thank them, say goodbye, and hang up`, forbidGreet: true });
          ended = true; memory.phase = "ended"; clearInterval(repromptIv); setTimeout(()=>{ try{ws.close();}catch{} }, 600);
        } else {
          await speakFromGPT({ goal: "Apologize booking failed, ask if they want a different time", forbidGreet: true });
          memory.phase = "collect_time";
        }
        return;
      }
      if (isNegative(txt)) {
        memory.phase = "collect_time";
        return speakFromGPT({ goal: "Acknowledge and ask for another time", forbidGreet: true });
      }
      const when = pretty(memory.startISO, LOCAL_TZ);
      return speakFromGPT({ goal: `Ask again to confirm booking ${memory.service} for ${memory.name} at ${when}`, forbidGreet: true });
    }

    // Idle → small helpful line
    if (memory.phase === "idle") {
      memory.phase = "faq_only";
      return speakFromGPT({ goal: "Offer help concisely without greeting again", forbidGreet: true, lastUser: txt });
    }
  }

  // ===== WS events =====
  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      callSid   = evt.start?.callSid || null;

      const cp = evt.start?.customParameters || {};
      const rawCaller = cp.from || cp.caller || cp.phone || cp.From || "";
      if (rawCaller) {
        const d = digitsOnlyPhone(rawCaller);
        if (d) memory.phoneCandidate = formatPhone(d);
      }

      log("WS CONNECTED |", streamSid, "| CallSid:", callSid, "| phoneCandidate:", memory.phoneCandidate || "-");

      const dg = startDeepgram({
        onOpen: () => log("[ASR] ready"),
        onPartial: () => { lastUserAt = Date.now(); currentTts.abort?.(); },
        onFinal: (txt) => onUserUtterance(txt),
        onError: (e) => err("[ASR] err cb", e?.message || e),
        onAny:   (m) => { if (m.type && m.type !== "Results") log("[ASR msg]", JSON.stringify(m)); }
      });
      ws._dg = dg;

      // Initial greeting (from GPT)
      const greet = await nlgLine({
        memory,
        goal: "Give the opening greeting mentioning Old Line Barbershop and offer help",
        forbidGreet: false
      });
      if (greet) {
        await speakEleven(ws, streamSid, greet);
        lastSpokenText = greet;
        lastSpokenAt = Date.now();
      }
      greetedOnce = true;
      memory.phase = "idle";
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
      } catch (e) { err("[media] decode/send]", e?.message || e); }
    }

    else if (evt.event === "stop") {
      log("Twilio stream STOP");
      try { ws._dg?.close(); } catch {}
    }
  });

  function cleanup() {
    ended = true;
    try { ws._dg?.close(); } catch {}
    clearInterval(repromptIv);
    log("WS closed");
  }
  ws.on("close", cleanup);
  ws.on("error", (e) => { err("WS error", e?.message || e); cleanup(); });
});

// ===== Start server =====
const app = express();
