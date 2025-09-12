// server.js — Old Line Barbershop AI Receptionist
// Dynamic slot-filling agent with FAQ knowledge + booking integration

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

// -----------------------
// CONFIG / ENV
// -----------------------
const PORT = process.env.PORT || 5000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL;
const MAKE_FAQ_URL = process.env.MAKE_FAQ_URL;

if (!OPENAI_API_KEY) console.warn("(!) OPENAI_API_KEY missing");
if (!ELEVENLABS_API_KEY) console.warn("(!) ELEVENLABS_API_KEY missing");
if (!ELEVENLABS_VOICE_ID) console.warn("(!) ELEVENLABS_VOICE_ID missing");

// -----------------------
// APP + SERVER
// -----------------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health
app.get("/", (_, res) => res.status(200).send("✅ Old Line Barbershop AI Receptionist running"));

// Twilio TwiML route
app.post("/twiml", (_, res) => {
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME || "localhost:"+PORT}"/>
      </Connect>
    </Response>
  `);
});

const server = app.listen(PORT, () => {
  console.log(`[INFO] Server running on ${PORT}`);
});

// -----------------------
// WEBSOCKET
// -----------------------
const wss = new WebSocketServer({ server });

/**
 * Slot-filling convo state
 */
function newConvo(callSid) {
  return {
    id: uuidv4(),
    callSid,
    streamSid: null,
    slots: { service: "", date: "", time: "", name: "", phone: "" },
    done: false,
  };
}

const conversations = new Map();

// -----------------------
// GPT HELPERS
// -----------------------
async function askGPT(systemPrompt, userPrompt, response_format = "text") {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(response_format === "json"
          ? { response_format: { type: "json_object" } }
          : {}),
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return resp.data.choices[0].message.content.trim();
  } catch (e) {
    console.error("[GPT ERROR]", e.message);
    return "";
  }
}

// -----------------------
// TTS (ElevenLabs → Twilio)
// -----------------------
async function say(ws, text) {
  if (!text) return;
  const streamSid = ws.__streamSid;
  if (!streamSid) return;

  console.log("[TTS ->]", text);

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn("[WARN] No ElevenLabs credentials, skipping TTS");
    return;
  }

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await axios.post(
      url,
      {
        text,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      },
      {
        headers: { "xi-api-key": ELEVENLABS_API_KEY },
        responseType: "stream",
      }
    );

    resp.data.on("data", (chunk) => {
      const b64 = Buffer.from(chunk).toString("base64");
      ws.send(
        JSON.stringify({ event: "media", streamSid, media: { payload: b64 } })
      );
    });
    resp.data.on("end", () =>
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }))
    );
  } catch (e) {
    console.error("[TTS ERROR]", e.message);
  }
}

// -----------------------
// MAIN CONVO HANDLER
// -----------------------
wss.on("connection", (ws) => {
  const convo = newConvo(uuidv4());
  conversations.set(convo.id, convo);

  ws.__convo = convo;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // start event
    if (msg.event === "start") {
      convo.streamSid = msg.start.streamSid;
      ws.__streamSid = convo.streamSid;
      await say(ws, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
      return;
    }

    // stop event
    if (msg.event === "stop") {
      console.log("[INFO] Stream STOP");
      try { ws.close(); } catch {}
      conversations.delete(convo.id);
      return;
    }

    // transcript event (from Twilio ASR)
    if (msg.event === "transcript") {
      const userText = msg.text;
      console.log("[ASR final]", userText);

      // -----------------------
      // Call GPT to classify
      // -----------------------
      const systemPrompt = `
You are a receptionist assistant. Extract intent and slot info.
Return JSON like:
{
 "intent": "FAQ" | "BOOK" | "SMALLTALK" | "TRANSFER" | "UNKNOWN",
 "faq_topic": "HOURS"|"PRICES"|"SERVICES"|"LOCATION"| "",
 "service": "",
 "date": "",
 "time": "",
 "name": "",
 "phone": ""
}
      `;
      const parsed = await askGPT(systemPrompt, userText, "json");
      let info = {};
      try { info = JSON.parse(parsed); } catch { info = {}; }

      // -----------------------
      // FAQ branch
      // -----------------------
      if (info.intent === "FAQ") {
        let answer = "";
        if (info.faq_topic === "HOURS")
          answer = "We’re open Monday to Friday, 9 AM to 5 PM, and closed weekends.";
        if (info.faq_topic === "PRICES")
          answer = "Haircut is $30, beard trim $15, and combo $40.";
        if (info.faq_topic === "SERVICES")
          answer = "We offer haircuts, beard trims, and combo packages.";
        if (info.faq_topic === "LOCATION")
          answer = "We’re at 123 Blueberry Lane.";

        // humanize with GPT
        const phrased = await askGPT(process.env.AGENT_PROMPT, answer);
        await say(ws, phrased);
        return;
      }

      // -----------------------
      // Booking branch
      // -----------------------
      if (info.intent === "BOOK") {
        // fill slots
        for (const k of ["service", "date", "time", "name", "phone"]) {
          if (info[k]) convo.slots[k] = info[k];
        }

        // check missing
        const missing = Object.entries(convo.slots).filter(([_, v]) => !v).map(([k]) => k);
        if (missing.length) {
          const next = missing[0];
          let q = "";
          if (next === "service") q = "What service would you like, haircut, beard trim, or combo?";
          if (next === "date") q = "What date works best for you?";
          if (next === "time") q = "What time should I book it for?";
          if (next === "name") q = "Can I get your name please?";
          if (next === "phone") q = "What phone number should I use for confirmation?";
          await say(ws, q);
          return;
        }

        // all slots filled
        if (!convo.done) {
          convo.done = true;
          // push to Make
          try {
            await axios.post(MAKE_CREATE_URL, {
              Event_Name: `${convo.slots.service} – ${convo.slots.name}`,
              Start_Time: `${convo.slots.date} ${convo.slots.time}`,
              End_Time: "", // let Make add +30m if needed
              Customer_Name: convo.slots.name,
              Customer_Phone: convo.slots.phone,
              Notes: `Booked by phone agent. CallSid=${convo.callSid}`,
            });
          } catch (e) {
            console.error("[MAKE CREATE ERROR]", e.message);
          }

          const confirm = `Great, I’ve booked a ${convo.slots.service} for ${convo.slots.name} on ${convo.slots.date} at ${convo.slots.time}. I have your phone as ${convo.slots.phone}. You’re all set.`;
          await say(ws, confirm);
        }
        return;
      }

      // -----------------------
      // Transfer branch
      // -----------------------
      if (info.intent === "TRANSFER") {
        await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
        try { ws.close(); } catch {}
        return;
      }

      // -----------------------
      // Smalltalk / unknown
      // -----------------------
      const phrased = await askGPT(process.env.AGENT_PROMPT, userText);
      await say(ws, phrased);
    }
  });

  ws.on("close", () => {
    conversations.delete(convo.id);
    console.log("[INFO] WS CLOSED");
  });
});
