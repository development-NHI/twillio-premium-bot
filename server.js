// server.js — Old Line Barbershop AI Receptionist
import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import twilio from "twilio";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

// =============================
// STATE
// =============================
let conversations = {}; // { callSid: {...slots, step} }

function log(level, msg, meta = {}) {
  console.log(`${new Date().toISOString()} - [${level}] - ${msg}`, Object.keys(meta).length ? meta : "");
}

// =============================
// HELPERS
// =============================
function normalizePhone(num) {
  if (!num) return null;
  return num.replace(/\D/g, "");
}
function computeEndTime(start) {
  try {
    const d = new Date(start);
    return new Date(d.getTime() + 30 * 60000).toISOString();
  } catch {
    return "";
  }
}

// GPT for phrasing
async function phraseWithGPT(instruction) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              process.env.AGENT_PROMPT ||
              "You are a receptionist. Make this instruction sound natural."
          },
          { role: "user", content: instruction }
        ],
        temperature: 0.5,
        max_tokens: 50
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
    return resp.data.choices[0].message.content.trim();
  } catch (e) {
    log("ERROR", "GPT phrasing failed", { error: e.message });
    return instruction;
  }
}

// ElevenLabs TTS
async function speak(ws, streamSid, text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) {
    log("WARN", "No ElevenLabs credentials, skipping TTS");
    return;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  const resp = await axios.post(
    url,
    { text, voice_settings: { stability: 0.5, similarity_boost: 0.8 } },
    {
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json"
      },
      responseType: "stream"
    }
  );

  resp.data.on("data", (chunk) => {
    const b64 = Buffer.from(chunk).toString("base64");
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
  });
  resp.data.on("end", () => {
    ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }));
  });
}

// =============================
// MAKE.com
// =============================
async function checkAvailability(startISO, endISO) {
  try {
    const r = await axios.post(process.env.MAKE_READ, { start: startISO, end: endISO });
    return r.data.available;
  } catch (e) {
    log("ERROR", "Make READ failed", { error: e.message });
    return false;
  }
}
async function createBooking(payload) {
  try {
    await axios.post(process.env.MAKE_CREATE, payload);
    log("INFO", "Booking created", payload);
    return true;
  } catch (e) {
    log("ERROR", "Make CREATE failed", { error: e.message });
    return false;
  }
}
async function logFAQ(topic) {
  try {
    await axios.post(process.env.MAKE_FAQ, { topic });
  } catch {}
}

// =============================
// STATE MACHINE
// =============================
async function handleUtterance(ws, convo, streamSid, text) {
  log("DEBUG", "Handling", { step: convo.step, text });

  if (convo.step === "start") {
    convo.step = "service";
    const reply = await phraseWithGPT("Ask what service they would like: haircut, beard trim, or combo.");
    return speak(ws, streamSid, reply);
  }

  if (convo.step === "service") {
    if (/haircut/i.test(text)) convo.service = "Haircut";
    else if (/beard/i.test(text)) convo.service = "Beard Trim";
    else if (/combo|both/i.test(text)) convo.service = "Haircut + Beard Trim Combo";
    if (convo.service) {
      convo.step = "datetime";
      const reply = await phraseWithGPT(`Ask what date and time they prefer for their ${convo.service}.`);
      return speak(ws, streamSid, reply);
    }
    const retry = await phraseWithGPT("Please confirm: haircut, beard trim, or combo?");
    return speak(ws, streamSid, retry);
  }

  if (convo.step === "datetime") {
    convo.datetime = text;
    convo.startISO = new Date(text).toISOString();
    convo.endISO = computeEndTime(convo.startISO);
    const available = await checkAvailability(convo.startISO, convo.endISO);
    if (available) {
      convo.step = "name";
      const reply = await phraseWithGPT("That time is available. Ask for their first name.");
      return speak(ws, streamSid, reply);
    } else {
      const reply = await phraseWithGPT("That time is not available. Ask them to pick another date/time.");
      return speak(ws, streamSid, reply);
    }
  }

  if (convo.step === "name") {
    convo.name = text;
    convo.step = "phone";
    const reply = await phraseWithGPT("Ask for their phone number for confirmation.");
    return speak(ws, streamSid, reply);
  }

  if (convo.step === "phone") {
    const phone = normalizePhone(text);
    if (phone && phone.length >= 10) {
      convo.phone = phone;
      convo.step = "confirm";
      const reply = await phraseWithGPT(
        `Confirm booking: ${convo.service} for ${convo.name} on ${convo.datetime}. Phone: ${convo.phone}.`
      );
      return speak(ws, streamSid, reply);
    }
    const retry = await phraseWithGPT("Sorry, I didn’t catch that. Please repeat your phone number with area code.");
    return speak(ws, streamSid, retry);
  }

  if (convo.step === "confirm") {
    convo.step = "done";
    await createBooking({
      Event_Name: `${convo.service} – ${convo.name}`,
      Start_Time: convo.startISO,
      End_Time: convo.endISO,
      Customer_Name: convo.name,
      Customer_Phone: convo.phone,
      Notes: `Booked by AI receptionist`
    });
    const reply = await phraseWithGPT("Great, your appointment is confirmed. Ask if anything else is needed before goodbye.");
    return speak(ws, streamSid, reply);
  }

  if (convo.step === "done") {
    const reply = await phraseWithGPT("Thank them and say goodbye.");
    return speak(ws, streamSid, reply);
  }
}

// =============================
// WS SERVER
// =============================
const wss = new WebSocketServer({ noServer: true });
app.server = app.listen(PORT, () => log("INFO", `🚀 Server running on ${PORT}`));
app.server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const callSid = uuidv4();
  conversations[callSid] = { step: "start" };
  let streamSid = null;
  log("INFO", "WS CONNECTED", { callSid });

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      speak(ws, streamSid, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
    }
    if (msg.event === "transcript") {
      await handleUtterance(ws, conversations[callSid], streamSid, msg.text);
    }
    if (msg.event === "stop") {
      log("INFO", "Twilio stream STOP");
      ws.close();
    }
  });

  ws.on("close", () => {
    log("INFO", "WS CLOSED", { callSid });
    delete conversations[callSid];
  });
});

// =============================
// TWILIO ROUTE for 11200 FIX
// =============================
app.post("/twiml", (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  response.connect().stream({
    url: `wss://${req.headers.host}/`
  });
  res.type("text/xml");
  res.send(response.toString());
});

// Health check
app.get("/", (_, res) => res.send("✅ Old Line Barbershop AI receptionist is running"));
