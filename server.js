// server.js
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

// ---------- ENV VARS ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// ---------- LOG ----------
function log(level, msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
}

// ---------- ULaw → PCM16 ----------
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

// ---------- Deepgram Client ----------
function startDeepgram({ onFinal }) {
  const url =
    "wss://api.deepgram.com/v1/listen" +
    "?encoding=linear16&sample_rate=8000&channels=1&model=nova-2-phonecall&interim_results=true";

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
  });

  dg.on("open", () => log("INFO", "[Deepgram] ws open"));
  dg.on("message", (data) => {
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (ev.type === "Results") {
      const alt = ev.channel?.alternatives?.[0];
      const txt = (alt?.transcript || "").trim();
      if (txt && ev.is_final) {
        log("ASR_FINAL", txt);
        onFinal?.(txt);
      }
    }
  });
  dg.on("close", () => log("INFO", "[Deepgram] ws closed"));

  return {
    send(buf) {
      try {
        dg.send(buf);
      } catch (e) {
        log("ERROR", "[DG send]", { error: e.message });
      }
    },
    close() {
      try {
        dg.close();
      } catch {}
    },
  };
}

// ---------- GPT ----------
async function classifyAndReply(transcript) {
  const sysPrompt = `
You are a helpful AI receptionist for Old Line Barbershop.
Classify the intent and also generate a short human-sounding reply.
Return strict JSON:
{
 "intent": "FAQ"|"BOOK"|"SMALLTALK"|"UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"|"",
 "service": "",
 "date": "",
 "time": "",
 "name": "",
 "phone": "",
 "reply": "short natural response"
}`;

  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: transcript },
    ],
    temperature: 0.4,
    max_tokens: 120,
    response_format: { type: "json_object" },
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  let parsed = {};
  try {
    parsed = JSON.parse(json.choices[0].message.content);
  } catch {
    parsed = { intent: "UNKNOWN", reply: "Sorry, I didn’t catch that." };
  }
  log("GPT_CLASSIFY", transcript, { parsed });
  return parsed;
}

// ---------- TTS (ElevenLabs) ----------
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
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!resp.ok) {
    log("ERROR", "[TTS] ElevenLabs failed", { status: resp.status });
    return;
  }

  const reader = resp.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const b64 = Buffer.from(value).toString("base64");
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  }
  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }));
}

// ---------- TwiML ----------
app.get("/twiml", (req, res) => {
  log("INFO", "TwiML requested");
  res.type("text/xml");
  res.send(`
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media"/>
  </Connect>
</Response>`);
});

// ---------- WS (Twilio Media Stream) ----------
const wss = new WebSocketServer({ noServer: true });
const convos = {};

wss.on("connection", (ws) => {
  const convoId = uuidv4();
  convos[convoId] = {};
  let dg = null;
  let streamSid = null;

  log("CALL_START", "", { convoId });

  ws.on("message", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      log("INFO", "Stream started", { streamSid });
      // Greeting
      speak(ws, streamSid, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
      if (DEEPGRAM_API_KEY) {
        dg = startDeepgram({
          onFinal: async (text) => {
            const parsed = await classifyAndReply(text);
            await speak(ws, streamSid, parsed.reply);
          },
        });
      }
    }

    if (data.event === "media" && dg) {
      const ulaw = Buffer.from(data.media.payload, "base64");
      const pcm = ulawBufferToPCM16LEBuffer(ulaw);
      dg.send(pcm);
    }

    if (data.event === "stop") {
      log("INFO", "Twilio stream STOP");
      try {
        dg?.close();
      } catch {}
      try {
        ws.close();
      } catch {}
    }
  });

  ws.on("close", () => {
    log("INFO", "WS closed", { convoId });
  });
});

const server = app.listen(PORT, () => log("INFO", `🚀 Server running on ${PORT}`));
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});
