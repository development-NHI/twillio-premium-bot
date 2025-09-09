// server.js — phone agent with slot-filling for name/phone, date sanity, Make integration
// Integrated with your Make webhooks: CREATE, READ, DELETE

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;

// 🔗 Your actual Make webhook URLs
const MAKE_CREATE = "https://hook.us2.make.com/7hd4nxdrgytwukxw57cwyykhotv6hxrm";
const MAKE_READ   = "https://hook.us2.make.com/6hmur673mpqw4xgy2bhzx4be4o32ziax";
const MAKE_DELETE = "https://hook.us2.make.com/noy0e27knj7e1jlomtznw34z246i3xtv";

const LOCAL_TZ    = process.env.LOCAL_TZ || "America/New_York";

/* ---------- time helpers ---------- */
function nowContext() {
  return { nowISO: new Date().toISOString(), tz: LOCAL_TZ };
}
function isPast(dateISO, fudgeMs = 2 * 60 * 1000) {
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < (Date.now() - fudgeMs);
}

/* ---------- u-law -> PCM16 ---------- */
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

/* ---------- Deepgram realtime ---------- */
function startDeepgram({ onOpen, onPartial, onFinal }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) { console.log("(!) No DEEPGRAM_API_KEY — ASR disabled."); return null; }

  const url = "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16&sample_rate=8000&channels=1"
    + "&model=nova-2-phonecall&interim_results=true&smart_format=true"
    + "&language=en-US&endpointing=250";

  const dg = new WebSocket(url, { headers: { Authorization: `token ${key}` }, perMessageDeflate: false });
  let isOpen = false;
  const queue = [];

  dg.on("open", () => { isOpen = true; onOpen?.(); while (queue.length) dg.send(queue.shift()); });
  dg.on("message", (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const txt = (alt.transcript || "").trim();
    if (!txt) return;
    if (ev.is_final === true || ev.speech_final === true) onFinal?.(txt);
    else onPartial?.(txt);
  });
  return {
    sendPCM16LE(buf) { if (isOpen && dg.readyState === WebSocket.OPEN) dg.send(buf); else queue.push(buf); },
    close() { try { dg.close(); } catch {} }
  };
}

/* ---------- OpenAI extractor ---------- */
async function extractBookingData(userText, memory) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { intent: "UNKNOWN" };
  const { nowISO, tz } = nowContext();
  const body = {
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
Return JSON ONLY describing appointment intent, with absolute timestamps in timezone ${tz}.
NOW: ${nowISO}

Fields:
- intent: CREATE | READ | DELETE | UNKNOWN
- Event_Name
- Start_Time / End_Time (ISO)
- Customer_Name
- Customer_Phone
- Customer_Email (optional)
- id (for DELETE)
- Notes
- window {start,end} for READ
`
      },
      { role: "user", content: `Memory:\n${JSON.stringify(memory || {}, null, 2)}` },
      { role: "user", content: userText }
    ]
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const json = await res.json();
  try { return JSON.parse(json.choices?.[0]?.message?.content || "{}"); }
  catch { return { intent: "UNKNOWN" }; }
}

/* ---------- ElevenLabs TTS ---------- */
async function speakEleven(ws, streamSid, text) {
  if (!streamSid) return;
  const key = process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) return;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!res.ok || !res.body) return;
  return new Promise((resolve) => {
    res.body.on("data", (chunk) => {
      const base64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64 } }));
    });
    res.body.on("end", resolve);
  });
}

/* ---------- Make helper ---------- */
async function callMake(url, payload) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text || null; }
  } catch (e) { console.error("[Make] error:", e?.message || e); return null; }
}

/* ---------- server + ws ---------- */
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname !== "/twilio") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  let streamSid, dg;
  const memory = { name: "", phone: "", email: "" };

  async function handleUserText(text) {
    const extracted = await extractBookingData(text, memory);
    console.log("[extracted]", extracted);

    if (extracted.intent === "CREATE") {
      if (!extracted.Customer_Name || !extracted.Customer_Phone) {
        await speakEleven(ws, streamSid, "Can I get your name and phone number before booking?");
        return;
      }
      const conflicts = await callMake(MAKE_READ, { intent: "READ", window: { start: extracted.Start_Time, end: extracted.End_Time } });
      if (conflicts?.events?.length) {
        await speakEleven(ws, streamSid, "That time is already booked. Want a different slot?");
        return;
      }
      await callMake(MAKE_CREATE, extracted);
      await speakEleven(ws, streamSid, `Booked your ${extracted.Event_Name} at ${extracted.Start_Time}.`);
    }

    else if (extracted.intent === "READ") {
      const resp = await callMake(MAKE_READ, extracted);
      if (resp?.events?.length) {
        await speakEleven(ws, streamSid, `Found ${resp.events.length} appointments.`);
      } else {
        await speakEleven(ws, streamSid, "No appointments in that time window.");
      }
    }

    else if (extracted.intent === "DELETE") {
      if (!extracted.id) {
        await speakEleven(ws, streamSid, "What’s the appointment ID to cancel?");
        return;
      }
      await callMake(MAKE_DELETE, extracted);
      await speakEleven(ws, streamSid, "Appointment cancelled.");
    }

    else {
      await speakEleven(ws, streamSid, "I can help book, read, or cancel appointments.");
    }
  }

  ws.on("message", (buf) => {
    const evt = JSON.parse(buf.toString());
    if (evt.event === "start") {
      streamSid = evt.start.streamSid;
      dg = startDeepgram({ onFinal: handleUserText });
      speakEleven(ws, streamSid, "Hi, how can I help?");
    } else if (evt.event === "media" && dg) {
      const ulaw = Buffer.from(evt.media.payload, "base64");
      const pcm = ulawBufferToPCM16LEBuffer(ulaw);
      dg.sendPCM16LE(pcm);
    } else if (evt.event === "stop" && dg) dg.close();
  });
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
