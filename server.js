// server.js — Tiny voice bot with ElevenLabs voice (no websockets)
// Env: PORT, OPENAI_API_KEY, ELEVEN_API_KEY, ELEVEN_VOICE_ID, GREETING, SYSTEM_PROMPT
// Run: node server.js  (Node 18+)

import express from "express";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio posts form-encoded
app.use(express.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Adam
const GREETING = process.env.GREETING || "Hi, thanks for calling. How can I help you today?";
const SYSTEM_PROMPT =
  process.env.AGENT_PROMPT ||
  "You are a friendly receptionist. Reply in ONE short sentence (<22 words). If useful, end with ONE question.";

if (!OPENAI_API_KEY) console.warn("WARN: OPENAI_API_KEY missing");
if (!ELEVEN_API_KEY) console.warn("WARN: ELEVEN_API_KEY missing");

// ---- simple audio store
const AUDIO_DIR = path.join(process.cwd(), "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

// serve generated audio files
app.use("/audio", express.static(AUDIO_DIR, { maxAge: 0 }));

// small helper: TwiML that plays a file, then listens again
function playAndListen(audioUrl, actionUrl) {
  const xml = `
<Response>
  <Play>${audioUrl}</Play>
  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" language="en-US">
    <Pause length="1"/>
  </Gather>
</Response>`.trim();
  return xml;
}

// TwiML say+gather (first greeting)
function sayAndListen(text, actionUrl) {
  const xml = `
<Response>
  <Say>${text}</Say>
  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" language="en-US">
    <Pause length="1"/>
  </Gather>
</Response>`.trim();
  return xml;
}

// ---------- OpenAI: get next line ----------
async function aiReply(userText) {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Caller: ${userText}` },
        ],
      }),
    });
    const data = await r.json();
    return (data?.choices?.[0]?.message?.content || "Okay. What else can I help you with?").trim();
  } catch {
    return "Okay. What else can I help you with?";
  }
}

// ---------- ElevenLabs: synthesize MP3 ----------
async function elevenSayToFile(text) {
  const id = randomUUID();
  const file = path.join(AUDIO_DIR, `${id}.mp3`);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg", // mp3
    },
    body: JSON.stringify({
      text,
      // keep defaults simple; you can tweak later
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });

  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    throw new Error(`ElevenLabs ${r.status}: ${errTxt}`);
  }

  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return `/audio/${path.basename(file)}`;
}

// --------- Clean up old audio files every ~5 mins ----------
setInterval(() => {
  const now = Date.now();
  for (const f of fs.readdirSync(AUDIO_DIR)) {
    const full = path.join(AUDIO_DIR, f);
    try {
      const age = now - fs.statSync(full).mtimeMs;
      if (age > 5 * 60 * 1000) fs.unlinkSync(full);
    } catch {}
  }
}, 60 * 1000);

// ---------- Routes ----------
app.get("/", (_, res) => res.status(200).send("OK"));

// First turn: greet using <Say>, then listen
app.all("/voice", (req, res) => {
  const actionUrl = `/handle${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  res.type("text/xml").send(sayAndListen(GREETING, actionUrl));
});

// Each turn: take transcript -> OpenAI -> Eleven MP3 -> <Play> it -> Gather again
app.post("/handle", async (req, res) => {
  const speech = (req.body.SpeechResult || "").trim();
  const actionUrl = req.originalUrl; // preserve ?client_id=... if present

  const text = speech || "Please say that again.";
  let reply = await aiReply(text);

  try {
    const audioUrl = await elevenSayToFile(reply);
    res.type("text/xml").send(playAndListen(audioUrl, actionUrl));
  } catch {
    // fallback to <Say> if Eleven fails
    res.type("text/xml").send(sayAndListen(reply, actionUrl));
  }
});

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
