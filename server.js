// server.js — Twilio Connect/Stream + Deepgram + OpenAI brain + ElevenLabs TTS + Make integration

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;
const MAKE_CREATE = process.env.MAKE_CREATE || "";
const MAKE_READ   = process.env.MAKE_READ   || "";
const MAKE_DELETE = process.env.MAKE_DELETE || "";

/* ========== μ-law decode ========== */
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
  for (let i = 0; i < ulawBuf.length; i++) {
    const s = ulawByteToPcm16(ulawBuf[i]);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

/* ========== Deepgram realtime ========== */
function startDeepgramLinear16({ onOpen, onPartial, onFinal }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY || "";

  const url =
    "wss://api.deepgram.com/v1/listen" +
    "?encoding=linear16&sample_rate=8000&channels=1&model=nova-2-phonecall" +
    "&interim_results=true&smart_format=true&language=en-US&endpointing=250";

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${key}` },
    perMessageDeflate: false,
  });

  let open = false;
  const q = [];

  dg.on("open", () => {
    open = true;
    console.log("[Deepgram] ws open");
    onOpen?.();
    while (q.length) dg.send(q.shift());
  });

  dg.on("message", (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || "").trim();
    if (!text) return;
    const isFinal = ev.is_final === true || ev.speech_final === true;
    if (isFinal) onFinal?.(text);
    else onPartial?.(text);
  });

  return {
    sendPCM16LE(buf) { if (open) dg.send(buf); else q.push(buf); },
    close() { try { dg.close(); } catch {} },
  };
}

/* ========== OpenAI brain ========== */
async function brainReply({ systemPrompt, history, userText }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return `You said: "${userText}".`;

  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userText }
    ],
    temperature: 0.5,
    max_tokens: 120
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) return `You said: "${userText}".`;
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || `You said: "${userText}".`;
}

/* ========== Strict JSON extractor ========== */
async function extractBookingData(userText) {
  const apiKey = process.env.OPENAI_API_KEY;
  const body = {
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Always return valid JSON only. Keys allowed: intent (CREATE, READ, DELETE), Event_Name, Start_Time, End_Time, Customer_Name, Customer_Phone, Customer_Email, Notes, id."
      },
      { role: "user", content: userText }
    ]
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const json = await res.json();
  try { return JSON.parse(json.choices[0].message.content); }
  catch { return {}; }
}

/* ========== ElevenLabs TTS ========== */
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
    res.body.on("end", () => resolve());
  });
}

/* ========== Make call helper ========== */
async function callMake(url, payload) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error("[Make] call failed", e.message);
    return null;
  }
}

/* ========== Express server ========== */
const app = express();
app.get("/", (_, res) => res.type("text/plain").send("OK"));
app.get("/twilio", (_, res) => res.status(426).send("Upgrade Required"));
const server = http.createServer(app);

/* ========== WebSocket (Twilio) ========== */
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (!u.pathname.startsWith("/twilio")) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

/* ========== Twilio call handling ========== */
wss.on("connection", (ws) => {
  let streamSid = null;
  let dg = null;
  const history = [];

  const systemPrompt = process.env.AGENT_PROMPT || "You are a barbershop phone assistant.";

  async function handleUserText(text) {
    console.log("[user]", text);
    const bookingData = await extractBookingData(text);
    console.log("[extracted]", bookingData);

    if (bookingData.intent === "CREATE" && MAKE_CREATE) {
      const payload = { api_key: "APPLES2025!", ...bookingData };
      await callMake(MAKE_CREATE, payload);
      return speakEleven(ws, streamSid, `Your ${bookingData.Event_Name || "appointment"} has been booked.`);
    }

    if (bookingData.intent === "READ" && MAKE_READ) {
      const payload = { api_key: "APPLES2025!", ...bookingData };
      const resp = await callMake(MAKE_READ, payload);
      if (resp?.events?.length) {
        const list = resp.events.map(e => `${e.summary} at ${e.start}`).join(", ");
        return speakEleven(ws, streamSid, `Here are your appointments: ${list}`);
      } else {
        return speakEleven(ws, streamSid, "No appointments found in that timeframe.");
      }
    }

    if (bookingData.intent === "DELETE" && MAKE_DELETE) {
      const payload = { api_key: "APPLES2025!", ...bookingData };
      await callMake(MAKE_DELETE, payload);
      return speakEleven(ws, streamSid, "Your appointment has been cancelled.");
    }

    const reply = await brainReply({ systemPrompt, history, userText: text });
    history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    return speakEleven(ws, streamSid, reply);
  }

  ws.on("message", (buf) => {
    const evt = JSON.parse(buf.toString());
    if (evt.event === "start") {
      streamSid = evt.start?.streamSid;
      console.log("WS CONNECTED |", streamSid);
      dg = startDeepgramLinear16({
        onFinal: (t) => handleUserText(t)
      });
      speakEleven(ws, streamSid, "Hi there, this is Old Line Barbershop. How can I help?");
    }
    else if (evt.event === "media") {
      const ulaw = Buffer.from(evt.media?.payload || "", "base64");
      if (dg) dg.sendPCM16LE(ulawBufferToPCM16LEBuffer(ulaw));
    }
    else if (evt.event === "stop") {
      console.log("Twilio stream STOP");
      if (dg) dg.close();
    }
  });

  ws.on("close", () => { if (dg) dg.close(); });
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
