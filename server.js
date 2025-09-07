// server.js (WS upgrade + beep back with required streamSid)
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const url = require("url");

const PORT = process.env.PORT || 10000;

// ---------- audio helpers ----------
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
function makeSinePCM16(freqHz, ms, amp = 0.2) {
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
app.get("/twilio", (_, res) =>
  res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio")
);
app.get("/twilio/", (_, res) =>
  res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio/")
);

const server = http.createServer(app);

// ---------- WebSocket server (manual upgrade) ----------
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    console.log("[UPGRADE] path:", u.pathname, "search:", u.search);
    if (u.pathname !== "/twilio" && u.pathname !== "/twilio/") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
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

  ws.on("message", async (buf) => {
    let evt;
    try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      call.id = evt.start?.callSid || null;
      call.streamSid = evt.start?.streamSid || null;   // <-- capture streamSid
      console.log("CallSid:", call.id, "| streamSid:", call.streamSid);

      // Send a quick beep so you hear outbound audio
      await call.beep(440, 500);
      // (optional) tell Twilio we finished a chunk
      call.mark("hello-done");
    }
    else if (evt.event === "media") {
      // incoming caller audio (20ms μ-law base64) — we’re not using it yet
    }
    else if (evt.event === "stop") {
      console.log("Twilio stream STOP");
    }
  });

  ws.on("close", () => console.log("WS closed"));
  ws.on("error", (e) => console.error("WS error", e));
});

// ---------- per-call state ----------
function makeCallState(ws) {
  let callId = null;
  let streamSid = null;

  function sendAudioFrame(base64Ulaw) {
    if (!streamSid) {
      console.warn("(!) Tried to send audio without streamSid yet");
      return;
    }
    ws.send(JSON.stringify({
      event: "media",
      streamSid,                 // <-- REQUIRED for Twilio to accept audio
      media: { payload: base64Ulaw }
    }));
  }

  function mark(name) {
    if (!streamSid) return;
    ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name } }));
  }

  async function beep(freq = 440, ms = 300) {
    const pcm = makeSinePCM16(freq, ms, 0.25);
    const frames = chunkPCM16To20ms(pcm);
    for (const f of frames) {
      const ulaw = pcm16ToMuLaw(f);
      const base64 = Buffer.from(ulaw).toString("base64");
      sendAudioFrame(base64);
      await new Promise(r => setTimeout(r, 20));
    }
  }

  return {
    get id() { return callId; },
    set id(v) { callId = v; },
    get streamSid() { return streamSid; },
    set streamSid(v) { streamSid = v; },
    beep,
    mark
  };
}

server.listen(PORT, () => console.log(`Server running on 0.0.0.0:${PORT}`));
