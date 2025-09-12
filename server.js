// server.js
import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

// =============================
// GLOBAL STATE
// =============================
let conversations = {}; // { callSid: { step, service, datetime, name, phone } }

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

// Wrap GPT for phrasing
async function phraseWithGPT(instruction, convo) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: process.env.AGENT_PROMPT || "You are a natural receptionist. Rephrase instructions conversationally." },
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

// =============================
// MAKE.COM FUNCTIONS
// =============================
async function checkAvailability(startISO, endISO) {
  try {
    const r = await axios.post(process.env.MAKE_READ, { start: startISO, end: endISO });
    return r.data.available; // assume Make returns { available: true/false }
  } catch (e) {
    log("ERROR", "Make READ failed", { error: e.message });
    return false;
  }
}

async function createBooking(payload) {
  try {
    const r = await axios.post(process.env.MAKE_CREATE, payload);
    log("INFO", "Booking created", { status: r.status });
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
// STATE MACHINE HANDLER
// =============================
async function handleUtterance(ws, convo, text) {
  log("DEBUG", "Handling", { step: convo.step, text });

  if (convo.step === "start") {
    convo.step = "service";
    return phraseWithGPT("Ask what service they would like: haircut, beard trim, or combo.", convo);
  }

  if (convo.step === "service") {
    if (/haircut/i.test(text)) convo.service = "Haircut";
    else if (/beard/i.test(text)) convo.service = "Beard Trim";
    else if (/combo|both/i.test(text)) convo.service = "Haircut + Beard Trim Combo";
    if (convo.service) {
      convo.step = "datetime";
      return phraseWithGPT(`Ask what date and time they prefer for their ${convo.service}.`, convo);
    }
    return phraseWithGPT("Please confirm: haircut, beard trim, or combo?", convo);
  }

  if (convo.step === "datetime") {
    convo.datetime = text; // TODO: add chrono parser if needed
    convo.startISO = new Date(text).toISOString();
    convo.endISO = computeEndTime(convo.startISO);
    convo.step = "check_availability";
    const available = await checkAvailability(convo.startISO, convo.endISO);
    if (available) {
      convo.step = "name";
      return phraseWithGPT(`That time is open. Ask for their first name.`, convo);
    } else {
      convo.step = "datetime";
      return phraseWithGPT("That time is not available. Suggest another slot.", convo);
    }
  }

  if (convo.step === "name") {
    convo.name = text;
    convo.step = "phone";
    return phraseWithGPT("Ask for their phone number for confirmations.", convo);
  }

  if (convo.step === "phone") {
    const phone = normalizePhone(text);
    if (phone && phone.length >= 10) {
      convo.phone = phone;
      convo.step = "confirm";
      return phraseWithGPT(
        `Confirm booking: ${convo.service} for ${convo.name} on ${convo.datetime}. Phone: ${convo.phone}.`,
        convo
      );
    }
    return phraseWithGPT("Sorry, I didn’t catch that. Please repeat your phone number with area code.", convo);
  }

  if (convo.step === "confirm") {
    convo.step = "done";
    await createBooking({
      Event_Name: `${convo.service} – ${convo.name}`,
      Start_Time: convo.startISO,
      End_Time: convo.endISO,
      Customer_Name: convo.name,
      Customer_Phone: convo.phone,
      Notes: `Booked via AI receptionist. CallSid=${convo.callSid}`
    });
    return phraseWithGPT("Great, your appointment is confirmed. Ask if anything else is needed before goodbye.", convo);
  }

  if (convo.step === "done") {
    return phraseWithGPT("Thank them and say goodbye.", convo);
  }
}

// =============================
// WEBSOCKET SERVER
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
  conversations[callSid] = { callSid, step: "start" };
  log("INFO", "WS CONNECTED", { callSid });

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "transcript") {
        const reply = await handleUtterance(ws, conversations[callSid], data.text);
        if (reply) ws.send(JSON.stringify({ event: "bot", text: reply }));
      }
    } catch (e) {
      log("ERROR", "WS handler failed", { error: e.message });
    }
  });

  ws.on("close", () => {
    log("INFO", "WS CLOSED", { callSid });
    delete conversations[callSid];
  });
});

app.get("/", (_, res) => res.send("✅ Old Line Barbershop receptionist running"));
