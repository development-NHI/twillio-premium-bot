// server.js — Premium phone agent with phased flow (one question at a time) + deep logs
// Pipeline: Twilio Media Streams (μ-law 8k) -> Deepgram (ASR) -> OpenAI (extraction JSON) -> Make (READ/CREATE/DELETE) -> ElevenLabs (TTS)

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

// ---------- Deepgram realtime ----------
function startDeepgram({ onOpen, onPartial, onFinal, onError, onAny }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) { log("(!) No DEEPGRAM_API_KEY — ASR disabled."); return null; }

  const url = "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16&sample_rate=8000&channels=1"
    + "&model=nova-2-phonecall&interim_results=true&smart_format=true"
    + "&language=en-US&endpointing=250";

  const dg = new WebSocket(url, { headers: { Authorization: `token ${key}` }, perMessageDeflate: false });
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
    // heuristic fallback
    return {
      intent: /cancel/i.test(userText) ? "DELETE" :
              /read|availability|open|what.*appointments|any.*appointments/i.test(userText) ? "READ" :
              /book|appointment|schedule|reserve/i.test(userText) ? "CREATE" : "UNKNOWN",
      Event_Name: "", Start_Time: "", End_Time: "", Customer_Name: "", Customer_Phone: "", Customer_Email: "",
      id: "", Notes: "", window: null
    };
  }

  const { nowISO, tz } = nowContext();
  const sys = `Return ONLY JSON. Current time: ${nowISO} ${tz}.
- Interpret times in ${tz}.
- If any info is missing, use "" (empty string).
Schema:
{
  "intent": "CREATE|READ|DELETE|UNKNOWN",
  "Event_Name": string,
  "Start_Time": string,
  "End_Time": string,
  "Customer_Name": string,
  "Customer_Phone": string,
  "Customer_Email": string,
  "id": string,
  "Notes": string,
  "window": { "start": string, "end": string }
}`;

  const body = {
    model: "gpt-4o-mini",
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
  } catch (e) { err("[OpenAI] net", e?.message || e); return { intent: "UNKNOWN" }; }

  if (!res.ok) { err("[OpenAI] HTTP", res.status, await res.text()); return { intent: "UNKNOWN" }; }

  const json = await res.json();
  const raw = json?.choices?.[0]?.message?.content || "{}";
  let out; try { out = JSON.parse(raw); } catch { out = { intent: "UNKNOWN" }; }
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
  let dg = null;
  let frames = 0;

  // conversational memory
  const memory = { name: "", phone: "", email: "", service: "", startISO: "", endISO: "" };
  const AGENT_PROMPT = process.env.AGENT_PROMPT || DEFAULT_PROMPT;

  // conversation phases: Collect -> Check -> Contact -> Confirm -> Book
  let phase = "collect_time"; // initial phase after greeting
  let lastSaid = "";

  function logSlots(where) { log(`[slots:${where}]`, JSON.stringify({ phase, ...memory })); }

  async function say(text) {
    if (!text) return;
    if (text === lastSaid) { log("[debounce] suppress repeat:", text); return; }
    lastSaid = text;
    await speakEleven(ws, streamSid, text);
  }

  // ask only ONE thing depending on phase
  async function nextQuestion() {
    if (phase === "collect_time") {
      if (!memory.service) return say("What service would you like — haircut or beard trim?");
      if (!memory.startISO) return say("What day and time would you like?");
      // have both → advance
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

  // availability check and booking
  async function handlePhase() {
    if (phase === "check_availability") {
      // business hours gate first
      if (!isBusinessHours(memory.startISO, LOCAL_TZ)) {
        log("[gate] outside business hours:", memory.startISO);
        return say("We book Monday to Friday, 9 to 5. What time works in those hours?");
      }
      const win = { start: memory.startISO, end: memory.endISO || memory.startISO };
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
      // will speak confirmation line in nextQuestion; actual booking after “yes”
      return;
    }
  }

  function mergeExtract(ex) {
    if (ex.Customer_Name)  memory.name = ex.Customer_Name;
    if (ex.Customer_Phone) memory.phone = ex.Customer_Phone;
    if (ex.Customer_Email) memory.email = ex.Customer_Email;
    if (ex.Event_Name)     memory.service = ex.Event_Name;
    if (ex.Start_Time)     memory.startISO = ex.Start_Time;
    if (ex.End_Time)       memory.endISO = ex.End_Time;
    logSlots("merge");
  }

  function isAffirmative(txt) {
    return /\b(yes|yeah|yep|sure|please|go ahead|book it|confirm)\b/i.test(txt || "");
  }
  function isNegative(txt) {
    return /\b(no|nah|nope|stop|wait|hold on|cancel)\b/i.test(txt || "");
  }

  async function onUserUtterance(txt) {
    const ex = await extractBookingData(txt, memory, callSid);
    ex.utterance = txt;
    log("[extracted]", ex);
    mergeExtract(ex);

    // quick intent: DELETE by id
    if (ex.intent === "DELETE") {
      if (!ex.id) return say("What’s the appointment ID to cancel?");
      const r = await callMake(MAKE_DELETE, { id: ex.id }, "DELETE");
      if (r.ok) await say("Your appointment is cancelled. Thanks for calling Old Line Barbershop. Goodbye.");
      else      await say("I couldn’t cancel that one. Want me to try again?");
      return;
    }

    // READ intent → answer count quickly
    if (ex.intent === "READ") {
      const win = ex.window?.start ? ex.window :
        (memory.startISO ? { start: memory.startISO, end: memory.endISO || memory.startISO }
                          : { start: new Date().toISOString(), end: new Date(Date.now()+24*3600e3).toISOString() });
      const r = await callMake(MAKE_READ, { intent: "READ", window: win }, "READ");
      const events = Array.isArray(r?.data?.events) ? r.data.events : [];
      if (!events.length) await say("No appointments in that window.");
      else                await say(`I found ${events.length} appointment${events.length>1?"s":""} in that window.`);
      return;
    }

    // CREATE / UNKNOWN go through phases
    if (phase === "collect_time") {
      // if both now present, jump to availability
      if (memory.service && memory.startISO) {
        phase = "check_availability";
        return handlePhase();
      }
      return nextQuestion();
    }

    if (phase === "check_availability") {
      // if user changed time/service, re-check; else keep asking
      if (memory.service && memory.startISO) return handlePhase();
      return nextQuestion();
    }

    if (phase === "collect_contact") {
      if (memory.name && memory.phone) {
        phase = "confirm_booking";
        return handlePhase().then(nextQuestion);
      }
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
        const r = await callMake(MAKE_CREATE, createReq, "CREATE");
        if (r.ok) await say(`All set — your ${memory.service} is booked for ${when}. Thanks for calling Old Line Barbershop. Goodbye.`);
        else      await say("Sorry — I couldn’t complete the booking. Want me to try a different time?");
        return;
      }
      if (isNegative(txt)) {
        return say("Okay, I won’t book it. Want a different time or service?");
      }
      // not a clear yes/no → repeat confirm line once
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

      // Deepgram
      const dg = startDeepgram({
        onOpen: () => log("[ASR] ready"),
        onPartial: () => {},
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

  ws.on("close", () => { try { ws._dg?.close(); } catch {}; log("WS closed"); });
  ws.on("error", (e) => err("WS error", e?.message || e));
});

const appServer = server.listen(PORT, () => log(`Server running on ${PORT}`));
