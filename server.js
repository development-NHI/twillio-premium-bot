// server.js

import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import WebSocket, { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// =============================
// Logger
// =============================
function log(level, msg, meta = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta
  }));
}

// =============================
// TwiML Endpoint
// =============================
app.get("/twiml", (req, res) => {
  log("INFO", "TwiML requested");
  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME || "localhost:"+PORT}"/>
      </Connect>
    </Response>
  `.trim());
});

// =============================
// WS Server
// =============================
const server = app.listen(PORT, () => {
  log("INFO", `🚀 Server running on ${PORT}`);
});
const wss = new WebSocketServer({ server });

let conversations = {};

// =============================
// ElevenLabs TTS
// =============================
async function speak(ws, streamSid, text) {
  if (!streamSid || !text) return;
  if (!process.env.ELEVEN_API_KEY || !process.env.ELEVEN_VOICE_ID) {
    log("WARN", "No ElevenLabs credentials, skipping TTS");
    return;
  }

  log("BOT_SAY", text);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVEN_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });

  if (!resp.ok || !resp.body) {
    log("ERROR", "TTS HTTP error", { status: resp.status });
    return;
  }

  // ✅ FIXED: Node 22 uses async iterator over resp.body
  for await (const chunk of resp.body) {
    const b64 = Buffer.from(chunk).toString("base64");
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: b64 }
    }));
  }

  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }));
}

// =============================
// OpenAI Classification
// =============================
async function classify(text) {
  const sysPrompt = `
Classify caller utterance into JSON:
{
  "intent": "FAQ" | "BOOK" | "CANCEL" | "RESCHEDULE" | "SMALLTALK" | "UNKNOWN",
  "faq_topic": "HOURS" | "PRICES" | "SERVICES" | "LOCATION" | "",
  "service": "",
  "date": "",
  "time": "",
  "name": "",
  "phone": ""
}
Keep it strict JSON only.
  `.trim();

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sysPrompt },
        { role: "user", content: text }
      ],
      temperature: 0.2,
      response_format: { type: "json_object" }
    })
  });

  if (!resp.ok) {
    log("ERROR", "OpenAI classify failed", { status: resp.status });
    return { intent: "UNKNOWN" };
  }

  const data = await resp.json();
  let parsed = {};
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch {
    parsed = { intent: "UNKNOWN" };
  }
  return parsed;
}

// =============================
// Handle WS Connection
// =============================
wss.on("connection", (ws, req) => {
  const convoId = uuidv4();
  conversations[convoId] = { step: "start" };
  log("CALL_START", "", { convoId });

  let streamSid = null;

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
      await speak(ws, streamSid, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
    }

    else if (data.event === "media") {
      // Here you’d normally send audio to Deepgram ASR
    }

    else if (data.event === "mark") {
      // ignore
    }

    else if (data.event === "stop") {
      log("INFO", "Twilio stream STOP");
      try { ws.close(); } catch {}
    }

    // Synthetic ASR messages from Deepgram
    else if (data.event === "asr") {
      const transcript = data.text;
      log("ASR_FINAL", "", { transcript });

      const parsed = await classify(transcript);
      log("GPT_CLASSIFY", "", { transcript, parsed });

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
        await speak(ws, streamSid, "I’m here to help! What would you like to know?");
      } else {
        await speak(ws, streamSid, "I didn’t quite catch that. Could you repeat?");
      }
    }
  });

  ws.on("close", () => {
    log("INFO", "WS closed", { convoId });
    delete conversations[convoId];
  });
});
