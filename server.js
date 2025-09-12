// server.js — Old Line Barbershop AI Receptionist (Deepgram + GPT + ElevenLabs + Make.com)

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const PORT = process.env.PORT || 5000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRA M_API_KEY || process.env.DEEPGRAM_API_KEY; // tolerate both
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL;
const MAKE_FAQ_URL = process.env.MAKE_FAQ_URL;

if (!OPENAI_API_KEY) console.warn("(!) OPENAI_API_KEY missing");
if (!DEEPGRAM_API_KEY) console.warn("(!) DEEPGRAM_API_KEY missing");
if (!ELEVENLABS_API_KEY) console.warn("(!) ELEVENLABS_API_KEY missing");

const app = express();
app.use(bodyParser.json());

app.get("/", (_, res) => res.status(200).send("✅ Old Line Barbershop AI Receptionist running"));

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

const server = app.listen(PORT, () => console.log(`[INFO] Server running on ${PORT}`));
const wss = new WebSocketServer({ server });

/* ----------------- Helpers ----------------- */
const SERVICES = ["haircut", "beard trim", "combo"];
function normalizeService(t = "") {
  const s = t.toLowerCase();
  if (/\b(combo|both|haircut\s*(\+|and|&)\s*beard)\b/.test(s)) return "combo";
  if (/\bbeard/.test(s)) return "beard trim";
  if (/\bhair ?cut\b/.test(s)) return "haircut";
  return "";
}
function normalizePhone(num) {
  if (!num) return "";
  const d = num.replace(/\D/g, "");
  if (d.length >= 10) return d.slice(-10);
  return "";
}
function fmtPhone10(d) {
  if (d.length !== 10) return d;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}
function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function computeEndFrom(dateISO, time24) {
  try {
    if (!dateISO || !time24) return "";
    const [hh, mm] = time24.split(":").map(x => parseInt(x, 10));
    const dt = new Date(`${dateISO}T${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00Z`);
    const end = new Date(dt.getTime() + 30 * 60 * 1000);
    return end.toISOString();
  } catch { return ""; }
}
function missingSlot(slots) {
  if (!slots.service) return "service";
  if (!slots.date || !slots.time) return "datetime";
  if (!slots.name) return "name";
  if (!slots.phone) return "phone";
  return "";
}

/* ----------------- Deepgram WebSocket ----------------- */
function startDeepgram({ onFinal }) {
  const url =
    "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16"
    + "&sample_rate=8000"
    + "&channels=1"
    + "&model=nova-2-phonecall"
    + "&interim_results=true"
    + "&smart_format=true"
    + "&language=en-US"
    + "&endpointing=250";

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });

  dg.on("open", () => console.log("[Deepgram] ws open"));
  dg.on("message", (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || "").trim();
    if (!text) return;
    if (ev.is_final || ev.speech_final) {
      console.log(JSON.stringify({ event: "ASR_FINAL", transcript: text }));
      onFinal?.(text);
    }
  });
  dg.on("error", (e) => console.error("[Deepgram error]", e.message));
  dg.on("close", () => console.log("[Deepgram closed]"));

  return {
    sendPCM16LE(buf) { try { dg.send(buf); } catch {} },
    close() { try { dg.close(); } catch {} }
  };
}

// μ-law -> PCM16LE
function ulawByteToPcm16(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << (exponent + 2)) - 0x84 * 4;
  if (sign) sample = -sample;
  return Math.max(-32768, Math.min(32767, sample));
}
function ulawBufferToPCM16LEBuffer(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i * 2);
  return out;
}

/* ----------------- GPT ----------------- */
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
        ...(response_format === "json" ? { response_format: { type: "json_object" } } : {}),
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    return resp.data.choices[0].message.content.trim();
  } catch (e) {
    console.error("[GPT ERROR]", e.message);
    return "";
  }
}

/* ----------------- TTS ----------------- */
async function say(ws, text) {
  if (!text) return;
  const streamSid = ws.__streamSid;
  if (!streamSid) return;

  console.log(JSON.stringify({ event: "BOT_SAY", reply: text }));

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn("[WARN] No ElevenLabs credentials, skipping TTS");
    return;
  }

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await axios.post(
      url,
      { text, voice_settings: { stability: 0.4, similarity_boost: 0.8 } },
      { headers: { "xi-api-key": ELEVENLABS_API_KEY }, responseType: "stream" }
    );
    resp.data.on("data", (chunk) => {
      const b64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
    });
    resp.data.on("end", () =>
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } }))
    );
  } catch (e) {
    console.error("[TTS ERROR]", e.message);
  }
}

/* ----------------- Booking utils (NEW) ----------------- */
function ensureBookingMode(ws) {
  if (!ws.__slots) ws.__slots = { service: "", date: "", time: "", name: "", phone: "" };
  if (!ws.__booking) ws.__booking = false;
}
function mergeSlots(ws, info, transcript) {
  ensureBookingMode(ws);

  // Service corrections (“actually I want combo”)
  const svcInTranscript = normalizeService(transcript);
  const svcParsed = normalizeService(info.service || "");
  const svcPick = svcParsed || svcInTranscript;
  if (svcPick) ws.__slots.service = svcPick;

  // Date/time quick normalize for "tomorrow"
  const dateRaw = (info.date || "").toLowerCase();
  if (dateRaw === "tomorrow") ws.__slots.date = tomorrowISO();
  else if (info.date) ws.__slots.date = info.date;

  if (info.time) ws.__slots.time = info.time;

  // Name & phone (pull even if intent flips to SMALLTALK)
  if (info.name) ws.__slots.name = info.name.trim();
  const phoneFromJSON = normalizePhone(info.phone || "");
  const phoneFromWords = normalizePhone(transcript);
  if (phoneFromJSON) ws.__slots.phone = phoneFromJSON;
  else if (phoneFromWords && phoneFromWords.length === 10) ws.__slots.phone = phoneFromWords;

  // If any booking slot is present, lock booking mode
  if (Object.values(ws.__slots).some(Boolean)) ws.__booking = true;

  console.log(JSON.stringify({ event: "SLOTS", slots: ws.__slots, missing: missingSlot(ws.__slots) || "none" }));
}

