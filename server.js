// server.js (diagnostic + fix)
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const url = require("url");

const PORT = process.env.PORT || 10000;

// ---- μ-law + audio helpers (unchanged) ----
const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160;
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
function makeSinePCM16(freqHz, ms, amplitude = 0.2) {
  const total = Math.floor(SAMPLE_RATE * (ms / 1000));
  const data = new Int16Array(total);
  const vol = Math.floor(32767 * amplitude);
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

// ---- HTTP app + server ----
const app = express();
app.get("/", (_, res) => res.type("text/plain").send("OK"));
// If you browse to /twilio over HTTP, return 426 so we know routing hits this app.
app.get("/twilio", (_, res) => {
  res.status(426).type("text/plain").send("Upgrade Required: connect via WebSocket (wss) to /twilio");
});
app.get("/twilio/", (_, res) => {
  res.status(426).type("text/plain").send("Upgrade Required: connect via WebSocket (wss) to /twilio/");
});

const server = http.createServer(app);

// ---- WebSocket server (manual upgrade) ----
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  // Loud diagnostics so we see exactly what Twilio sent
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    console.log("[UPGRADE] path:", u.pathname, "search:", u.search);
    console.log("[UPGRADE] headers:",
      "Host:", req.headers.host,
      "| Sec-WebSocket-Version:", req.headers["sec-websocket-version"],
      "| Sec-WebSocket-Key:", req.headers["sec-websocket-key"] ? "(present)" : "(missing)"
    );

    // Accept both /twilio and /twilio/ (some proxies add trailing slash)
    if (u.pathname !== "/twilio" && u.pathname !== "/twilio/") {
      console.log("[UPGRADE] rejecting: wrong path");
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Proceed with WS handshake
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch (e) {
    console.error("[UPGRADE] exception:", e);
    try { socket.destroy(); } catch {}
  }
});

wss.on("connection", (ws, req) => {
  const q = url.parse(req.url, true).query;
  const bizId = q.biz || "default";
  console.log("✔ Twilio WS CONNECTED | biz:", bizId);

  const call = makeCallState(ws);

  ws.on("message", (buf) => {
    let evt;
    try { evt = JSON.parse(buf.toString()); } catch (e) {
      console.error("Bad WS JSON", e);
      return;
    }

    switch (evt.event) {
      case "start":
        call.id = evt.start?.callSid || null;
        console.log("CallSid:", call.id);
        // Prove outbound audio path: beep
        call.speak();
        break;

      case "media":
        // const frame = evt.media?.payload; // 20ms μ-law base64
        break;

      case "stop":
        console.log("Twilio stream STOP");
        break;

      default:
        // ignore
        break;
    }
  });

  ws.on("close", () => console.log("WS closed"));
  ws.on("error", (e) => console.error("WS error", e));
});

// ---- Per-call state ----
function makeCallState(ws) {
  let callId = null;
  let mode = "listening";

  function sendAudioFrame(base64Ulaw) {
    ws.send(JSON.stringify({ event: "media", media: { payload: base64Ulaw } }));
  }

  async function speak() {
    mode = "responding";
    const pcm = makeSinePCM16(440, 500, 0.2);
    const frames = chunkPCM16To20ms(pcm);
    for (const frame of frames) {
      const ulaw = pcm16ToMuLaw(frame);
      const base64 = Buffer.from(ulaw).toString("base64");
      sendAudioFrame(base64);
      await new Promise(r => setTimeout(r, 20));
    }
    mode = "listening";
  }

  return {
    get id() { return callId; },
    set id(v) { callId = v; },
    speak
  };
}

server.listen(PORT, () => {
  console.log(`Server running on 0.0.0.0:${PORT}`);
});
