// server.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "pNInz6obpgDQGcFmaJgB";

// ---------- Logging ----------
function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

// ---------- Express ----------
const app = express();
app.use(express.json());

// TwiML route (MUST reply text/xml for Twilio)
app.all("/twiml", (req, res) => {
  log("INFO", "TwiML requested");
  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME || "twillio-premium-bot.onrender.com"}"/>
      </Connect>
    </Response>
  `.trim());
});

// Health check
app.get("/", (_, res) => res.send("✅ Old Line Barbershop AI receptionist running"));

// ---------- HTTP server + WS ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Deepgram ----------
function startDeepgram({ onFinal }) {
  const url =
    "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&model=nova-2-phonecall&interim_results=false";
  const dg = new WebSocketServer({ noServer: true });
}

// μ-law decode
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

// ---------- OpenAI ----------
async function classifyUtterance(utterance) {
  const sys = `
Classify the caller utterance into JSON:
{ "intent": "FAQ"|"BOOK"|"CANCEL"|"RESCHEDULE"|"SMALLTALK"|"UNKNOWN",
  "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"|"",
  "service": "",
  "date": "",
  "time": "",
  "name": "",
  "phone": ""
}
Rules:
- If asking about hours, prices, services, or location => FAQ.
- If wants appointment => BOOK.
- Always keep it short JSON.
`;
  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: utterance }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  };
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  return JSON.parse(data.choices[0].message.content);
}

// ---------- ElevenLabs TTS ----------
async function speak(ws, streamSid, text) {
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    log("WARN", "No ElevenLabs credentials, skipping TTS");
    return;
  }
  log("BOT_SAY", text);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });

  if (!resp.ok) {
    log("ERROR", "TTS failed", { status: resp.status });
    return;
  }

  for await (const chunk of resp.body) {
    const b64 = Buffer.from(chunk).toString("base64");
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  }

  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }));
}

// ---------- Conversation State ----------
const conversations = new Map();

// ---------- WebSocket handling ----------
wss.on("connection", (ws) => {
  const convoId = uuidv4();
  conversations.set(convoId, { id: convoId });
  log("CALL_START", "", { convoId });

  let streamSid = null;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      log("INFO", "Stream started", { streamSid });
      await speak(ws, streamSid, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
    }

    if (msg.event === "media") {
      // decode ulaw and forward to Deepgram if needed
    }

    if (msg.event === "stop") {
      log("INFO", "Twilio stream STOP");
      ws.close();
    }

    if (msg.event === "asr_final") {
      const transcript = msg.text;
      log("ASR_FINAL", transcript);

      const parsed = await classifyUtterance(transcript);
      log("GPT_CLASSIFY", "", { transcript, parsed });

      if (parsed.intent === "FAQ" && parsed.faq_topic === "PRICES") {
        await speak(ws, streamSid, "Haircut $30, beard trim $15, combo $40.");
      } else if (parsed.intent === "FAQ" && parsed.faq_topic === "HOURS") {
        await speak(ws, streamSid, "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.");
      } else if (parsed.intent === "BOOK") {
        await speak(ws, streamSid, "Got it, let’s get you booked. What service would you like?");
      } else {
        await speak(ws, streamSid, "I’m not sure about that, let me transfer you to the owner.");
      }
    }
  });

  ws.on("close", () => {
    conversations.delete(convoId);
    log("INFO", "WS closed", { convoId });
  });
});

// ---------- Start ----------
server.listen(PORT, () => {
  log("INFO", `🚀 Server running on ${PORT}`);
});
