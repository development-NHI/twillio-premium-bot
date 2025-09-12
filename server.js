// server.js
import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// =============================
// GLOBAL STATE
// =============================
const conversations = new Map(); // key = streamSid

function log(event, meta = {}) {
  console.log(JSON.stringify({ event, ...meta }));
}

// =============================
// UTILITIES
// =============================
function normalizePhone(num) {
  if (!num) return "";
  return num.replace(/\D/g, "");
}
function computeEndISO(startISO) {
  try {
    const d = new Date(startISO);
    if (isNaN(d)) return "";
    const end = new Date(d.getTime() + 30 * 60000);
    return end.toISOString();
  } catch {
    return "";
  }
}

// =============================
// OPENAI HELPERS
// =============================
async function classifyUtterance(utterance, convo) {
  const sys = `
Return a JSON object:
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
- FAQ: hours, prices, services, location → map to faq_topic.
- BOOK: if caller explicitly wants to book/reschedule/cancel.
- Extract service (haircut, beard trim, combo) if present.
- Extract date/time if present.
- Extract name if given.
- Extract phone if given.
- Keep replies short and human, slot-filling style.
`;

  const body = {
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: utterance }
    ],
    response_format: { type: "json_object" }
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    log("ERROR", { stage: "classifyUtterance", status: resp.status, txt });
    return { intent: "UNKNOWN" };
  }
  const data = await resp.json();
  let parsed;
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch {
    parsed = { intent: "UNKNOWN" };
  }
  log("GPT_CLASSIFY", { transcript: utterance, parsed });
  return parsed;
}

// =============================
// ELEVENLABS TTS
// =============================
async function say(ws, convo, text) {
  if (!text) return;
  const streamSid = ws.__streamSid;
  if (!streamSid) return;

  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
    log("WARN", { msg: "No ElevenLabs credentials, skipping TTS" });
    return;
  }

  log("BOT_SAY", { reply: text });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
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

// =============================
// FLOW
// =============================
async function handleUtterance(ws, utterance) {
  const convo = ws.__convo;
  const parsed = await classifyUtterance(utterance, convo);

  // slot filling & overwriting
  if (parsed.service) convo.slots.service = parsed.service;
  if (parsed.date) convo.slots.date = parsed.date;
  if (parsed.time) convo.slots.time = parsed.time;
  if (parsed.name) convo.slots.name = parsed.name;
  if (parsed.phone) convo.slots.phone = normalizePhone(parsed.phone);

  // FAQs
  if (parsed.intent === "FAQ") {
    if (parsed.faq_topic === "PRICES") {
      await say(ws, convo, "Haircut $30, beard trim $15, combo $40. Want me to book you?");
      return;
    }
    if (parsed.faq_topic === "HOURS") {
      await say(ws, convo, "We’re open Monday to Friday, 9 to 5, closed weekends.");
      return;
    }
    if (parsed.faq_topic === "SERVICES") {
      await say(ws, convo, "We offer haircuts, beard trims, and combo packages.");
      return;
    }
    if (parsed.faq_topic === "LOCATION") {
      await say(ws, convo, "We’re located at 123 Blueberry Lane.");
      return;
    }
  }

  // Booking flow
  if (parsed.intent === "BOOK" || convo.phase.startsWith("booking")) {
    if (!convo.slots.service) {
      convo.phase = "booking_service";
      await say(ws, convo, "Got it. What service would you like — haircut, beard trim, or combo?");
      return;
    }
    if (!convo.slots.date || !convo.slots.time) {
      convo.phase = "booking_time";
      await say(ws, convo, `When would you like your ${convo.slots.service}?`);
      return;
    }
    if (!convo.slots.name) {
      convo.phase = "booking_name";
      await say(ws, convo, "Can I get your name?");
      return;
    }
    if (!convo.slots.phone) {
      convo.phase = "booking_phone";
      await say(ws, convo, "What phone number should I use for confirmations?");
      return;
    }

    // Confirm booking
    convo.phase = "confirm_booking";
    const endTime = computeEndISO(convo.slots.date + " " + convo.slots.time);
    await say(ws, convo,
      `Perfect. I booked ${convo.slots.name} for a ${convo.slots.service} on ${convo.slots.date} at ${convo.slots.time}. Confirmation will be sent to ${convo.slots.phone}.`
    );
    return;
  }

  // Fallback / smalltalk
  await say(ws, convo, "I’m here to help! Would you like to ask about prices, hours, or book an appointment?");
}

// =============================
// WS SERVER
// =============================
const server = app.listen(PORT, () => {
  log("INFO", { msg: `Server running on port ${PORT}` });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  const streamSid = uuidv4();
  ws.__streamSid = streamSid;
  ws.__convo = {
    phase: "idle",
    slots: { service: "", date: "", time: "", name: "", phone: "" }
  };
  conversations.set(streamSid, ws.__convo);

  log("CALL_START", { streamSid });

  say(ws, ws.__convo, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.event === "stop") {
      log("CALL_STOP", { streamSid });
      ws.close();
      conversations.delete(streamSid);
      return;
    }
    if (msg.event === "asr") {
      const transcript = msg.text;
      log("ASR_FINAL", { transcript });
      await handleUtterance(ws, transcript);
    }
  });

  ws.on("close", () => {
    log("WS_CLOSE", { streamSid });
    conversations.delete(streamSid);
  });
});
