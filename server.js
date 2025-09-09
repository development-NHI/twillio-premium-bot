// server.js — Phone AI Agent with Make integration (Read/Create/Delete)
// Twilio <-> Deepgram <-> OpenAI <-> ElevenLabs + Make webhooks

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;

/* ========= ENV: set these ========== */
const MAKE_CREATE = process.env.MAKE_CREATE || "https://hook.us2.make.com/XXXX-create";
const MAKE_READ   = process.env.MAKE_READ   || "https://hook.us2.make.com/XXXX-read";
const MAKE_DELETE = process.env.MAKE_DELETE || "https://hook.us2.make.com/XXXX-delete";

/* ========= Utilities ========= */
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

/* ========= Deepgram ========= */
function startDeepgram({ onFinal }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return null;

  const url = "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&model=nova-2-phonecall&interim_results=true&smart_format=true&language=en-US&endpointing=250";
  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${key}` },
    perMessageDeflate: false,
  });

  dg.on("open", () => console.log("[Deepgram] ws open"));
  dg.on("message", (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const txt = (alt.transcript || "").trim();
    if (txt && ev.is_final) onFinal(txt);
  });
  dg.on("close", () => console.log("[Deepgram] closed"));

  return {
    sendPCM16LE(buf) { dg.send(buf); },
    close() { try { dg.close(); } catch {} }
  };
}

/* ========= OpenAI: intent extraction ========= */
async function extractBookingData(userText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { intent: "UNKNOWN" };

  const body = {
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
Extract appointment intent as JSON. Use defaults if missing.

Fields:
- intent: CREATE, READ, DELETE
- Event_Name: string (default "Haircut")
- Start_Time: ISO8601
- End_Time: ISO8601 (Start+30m if missing)
- Customer_Name: string (default "unknown")
- Customer_Phone: string (default "unknown")
- Customer_Email: string (default "unknown")
- id: string (only for DELETE)
- Notes: string

Output ONLY JSON.
`
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
  catch { return { intent: "UNKNOWN" }; }
}

/* ========= Call Make ========= */
async function callMake(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error("[Make] error", res.status, await res.text());
      return null;
    }
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error("[Make] network error", e.message);
    return null;
  }
}

/* ========= ElevenLabs ========= */
async function speakEleven(ws, streamSid, text) {
  if (!streamSid) return;
  const key = process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) return;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  });
  if (!res.ok || !res.body) return;

  res.body.on("data", (chunk) => {
    const base64 = Buffer.from(chunk).toString("base64");
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64 } }));
  });
}

/* ========= HTTP + WS ========= */
const app = express();
app.get("/", (_, r) => r.send("OK"));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/twilio")) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

/* ========= Main WS logic ========= */
wss.on("connection", (ws) => {
  let streamSid = null;
  let dg = null;
  let pendingULaw = [];

  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid;
      console.log("WS CONNECTED |", streamSid);
      dg = startDeepgram({ onFinal: (t) => handleUserText(t) });
      await speakEleven(ws, streamSid, "Hi there, how can I help?");
    }

    else if (evt.event === "media") {
      const ulaw = Buffer.from(evt.media.payload, "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= 5 && dg) {
        const ulawChunk = Buffer.concat(pendingULaw);
        const pcm16 = ulawBufferToPCM16LEBuffer(ulawChunk);
        dg.sendPCM16LE(pcm16);
        pendingULaw = [];
      }
    }

    else if (evt.event === "stop") {
      if (dg) dg.close();
      console.log("Twilio stream STOP");
    }
  });

  async function handleUserText(text) {
    console.log("[user]", text);
    const booking = await extractBookingData(text);
    console.log("[extracted]", booking);

    if (booking.intent === "READ") {
      const events = await callMake(MAKE_READ, booking);
      await speakEleven(ws, streamSid,
        events && events.length
          ? `I found ${events.length} appointments.`
          : "I didn't find any appointments."
      );
    }

    else if (booking.intent === "CREATE") {
      // First check availability
      const conflicts = await callMake(MAKE_READ, {
        intent: "READ",
        window: { start: booking.Start_Time, end: booking.End_Time }
      });

      if (conflicts && conflicts.length > 0) {
        await speakEleven(ws, streamSid, "Sorry, that time is already booked. Please choose another.");
      } else {
        const created = await callMake(MAKE_CREATE, booking);
        await speakEleven(ws, streamSid, created ? "Your appointment has been booked." : "I couldn't book your appointment.");
      }
    }

    else if (booking.intent === "DELETE") {
      const deleted = await callMake(MAKE_DELETE, booking);
      await speakEleven(ws, streamSid, deleted ? "Your appointment has been canceled." : "I couldn't cancel that appointment.");
    }

    else {
      await speakEleven(ws, streamSid, "I didn’t understand. Do you want to book, cancel, or check appointments?");
    }
  }
});

server.listen(PORT, () => console.log("Server running on", PORT));
