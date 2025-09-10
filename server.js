// server.js

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// =============================
// GLOBAL STATE
// =============================
let conversations = {}; // { callSid: { service, name, dateTime, phone, step } }

// Utility: safe logging
function log(level, msg, meta = {}) {
  console.log(
    `${new Date().toISOString()} - [${level}] - ${msg} ${
      Object.keys(meta).length ? "| " + JSON.stringify(meta) : ""
    }`
  );
}

// =============================
// HELPER FUNCTIONS
// =============================

// Normalize phone
function normalizePhone(num) {
  if (!num) return null;
  return num.replace(/\D/g, "");
}

// Detect if text contains a keyword (fixed regex)
function containsWord(text, word) {
  if (!text || !word) return false;
  const regex = new RegExp(`\\b${word}\\b`, "i"); // ✅ FIXED
  return regex.test(text);
}

// =============================
// GPT CALLER
// =============================
async function askGPT(prompt) {
  try {
    log("INFO", "[askGPT] Sending prompt", { prompt });
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: prompt }],
        temperature: 0.5,
        max_tokens: 150,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const text = response.data.choices[0].message.content.trim();
    log("INFO", "[askGPT] Got response", { text });
    return text;
  } catch (err) {
    log("ERROR", "[askGPT] Failed", { error: err.message });
    return "Sorry, I had trouble processing that.";
  }
}

// =============================
// MAIN WEBSOCKET SERVER
// =============================
const wss = new WebSocketServer({ noServer: true });

// Handle WS Upgrade
app.server = app.listen(PORT, () => {
  log("INFO", `🚀 Server running on port ${PORT}`);
});

app.server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// WebSocket per-call connection
wss.on("connection", (ws, req) => {
  const callSid = uuidv4();
  conversations[callSid] = { step: "start" };

  log("INFO", "WS CONNECTED", { callSid });

  ws.on("message", async (message) => {
    try {
      const msg = message.toString();
      log("DEBUG", "[WS MESSAGE]", { msg });

      // Expect JSON from Twilio stream
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        log("WARN", "[WS] Non-JSON message", { msg });
        return;
      }

      // Only handle speech transcripts
      if (data.event === "transcript") {
        const transcript = data.text;
        log("INFO", "[ASR]", { transcript });

        let convo = conversations[callSid];

        // ===== STATEFUL HANDLING =====
        if (convo.step === "start") {
          convo.step = "service";
          ws.send(
            JSON.stringify({
              event: "bot",
              text: "What service would you like — a haircut, beard trim, or combo?",
            })
          );
        } else if (convo.step === "service") {
          if (
            containsWord(transcript, "haircut") ||
            containsWord(transcript, "combo") ||
            containsWord(transcript, "beard")
          ) {
            convo.service = transcript;
            convo.step = "date";
            ws.send(
              JSON.stringify({
                event: "bot",
                text: `Got it. What date and time work for your ${convo.service}?`,
              })
            );
          } else {
            ws.send(
              JSON.stringify({
                event: "bot",
                text: "Could you tell me if you'd like a haircut, beard trim, or the combo?",
              })
            );
          }
        } else if (convo.step === "date") {
          convo.dateTime = transcript;
          convo.step = "name";
          ws.send(
            JSON.stringify({
              event: "bot",
              text: "Could I get your first name please?",
            })
          );
        } else if (convo.step === "name") {
          convo.name = transcript;
          convo.step = "phone";
          ws.send(
            JSON.stringify({
              event: "bot",
              text: "What phone number should I use for confirmations?",
            })
          );
        } else if (convo.step === "phone") {
          const phone = normalizePhone(transcript);
          if (phone && phone.length >= 10) {
            convo.phone = phone;
            convo.step = "done";

            // Calculate end time = +30 minutes (fake for now, could integrate chrono)
            ws.send(
              JSON.stringify({
                event: "bot",
                text: `Perfect. I booked ${convo.name} for a ${convo.service} on ${convo.dateTime}. You'll get a confirmation at ${convo.phone}.`,
              })
            );
          } else {
            ws.send(
              JSON.stringify({
                event: "bot",
                text: "Sorry, I didn’t catch that number — please say it again with area code.",
              })
            );
          }
        } else if (convo.step === "done") {
          ws.send(
            JSON.stringify({
              event: "bot",
              text: "You're all set. Anything else I can help with?",
            })
          );
        }
      }
    } catch (err) {
      log("ERROR", "[WS handler]", { error: err.message });
    }
  });

  ws.on("close", () => {
    log("INFO", "WS CLOSED", { callSid });
    delete conversations[callSid];
  });
});

// =============================
// TEST ROUTE
// =============================
app.get("/", (req, res) => {
  res.send("Old Line Barbershop AI receptionist is running ✅");
});
