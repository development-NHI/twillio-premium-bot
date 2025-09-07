// server.js
const express = require("express");
const { WebSocketServer } = require("ws");
const url = require("url");
const fetch = (...args) =>
  import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 8080;
const STREAM_TOKEN = process.env.STREAM_TOKEN || "";
const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK || "";

// --- μ-law + audio helpers ---
const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160; // 20ms * 8000Hz

function pcm16ToMuLaw(int16) {
  const out = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) {
    let s = int16[i];
    let sign = (s >> 8) & 0x80;
    if (sign) s = -s;
    if (s > 0x1FFF) s = 0x1FFF;
    s += 0x84;
    let exponent = 7;
    for (
      let expMask = 0x4000;
      (s & expMask) === 0 && exponent > 0;
      exponent--, expMask >>= 1
    );
    let mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = (~(sign | (exponent << 4) | mantissa)) & 0xff;
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

// ----- Basic web server -----
const app = express();
app.get("/", (_, res) => res.send("OK"));
const server = app.listen(PORT, () =>
  console.log(`Server running on 0.0.0.0:${PORT}`)
);

// ----- Twilio WebSocket endpoint -----
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (ws, req) => {
  const q = url.parse(req.url, true).query;
  if (STREAM_TOKEN && q.token !== STREAM_TOKEN) {
    console.log("Bad token; closing");
    ws.close();
    return;
  }
  const bizId = q.biz || "default";
  console.log("Twilio stream CONNECTED for business:", bizId);

  const call = makeCallState(ws);

  ws.on("message", (buf) => {
    try {
      const evt = JSON.parse(buf);

      if (evt.event === "start") {
        call.id = evt.start.callSid;
        console.log("CallSid:", call.id);
        // Send a quick beep to prove outbound audio
        call.speak("hello");
      } else if (evt.event === "media") {
        // Caller audio (20ms μ-law 8kHz base64)
        const frame = evt.media.payload;
        call.onIncomingAudio(frame);
      } else if (evt.event === "stop") {
        console.log("Twilio stream STOP");
      }
    } catch (e) {
      console.error("Bad WS message", e);
    }
  });

  ws.on("close", () => console.log("WebSocket closed"));
  ws.on("error", (e) => console.error("WebSocket error", e));
});

// ----- Per-call state -----
function makeCallState(ws) {
  let callId = null;
  let mode = "listening";

  function sendAudioFrame(base64Ulaw) {
    ws.send(JSON.stringify({ event: "media", media: { payload: base64Ulaw } }));
  }

  async function speak(replyText) {
    mode = "responding";
    // Just beep 440Hz for 500ms (later replace w/ ElevenLabs)
    const pcm = makeSinePCM16(440, 500, 0.2);
    const frames = chunkPCM16To20ms(pcm);

    for (const frame of frames) {
      const ulaw = pcm16ToMuLaw(frame);
      const base64 = Buffer.from(ulaw).toString("base64");
      sendAudioFrame(base64);
      await new Promise((r) => setTimeout(r, 20));
    }
    mode = "listening";
  }

  async function onIncomingAudio(base64UlawFrame) {
    if (mode === "responding") {
      mode = "listening";
    }
    // Placeholder: if we detect "book" manually later, trigger Make
    // For now, just log frames.
  }

  async function decideWhatToSay(words) {
    const needsBooking = /book|appointment|schedule/i.test(words || "");
    if (needsBooking && MAKE_WEBHOOK) {
      try {
        await fetch(MAKE_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId, type: "BOOK", words }),
        });
      } catch (e) {
        console.error("Make webhook failed", e);
      }
      return "Sure, I can help with that. What day and time works best?";
    }
    return "Got it. Anything else I can help you with?";
  }

  return {
    get id() {
      return callId;
    },
    set id(v) {
      callId = v;
    },
    onIncomingAudio,
    speak,
  };
}
