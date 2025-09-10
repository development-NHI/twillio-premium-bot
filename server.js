// server.js — Twilio Connect/Stream + Deepgram + OpenAI + ElevenLabs + Make
// Handles slot filling (service, date, time, name, phone) with improved phone parsing.

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;
const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK || "";

/* ===================== μ-law -> PCM16LE ===================== */
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
  for (let i = 0; i < ulawBuf.length; i++) {
    const s = ulawByteToPcm16(ulawBuf[i]);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

/* ===================== Phone Parser ===================== */
function parsePhone(input, callerId, retries = 0) {
  if (!input) return null;

  // Handle "this number"
  if (/this number/i.test(input)) return callerId;

  // Spoken → digits map
  const wordsToDigits = {
    zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
    six: "6", seven: "7", eight: "8", nine: "9"
  };

  let normalized = input.toLowerCase();
  for (const [word, digit] of Object.entries(wordsToDigits)) {
    const regex = new RegExp(\\b${word}\\b, "gi");
    normalized = normalized.replace(regex, digit);
  }

  // Strip non-digits
  const digits = normalized.replace(/\D/g, "");

  if (digits.length >= 7) return digits;

  // Fallback after retries
  if (retries >= 2 && callerId) return callerId;

  return null;
}

/* ===================== Deepgram Realtime ===================== */
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY || "";

  const url =
    "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16&sample_rate=8000&channels=1"
    + "&model=nova-2-phonecall&interim_results=true&smart_format=true&language=en-US&endpointing=250";

  const dg = new WebSocket(url, {
    headers: { Authorization: token ${key} },
    perMessageDeflate: false,
  });

  let open = false;
  const q = [];

  dg.on("open", () => {
    open = true;
    console.log("[Deepgram] open");
    onOpen?.();
    while (q.length) dg.send(q.shift());
  });

  dg.on("message", (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || "").trim();
    if (!text) return;
    if (ev.is_final) onFinal?.(text); else onPartial?.(text);
  });

  dg.on("error", (e) => { console.error("[Deepgram] ws error:", e?.message); onError?.(e); });
  dg.on("close", () => console.log("[Deepgram] ws closed"));

  return {
    sendPCM16LE(buf) { if (open) dg.send(buf); else q.push(buf); },
    close() { try { dg.close(); } catch {} }
  };
}

/* ===================== OpenAI Brain ===================== */
async function brainReply({ systemPrompt, history, userText }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return You said: "${userText}".;

  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userText }
    ],
    temperature: 0.5,
    max_tokens: 120
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": Bearer ${apiKey}, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!res.ok) return You said: "${userText}".;

  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || You said: "${userText}".;
}

/* ===================== ElevenLabs TTS ===================== */
async function speakEleven(ws, streamSid, text) {
  if (!streamSid) return;
  const key = process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) return;

  const url = https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000;

  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });

  if (!res.ok || !res.body) return;

  console.log("[TTS ->]", text);
  return new Promise((resolve, reject) => {
    res.body.on("data", (chunk) => {
      const base64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64 } }));
    });
    res.body.on("end", resolve);
    res.body.on("error", reject);
  });
}

/* ===================== Express & WS ===================== */
const app = express();
app.get("/", (_, res) => res.type("text/plain").send("OK"));
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, http://${req.headers.host});
  if (u.pathname !== "/twilio") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

/* ===================== Call Flow ===================== */
wss.on("connection", (ws) => {
  let streamSid = null;
  let dg = null;
  const history = [];
  const session = { service: null, date: null, time: null, name: null, phone: null, phoneRetries: 0 };

  const systemPrompt =
    process.env.AGENT_PROMPT ||
    "You are a friendly AI receptionist for Old Line Barbershop. Fill slots: service, date, time, name, phone. Confirm once filled.";

  async function handleUserText(text, callSid, callerId) {
    console.log("[user]", text);

    // Slot filling logic
    let reply = "";

    if (!session.service) {
      if (/haircut/i.test(text)) session.service = "haircut";
      else if (/beard/i.test(text)) session.service = "beard trim";
      else if (/combo/i.test(text)) session.service = "haircut + beard trim";
      reply = session.service
        ? What date and time would you like for your ${session.service}?
        : "What service would you like today: haircut, beard trim, or combo?";
    }
    else if (!session.date || !session.time) {
      if (/\d/.test(text)) {
        session.date = text;
        session.time = text;
        reply = "Got it. Could I get your first name please?";
      } else reply = "What date and time works best for you?";
    }
    else if (!session.name) {
      if (text.length > 1) {
        session.name = text.replace(/[^a-z ]/gi, "").trim();
        reply = "Thanks! Could I get your phone number for confirmation?";
      } else reply = "Sorry, I didn’t catch your name. Could you repeat it?";
    }
    else if (!session.phone) {
      const phone = parsePhone(text, callerId, session.phoneRetries);
      if (phone) {
        session.phone = phone;
        reply = Thanks ${session.name}. I’ve booked your ${session.service} on ${session.date} at ${session.time}. We’ll text confirmation to ${session.phone}.;
        // Fire webhook
        if (MAKE_WEBHOOK) {
          fetch(MAKE_WEBHOOK, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "BOOK", callSid, session })
          }).catch(() => {});
        }
      } else {
        session.phoneRetries++;
        reply = "Could you please repeat your phone number, digit by digit?";
      }
    }
    else {
      reply = "You're all set. Anything else I can help you with?";
    }

    history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    await speakEleven(ws, streamSid, reply);
  }

  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid;
      const callSid = evt.start?.callSid;
      const callerId = evt.start?.callerId || "unknown";
      console.log("[INFO] WS CONNECTED | CallSid:", callSid, "| streamSid:", streamSid);

      if (process.env.DEEPGRAM_API_KEY) {
        dg = startDeepgramLinear16({
          onOpen: () => console.log("[ASR] Deepgram open"),
          onPartial: (t) => console.log("[partial]", t),
          onFinal: (t) => handleUserText(t, callSid, callerId)
        });
      }
      await speakEleven(ws, streamSid, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
    }

    else if (evt.event === "media" && dg) {
      const b64 = evt.media?.payload;
      if (!b64) return;
      const ulaw = Buffer.from(b64, "base64");
      const pcm16le = ulawBufferToPCM16LEBuffer(ulaw);
      try { dg.sendPCM16LE(pcm16le); } catch {}
    }

    else if (evt.event === "stop") {
      if (dg) dg.close();
      console.log("Twilio stream STOP");
    }
  });

  ws.on("close", () => { if (dg) dg.close(); console.log("WS closed"); });
  ws.on("error", (e) => console.error("WS error", e?.message));
});

server.listen(PORT, () => console.log(Server running on 0.0.0.0:${PORT}));
