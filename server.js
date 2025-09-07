// server.js — Twilio Connect/Stream beep proof
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 10000;

// ---------- audio helpers ----------
const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160; // 20ms @ 8kHz

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

// ---------- HTTP app ----------
const app = express();
app.get("/", (_, res) => res.type("text/plain").send("OK"));
// helps verify routing in a browser
app.get("/twilio", (_, res) =>
  res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio")
);
app.get("/twilio/", (_, res) =>
  res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio/")
);

const server = http.createServer(app);

// ---------- WebSocket (manual upgrade) ----------
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

wss.on("connection", (ws) => {
  let streamSid = null;

  // send one 500ms beep to the caller
  async function beep() {
    if (!streamSid) return;
    const pcm = makeSinePCM16(440, 500, 0.25);
    const frames = chunkPCM16To20ms(pcm);
    for (const f of frames) {
      const ulaw = pcm16ToMuLaw(f);
      const base64 = Buffer.from(ulaw).toString("base64");
      ws.send(JSON.stringify({
        event: "media",
        streamSid,               // REQUIRED for Twilio to play it
        media: { payload: base64 }
      }));
      await new Promise(r => setTimeout(r, 20));
    }
  }

  ws.on("message", async (buf) => {
    let evt;
    try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      const biz = evt.start?.customParameters?.biz || "default";
      console.log("WS CONNECTED | streamSid:", streamSid, "| biz:", biz);

      // play the proof-of-life beep
      await beep();
      // optional: mark
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "beep-done" } }));
    }
    else if (evt.event === "media") {
      // incoming audio frames from caller (unused for beep test)
    }
    else if (evt.event === "stop") {
      console.log("Twilio stream STOP");
    }
  });

  ws.on("close", () => console.log("WS closed"));
  ws.on("error", (e) => console.error("WS error", e));
});

server.listen(PORT, () => console.log(`Server running on 0.0.0.0:${PORT}`));
