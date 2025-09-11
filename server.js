import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import FormData from "form-data";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

let conversations = {};

const server = app.listen(PORT, () =>
  console.log(`✅ Server running on port ${PORT}`)
);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const callSid = uuidv4();
  conversations[callSid] = { transcript: [] };

  console.log("📞 New call connected", callSid);

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "media") {
        const audioBuffer = Buffer.from(data.media.payload, "base64");

        const formData = new FormData();
        formData.append("file", audioBuffer, { filename: "audio.wav" });
        formData.append("model", "whisper-1");

        const sttRes = await axios.post(
          "https://api.openai.com/v1/audio/transcriptions",
          formData,
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              ...formData.getHeaders(),
            },
          }
        );

        const transcript = sttRes.data.text;
        if (!transcript) return;

        conversations[callSid].transcript.push({ role: "user", content: transcript });
        console.log("👤 Caller:", transcript);

        const gptRes = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: process.env.AGENT_PROMPT },
              ...conversations[callSid].transcript,
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );

        const aiReply = gptRes.data.choices[0].message.content;
        conversations[callSid].transcript.push({ role: "assistant", content: aiReply });
        console.log("🤖 AI:", aiReply);

        let jsonAction = null;
        try {
          const match = aiReply.match(/\{[\s\S]*\}/);
          if (match) jsonAction = JSON.parse(match[0]);
        } catch (err) {
          console.log("⚠️ No valid JSON found in reply");
        }

        if (jsonAction && jsonAction.action) {
          console.log("➡️ Action detected:", jsonAction.action);

          let url = null;
          if (jsonAction.action === "create_booking") url = process.env.MAKE_CREATE;
          else if (jsonAction.action === "cancel_booking") url = process.env.MAKE_DELETE;
          else if (jsonAction.action === "reschedule_booking") url = process.env.MAKE_READ;
          else url = process.env.MAKE_WEBHOOK; // fallback

          if (url) {
            await axios.post(url, {
              secret: process.env.MAKE_SECRET,
              ...jsonAction,
            });
            console.log(`📡 Sent to Make.com scenario: ${url}`);
          }
        }

        const tts = await axios.post(
          `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}`,
          { text: aiReply },
          {
            headers: {
              "xi-api-key": process.env.ELEVEN_API_KEY,
              "Content-Type": "application/json",
            },
            responseType: "arraybuffer",
          }
        );

        ws.send(
          JSON.stringify({
            event: "assistant",
            audio: Buffer.from(tts.data).toString("base64"),
          })
        );
      }
    } catch (err) {
      console.error("❌ Error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("☎️ Call ended", callSid);
    delete conversations[callSid];
  });
});
