// server.js — Old Line Barbershop AI Receptionist
// - Twilio Media Stream + /twiml route
// - Deepgram ASR
// - GPT for classification & NLG
// - ElevenLabs TTS
// - Make.com integration
// ✅ Cleaned to avoid 11200 & package issues

import express from "express";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

// ------------------ CONFIG ------------------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVEN_VOICE_ID || "pNInz6obpgDQGcFmaJgB"; // default voice
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL;
const MAKE_FAQ_URL = process.env.MAKE_FAQ_URL;

// ------------------ LOGGING ------------------
function log(level, msg, meta = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...meta,
    })
  );
}

// ------------------ EXPRESS ROUTES ------------------

// Health check
app.get("/", (_, res) => res.send("✅ Old Line Barbershop AI is running"));

// TwiML route for Twilio Voice Webhook
app.post("/twiml", (req, res) => {
  log("INFO", "TwiML requested");
  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/"/>
      </Connect>
    </Response>
  `);
});

// ------------------ WEBSOCKET ------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function ulawByteToPcm16(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << (exponent + 2)) - 0x84 * 4;
  if (sign) sample = -sample;
  return Math.max(-32768, Math.min(32767, sample));
}
function ulawBufferToPCM16LEBuffer(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i * 2);
  }
  return out;
}

// ------------------ GPT HELPERS ------------------
async function gptClassify(utterance, convo) {
  const sys = `
You are the receptionist for Old Line Barbershop.
Classify caller intent and extract details.
Return strict JSON.

Schema:
{
  "intent": "FAQ" | "BOOK" | "CANCEL" | "RESCHEDULE" | "SMALLTALK" | "UNKNOWN",
  "faq_topic": "HOURS" | "PRICES" | "SERVICES" | "LOCATION" | "",
  "service": "",
  "date": "",
  "time": "",
  "name": "",
  "phone": ""
}

Rules:
- FAQ if caller asks about hours, pricing, services, location.
- BOOK if caller wants to schedule.
- Extract service/date/time/name/phone if present.
- If rude/unexpected → SMALLTALK.
`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: utterance },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  const json = await resp.json();
  const parsed = JSON.parse(json.choices[0].message.content || "{}");
  log("GPT_CLASSIFY", "", { transcript: utterance, parsed });
  return parsed;
}

// ------------------ TTS ------------------
async function speak(ws, streamSid, text) {
  if (!text) return;
  if (!ELEVENLABS_API_KEY) {
    log("WARN", "No ElevenLabs credentials, skipping TTS");
    return;
  }

  log("BOT_SAY", text);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });

  if (!resp.ok) {
    log("ERROR", "TTS failed", { status: resp.status });
    return;
  }

  const reader = resp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const b64 = Buffer.from(value).toString("base64");
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  }

  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }));
}

// ------------------ CONNECTION HANDLER ------------------
wss.on("connection", (ws, req) => {
  const convoId = uuidv4();
  let streamSid = null;

  log("CALL_START", "", { convoId });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      log("INFO", "Stream started", { streamSid });
      await speak(ws, streamSid, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
    }

    if (msg.event === "media") {
      // audio → Deepgram
    }

    if (msg.event === "asr_final") {
      const transcript = msg.text;
      log("ASR_FINAL", transcript);
      const parsed = await gptClassify(transcript, {});
      // reply logic
      if (parsed.intent === "FAQ") {
        if (parsed.faq_topic === "PRICES") {
          await speak(ws, streamSid, "Haircut $30, beard trim $15, combo $40.");
        } else if (parsed.faq_topic === "HOURS") {
          await speak(ws, streamSid, "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.");
        } else if (parsed.faq_topic === "SERVICES") {
          await speak(ws, streamSid, "We offer haircuts, beard trims, and a combo package.");
        } else if (parsed.faq_topic === "LOCATION") {
          await speak(ws, streamSid, "We’re located at 123 Blueberry Lane.");
        }
      } else if (parsed.intent === "BOOK") {
        await speak(ws, streamSid, "Got it, let’s get you booked. What service would you like?");
      } else if (parsed.intent === "SMALLTALK") {
        await speak(ws, streamSid, "I hear you! How can I assist further?");
      } else {
        await speak(ws, streamSid, "Sorry, could you repeat that?");
      }
    }

    if (msg.event === "stop") {
      log("INFO", "Call ended");
      ws.close();
    }
  });
});

// ------------------ START ------------------
server.listen(PORT, () => {
  log("INFO", `🚀 Server running on ${PORT}`);
});
