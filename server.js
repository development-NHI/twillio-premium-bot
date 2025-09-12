// server.js — Old Line Barbershop AI Receptionist
// Twilio Media Streams + Deepgram ASR + OpenAI brain + ElevenLabs TTS
// Ready for Render + GitHub deploy (Node 22 has fetch built-in)

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// ===================== CONFIG =====================
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "pNInz6obpgDQGcFmaJgB";

// ===================== LOGGER =====================
function log(event, data = {}) {
  console.log(JSON.stringify({ event, ...data }));
}

// ===================== EXPRESS =====================
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get("/", (_, res) =>
  res.send("✅ Old Line Barbershop AI receptionist is running.")
);

// ===================== STATE =====================
const conversations = new Map();

function newConvo(callSid, streamSid) {
  return {
    id: uuidv4(),
    callSid,
    streamSid,
    step: "start",
    slots: {
      service: "",
      date: "",
      time: "",
      name: "",
      phone: ""
    }
  };
}

// ===================== UTILS =====================
function normalizePhone(num) {
  if (!num) return "";
  return num.replace(/\D/g, "");
}
function computeEndISO(startISO) {
  try {
    const d = new Date(startISO);
    if (isNaN(d.getTime())) return "";
    return new Date(d.getTime() + 30 * 60000).toISOString();
  } catch {
    return "";
  }
}

// ===================== GPT HELPERS =====================
async function classifyUtterance(utterance, convo) {
  const sys = `
Return JSON only:
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
- If about prices/hours/services/location → intent=FAQ.
- If explicitly booking → intent=BOOK.
- If they give a new service/date/time/name/phone → update that field.
- Short, structured JSON only.
  `.trim();

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: utterance }
        ],
        response_format: { type: "json_object" }
      })
    });
    const json = await resp.json();
    const parsed = JSON.parse(json.choices?.[0]?.message?.content || "{}");
    log("GPT_CLASSIFY", { transcript: utterance, parsed });
    return parsed;
  } catch (e) {
    log("ERROR", { stage: "classify", error: e.message });
    return { intent: "UNKNOWN" };
  }
}

async function nlg(convo, hint = "") {
  const sys = `
You are a friendly receptionist. 
Write ONE short conversational sentence (<20 words).
Use contractions. Avoid repeating wording. 
Ask only one question if needed.
`.trim();

  const ctx = `
Slots: ${JSON.stringify(convo.slots)}
Step: ${convo.step}
`.trim();

  const user = `Compose next thing to say. Hint: ${hint}`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: sys },
          { role: "system", content: ctx },
          { role: "user", content: user }
        ]
      })
    });
    const json = await resp.json();
    return json.choices?.[0]?.message?.content?.trim() || "Okay.";
  } catch {
    return "Okay.";
  }
}

// ===================== TTS (ELEVENLABS) =====================
async function ttsToTwilio(ws, streamSid, text) {
  if (!text) return;
  if (!ELEVEN_API_KEY) {
    log("WARN", { msg: "No ElevenLabs credentials, skipping TTS" });
    return;
  }

  log("BOT_SAY", { reply: text });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 }
    })
  });

  const reader = resp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const b64 = Buffer.from(value).toString("base64");
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  }
  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }));
}

// ===================== FLOW =====================
async function handleUserText(ws, convo, utterance) {
  const parsed = await classifyUtterance(utterance, convo);

  // overwrite slots if new info
  for (const key of ["service", "date", "time", "name", "phone"]) {
    if (parsed[key]) convo.slots[key] = parsed[key];
  }

  let reply = "";

  if (parsed.intent === "FAQ") {
    if (parsed.faq_topic === "PRICES")
      reply = "Haircut $30, beard trim $15, combo $40.";
    else if (parsed.faq_topic === "HOURS")
      reply = "We’re open Monday–Friday 9–5, closed weekends.";
    else if (parsed.faq_topic === "SERVICES")
      reply = "We offer haircuts, beard trims, and combo packages.";
    else if (parsed.faq_topic === "LOCATION")
      reply = "We’re at 123 Blueberry Lane.";
  }

  if (parsed.intent === "BOOK") {
    if (!convo.slots.service) {
      convo.step = "service";
      reply = "What service would you like: haircut, beard trim, or combo?";
    } else if (!convo.slots.date || !convo.slots.time) {
      convo.step = "date";
      reply = `Great. What date and time work for your ${convo.slots.service}?`;
    } else if (!convo.slots.name) {
      convo.step = "name";
      reply = "Got it. Can I get your first name?";
    } else if (!convo.slots.phone) {
      convo.step = "phone";
      reply = "And your phone number for confirmation?";
    } else {
      convo.step = "done";
      reply = `Perfect. Booked ${convo.slots.name} for a ${convo.slots.service} on ${convo.slots.date} at ${convo.slots.time}. Confirmation will go to ${convo.slots.phone}.`;
    }
  }

  if (!reply) {
    reply = await nlg(convo, utterance);
  }

  await ttsToTwilio(ws, convo.streamSid, reply);
}

// ===================== WS HANDLERS =====================
wss.on("connection", (ws, req) => {
  let convo;

  ws.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.event === "start") {
      const callSid = data.start.callSid;
      const streamSid = data.start.streamSid;
      convo = newConvo(callSid, streamSid);
      conversations.set(callSid, convo);
      log("CALL_START", { streamSid });
      await ttsToTwilio(ws, streamSid, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
    }
    if (data.event === "media") {
      // audio chunks, forward to Deepgram if needed
    }
    if (data.event === "asr") {
      const transcript = data.text;
      log("ASR_FINAL", { transcript });
      await handleUserText(ws, convo, transcript);
    }
    if (data.event === "stop") {
      log("CALL_STOP", { streamSid: convo?.streamSid });
      conversations.delete(convo?.callSid);
    }
  });

  ws.on("close", () => {
    if (convo) conversations.delete(convo.callSid);
    log("WS_CLOSED");
  });
});

// ===================== START =====================
server.listen(PORT, () => log("SERVER_READY", { port: PORT }));
