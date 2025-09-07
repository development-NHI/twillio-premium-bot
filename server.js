// server.js — Twilio Connect/Stream + ElevenLabs TTS (with beep fallback)
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// ====== config ======
const PORT = process.env.PORT || 10000;

// ====== audio helpers (μ-law @ 8kHz, 20ms frames) ======
const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160; // 20ms * 8000

function pcm16ToMuLaw(int16) {
  const out = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) {
    let s = int16[i];
    let sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    if (s > 0x1FFF) s = 0x1FFF;
    s += 0x84;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
    let mantissa = (s >> (exponent + 3)) & 0x0F;
    out[i] = (~(sign | (exponent << 4) | mantissa)) & 0xFF;
  }
  return out;
}
function makeSinePCM16(freqHz, ms, amp = 0.25) {
  const total = Math.floor(SAMPLE_RATE * (ms / 1000));
  const data = new Int16Array(total);
  const vol = Math.floor(32767 * amp);
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    data[i] = Math.floor(Math.sin(2 * Math.PI * freqHz * t) * vol);
  }
  return data;
}
function chunkPCM16To20ms(pcm) {
  const frames = [];
  for (let i = 0; i + FRAME_SAMPLES <= pcm.length; i += FRAME_SAMPLES) {
    frames.push(pcm.subarray(i, i + FRAME_SAMPLES));
  }
  return frames;
}
async function playBeep(ws, streamSid, freq = 440, ms = 400) {
  if (!streamSid) return;
  const pcm = makeSinePCM16(freq, ms, 0.25);
  const frames = chunkPCM16To20ms(pcm);
  for (const f of frames) {
    const ulaw = pcm16ToMuLaw(f);
    const base64 = Buffer.from(ulaw).toString("base64");
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: base64 }
    }));
    await new Promise(r => setTimeout(r, 20));
  }
}

// ====== HTTP app ======
const app = express();
app.get("/", (_, res) => res.type("text/plain").send("OK"));
// Helpful browser check for routing:
app.get("/twilio", (_, res) =>
  res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio")
);
app.get("/twilio/", (_, res) =>
  res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio/")
);

const server = http.createServer(app);

// ====== WebSocket (manual upgrade) ======
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname !== "/twilio" && u.pathname !== "/twilio/") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch {
    try { socket.destroy(); } catch {}
  }
});

// ====== ElevenLabs TTS (μ-law 8k streaming) ======
async function speakEleven(ws, streamSid, text) {
  if (!streamSid) return;
  const key = process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) {
    console.log("(!) ELEVEN_API_KEY or ELEVEN_VOICE_ID missing — using beep fallback.");
    await playBeep(ws, streamSid, 660, 250);
    return;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });

  if (!res.ok || !res.body) {
    console.error("[TTS] ElevenLabs HTTP", res.status);
    await playBeep(ws, streamSid, 440, 250);
    return;
  }

  return new Promise((resolve, reject) => {
    res.body.on("data", (chunk) => {
      // Already μ-law 8k; just base64 + send
      const base64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64 }
      }));
    });
    res.body.on("end", resolve);
    res.body.on("error", reject);
  });
}

// ====== WS handler ======
wss.on("connection", (ws) => {
  let streamSid = null;

  ws.on("message", async (buf) => {
    let evt;
    try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      const biz = evt.start?.customParameters?.biz || "default";
      console.log("WS CONNECTED | streamSid:", streamSid, "| biz:", biz);

      // Speak a simple greeting (replace text later with LLM-driven content)
      await speakEleven(ws, streamSid, "Hello! Thanks for calling. How can I help you today?");
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "greeting-done" } }));
    }
    else if (evt.event === "media") {
      // Incoming caller audio (20ms μ-law base64). Not used yet.
    }
    else if (evt.event === "stop") {
      console.log("Twilio stream STOP");
    }
  });

  ws.on("close", () => console.log("WS closed"));
  ws.on("error", (e) => console.error("WS error", e));
});

server.listen(PORT, () => console.log(`Server running on 0.0.0.0:${PORT}`));