async function driveBooking(ws) {
  ensureBookingMode(ws);
  const m = missingSlot(ws.__slots);

  if (m === "service") {
    await say(ws, "What service would you like — a haircut, beard trim, or the combo?");
    return true;
  }
  if (m === "datetime") {
    await say(ws, `What date and time would you like for your ${ws.__slots.service || "appointment"}?`);
    return true;
  }
  if (m === "name") {
    await say(ws, "Can I get your first name?");
    return true;
  }
  if (m === "phone") {
    await say(ws, "What phone number should I use for confirmations?");
    return true;
  }

  // All set → finalize
  const { service, date, time, name, phone } = ws.__slots;
  const startISO = date && time ? new Date(`${date}T${time}:00Z`).toISOString() : "";
  const endISO = computeEndFrom(date, time);

  // Send to Make (best-effort)
  if (MAKE_CREATE_URL) {
    try {
      await axios.post(MAKE_CREATE_URL, {
        Event_Name: service || "Appointment",
        Start_Time: startISO,
        End_Time: endISO,
        Customer_Name: name || "",
        Customer_Phone: phone || "",
        Customer_Email: "",
        Notes: `Booked by voice agent.`
      }, { timeout: 8000 });
      console.log(JSON.stringify({ event: "MAKE_CREATE_OK" }));
    } catch (e) {
      console.error("[Make CREATE] error", e.message);
    }
  }

  await say(ws, `Great, ${name}. I’ve booked a ${service} on ${date} at ${time}. I have your number as ${fmtPhone10(phone)}. You’re all set. Anything else I can help with?`);

  // Keep ws.__booking true so user can adjust; if they say "actually", the next utterance can correct slots and we can reconfirm.
  return true;
}

/* ----------------- WS ----------------- */
wss.on("connection", (ws) => {
  let dg = null;
  let pendingULaw = [];
  const BATCH_FRAMES = 5;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      ws.__convoId = uuidv4();
      ws.__booking = false;
      ws.__slots = { service: "", date: "", time: "", name: "", phone: "" };
      console.log(JSON.stringify({ event: "CALL_START", streamSid: ws.__streamSid, convoId: ws.__convoId }));

      // Start Deepgram
      dg = startDeepgram({
        onFinal: async (text) => {
          const systemPrompt = `
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
- Always extract any slot values you can, even for SMALLTALK.
- For "tomorrow", put "tomorrow" in date (the app will convert).
- Prefer 24h time like "15:00".
- Services: "haircut", "beard trim", or "combo".
`;
          const parsedJson = await askGPT(systemPrompt, text, "json");
          let info = {};
          try { info = JSON.parse(parsedJson || "{}"); } catch {}
          console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript: text, parsed: info }));

          // Always merge slots (even if intent wobbles)
          mergeSlots(ws, info, text);

          // FAQ outside booking mode
          if (!ws.__booking && info.intent === "FAQ") {
            let answer = "";
            if (info.faq_topic === "HOURS") answer = "We’re open Monday to Friday, 9 AM to 5 PM, closed weekends.";
            if (info.faq_topic === "PRICES") answer = "Haircut $30, beard trim $15, combo $40.";
            if (info.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo package.";
            if (info.faq_topic === "LOCATION") answer = "We’re at 123 Blueberry Lane.";
            if (MAKE_FAQ_URL && info.faq_topic) {
              try { await axios.post(MAKE_FAQ_URL, { intent: "FAQ", topic: info.faq_topic }, { timeout: 4000 }); } catch {}
            }
            await say(ws, answer || "Happy to help. Anything else?");
            return;
          }

          // Transfer outside booking mode
          if (!ws.__booking && info.intent === "TRANSFER") {
            await say(ws, "I’m not sure about that, let me transfer you to the owner. Please hold.");
            try { ws.close(); } catch {}
            return;
          }

          // If user says “book”, or we already have any slots, drive booking
          if (info.intent === "BOOK" || ws.__booking) {
            ws.__booking = true;
            await driveBooking(ws);
            return;
          }

          // Otherwise smalltalk fallback
          const phrased = await askGPT(
            "You are a helpful, concise, friendly receptionist. One short sentence. If user seems ready to book, gently ask what service they want.",
            text
          );
          await say(ws, phrased || "How can I help you further?");
        }
      });

      await say(ws, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
      return;
    }

    if (msg.event === "media") {
      const b64 = msg.media?.payload || "";
      if (!b64 || !dg) return;
      const ulaw = Buffer.from(b64, "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= BATCH_FRAMES) {
        const ulawChunk = Buffer.concat(pendingULaw);
        const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
        try { dg.sendPCM16LE(pcm16le); } catch {}
        pendingULaw = [];
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("[INFO] Twilio stream STOP");
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
    }
  });

  ws.on("close", () => {
    try { dg?.close(); } catch {}
    console.log("[INFO] WS closed", { convoId: ws.__convoId });
  });
});
