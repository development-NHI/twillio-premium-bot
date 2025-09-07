const express = require("express");
const { WebSocketServer } = require("ws");
const url = require("url");
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const PORT = process.env.PORT || 8080;

// Protect the stream so only Twilio can connect (put this in the TwiML URL as ?token=VALUE)
const STREAM_TOKEN = process.env.STREAM_TOKEN || "";

// Optional: where to send background jobs (Make webhook URL)
const MAKE_WEBHOOK  = process.env.MAKE_WEBHOOK  || "";

// ----- Basic web server (health check) -----
const app = express();
app.get("/", (_, res) => res.send("OK"));
const server = app.listen(PORT, () =>
  console.log(`Server running on 0.0.0.0:${PORT}`)
);

// ----- WebSocket endpoint Twilio will stream to -----
const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", (ws, req) => {
  // simple key check
  const q = url.parse(req.url, true).query;
  if (STREAM_TOKEN && q.token !== STREAM_TOKEN) {
    console.log("Bad token; closing");
    ws.close();
    return;
  }

  console.log("Twilio stream CONNECTED");
  const call = makeCallState(ws);

  ws.on("message", (buf) => {
    try {
      const evt = JSON.parse(buf);

      if (evt.event === "start") {
        call.id = evt.start.callSid;
        console.log("CallSid:", call.id);
      }

      else if (evt.event === "media") {
        // This is one 20ms slice of the caller’s audio, base64 μ-law 8kHz
        const frame = evt.media.payload;
        call.onIncomingAudio(frame);
      }

      else if (evt.event === "stop") {
        console.log("Twilio stream STOP");
      }
    } catch (e) {
      console.error("Bad WS message", e);
    }
  });

  ws.on("close", () => console.log("WebSocket closed"));
  ws.on("error", (e) => console.error("WebSocket error", e));
});

// Per-call helpers
function makeCallState(ws) {
  let callId = null;
  let mode = "listening"; // "listening" (caller speaking) or "responding" (we're speaking)

  // Send one audio frame back to Twilio (20ms μ-law, base64)
  function sendAudioFrame(base64Ulaw) {
    ws.send(JSON.stringify({ event: "media", media: { payload: base64Ulaw } }));
  }

  // Voice maker: turn reply text into audio frames and stream them back (to be implemented)
  async function speak(replyText) {
    mode = "responding";
    // TODO: call your streaming TTS here, convert to μ-law 8kHz frames, and for each frame call:
    // sendAudioFrame(base64UlawFrame);
    mode = "listening";
  }

  // Audio listener: handle each incoming audio frame
  async function onIncomingAudio(base64UlawFrame) {
    // If we’re talking and the caller starts, stop (barge-in)
    if (mode === "responding") {
      // TODO: stop any ongoing TTS stream
      mode = "listening";
    }

    // TODO: feed this frame into your streaming speech-to-text
    // When you detect the end of a sentence/phrase:
    //   const words = "<recognized text here>";
    //   const reply = await decideWhatToSay(words);
    //   await speak(reply);
  }

  // Text decider: simple intent + reply (replace with your model)
  async function decideWhatToSay(words) {
    const needsBooking = /book|appointment|schedule/i.test(words || "");
    if (needsBooking && MAKE_WEBHOOK) {
      // kick off background work without holding up the call
      try {
        await fetch(MAKE_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId, type: "BOOK", words })
        });
      } catch (e) { console.error("Make webhook failed", e); }
      return "Sure, I can help with that. What day and time works best?";
    }
    return "Got it. Anything else I can help you with?";
  }

  return {
    get id() { return callId; },
    set id(v) { callId = v; },
    onIncomingAudio,
    speak
  };
}
