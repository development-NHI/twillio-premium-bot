// server.js
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const url = require("url");

const PORT = process.env.PORT || 10000;
const STREAM_TOKEN = process.env.STREAM_TOKEN || "";
const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK || "";

// --- μ-law + audio helpers ---
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

// ---- HTTP app + server
const app = express();
app.get("/", (_, res) => res.type("text/plain").send("OK"));

const server = http.createServer(app);

// ---- WebSocket server (noServer mode) + manual upgrade
const wss = new WebSocketServer({
  noServer: true,
  // Twilio doesn’t need compression; some proxies misbehave with it
  perMessageDeflate: false
});

server.on("upgrade", (req, socket, head) => {
  try {
    const { pathname, search } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname !== "/twilio") {
      // Not our WS endpoint
      socket.destroy();
      return;
    }

    // Validate token before upgrading (reject with 401)
    const q = url.parse(pathname + search, true).query;
    const tokenValid = !STREAM_TOKEN || q.token === STREAM_TOKEN;
    if (!tokenValid) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\n" +
        "Connection: close\r\n" +
        "\r\n"
      );
      socket.destroy();
      return;
    }

    // Proceed with WS handshake
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch (e) {
    // If anything goes wrong, close cleanly so Twilio gets a non-101
    try { socket.destroy(); } catch {}
  }
});

// ---- WS connection handler
wss.on("connection", (ws, req) => {
  const q = url.parse(req.url, true).query;
  const bizId = q.biz || "default";
  console.log("Twilio WS CONNECTED. biz:", bizId);

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
        // Prove outbound audio path: quick beep
        call.speak("beep");
        break;

      case "media": {
        // Caller audio (20ms μ-law 8kHz base64)
        // We’re not transcribing yet—just acknowledge.
        // const frame = evt.media?.payload;
        break;
      }

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

// ---- Per-call state
function makeCallState(ws) {
  let callId = null;
  let mode = "listening";

  function sendAudioFrame(base64Ulaw) {
    ws.send(JSON.stringify({ event: "media", media: { payload: base64Ulaw } }));
  }

  async function speak(_replyText) {
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

  async function onIncomingAudio(_base64Ulaw) {
    if (mode === "responding") mode = "listening";
    // (ASR will go here later)
  }

  return {
    get id() { return callId; },
    set id(v) { callId = v; },
    onIncomingAudio,
    speak
  };
}

server.listen(PORT, () => {
  console.log(`Server running on 0.0.0.0:${PORT}`);
});
