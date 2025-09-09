// server.js — Twilio Stream + Deepgram + OpenAI + ElevenLabs + Make (Create/Read/Delete)

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;

// === YOUR MAKE WEBHOOKS (hard-coded here) ===
const MAKE_CREATE = "https://hook.us2.make.com/7hd4nxdrgytwukxw57cwyykhotv6hxrm";
const MAKE_READ   = "https://hook.us2.make.com/6hmur673mpqw4xgy2bhzx4be4o32ziax";
const MAKE_DELETE = "https://hook.us2.make.com/noy0e27knj7e1jlomtznw34z246i3xtv";

// ================= μ-law conversion =================
function ulawByteToPcm16(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << (exponent + 2)) - 0x84 * 4;
  if (sign) sample = -sample;
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}
function ulawBufferToPCM16LEBuffer(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    const s = ulawByteToPcm16(ulawBuf[i]);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

// ================= Deepgram =================
function startDeepgramLinear16({ onFinal }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY || "";
  const url =
    "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16&sample_rate=8000&channels=1&model=nova-2-phonecall"
    + "&interim_results=true&smart_format=true&language=en-US&endpointing=250";

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${key}` },
    perMessageDeflate: false,
  });

  dg.on("open", () => console.log("[Deepgram] connected"));
  dg.on("message", (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    const text = (alt?.transcript || "").trim();
    if (!text) return;
    if (ev.is_final) onFinal?.(text);
  });

  return {
    sendPCM16LE(buf) { try { dg.send(buf); } catch {} },
    close() { try { dg.close(); } catch {} },
  };
}

// ================= OpenAI =================
async function brainReply({ systemPrompt, history, userText }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return `You said: "${userText}".`;

  const body = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userText }
    ],
    temperature: 0.4,
    max_tokens: 200,
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) return `You said: "${userText}".`;
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || `You said: "${userText}".`;
}

// ================= ElevenLabs =================
async function speakEleven(ws, streamSid, text) {
  if (!streamSid) return;
  const key = process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) return;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) return;

  res.body.on("data", (chunk) => {
    const base64 = Buffer.from(chunk).toString("base64");
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64 } }));
  });
}

// ================= Call Make =================
async function callMake(url, payload, label) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log(`[Make] ${label} status`, res.status);
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`[Make] ${label} error`, e?.message || e);
    return {};
  }
}

// ================= HTTP =================
const app = express();
app.get("/", (_, res) => res.type("text/plain").send("OK"));
const server = http.createServer(app);

// ================= WebSocket =================
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (!u.pathname.startsWith("/twilio")) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ================= Session =================
wss.on("connection", (ws) => {
  let streamSid = null;
  let dg = null;

  async function handleUserText(text) {
    console.log("[user]", text);

    // Extract structured booking info
    const extractionPrompt = `
      Extract JSON with keys:
      { Event_Name, Start_Time, End_Time, Customer_Name, Customer_Phone, Customer_Email, Notes, intent }.
      intent should be CREATE, READ, or DELETE.
      If no match, return {}.
      User said: """${text}"""`;

    let bookingData = {};
    try {
      const raw = await brainReply({ systemPrompt: "Return JSON only.", history: [], userText: extractionPrompt });
      bookingData = JSON.parse(raw);
    } catch { bookingData = {}; }

    // === Handle CREATE ===
    if (bookingData.intent === "CREATE") {
      const readPayload = {
        api_key: "APPLES2025!",
        intent: "READ",
        biz: "acme-001",
        source: "phone",
        window: { start: bookingData.Start_Time, end: bookingData.End_Time },
      };
      const existing = await callMake(MAKE_READ, readPayload, "READ");
      if (existing?.events?.length) {
        return speakEleven(ws, streamSid, "That slot is already booked. Would you like another time?");
      }

      const createPayload = {
        api_key: "APPLES2025!",
        intent: "CREATE",
        biz: "acme-001",
        source: "phone",
        ...bookingData,
      };
      await callMake(MAKE_CREATE, createPayload, "CREATE");
      return speakEleven(ws, streamSid, `Your ${bookingData.Event_Name} was booked for ${bookingData.Start_Time}.`);
    }

    // === Handle DELETE ===
    if (bookingData.intent === "DELETE") {
      const delPayload = {
        api_key: "APPLES2025!",
        intent: "DELETE",
        biz: "acme-001",
        source: "phone",
        id: bookingData.id,
      };
      await callMake(MAKE_DELETE, delPayload, "DELETE");
      return speakEleven(ws, streamSid, "Your appointment was canceled.");
    }

    // === Fallback chat ===
    const reply = await brainReply({
      systemPrompt: "You are a helpful barbershop phone agent.",
      history: [],
      userText: text,
    });
    await speakEleven(ws, streamSid, reply);
  }

  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid;
      console.log("WS CONNECTED", streamSid);
      dg = startDeepgramLinear16({ onFinal: (t) => handleUserText(t) });
      await speakEleven(ws, streamSid, "Hi, welcome to Old Line Barbershop. How can I help?");
    }
    else if (evt.event === "media") {
      const b64 = evt.media?.payload || "";
      if (!b64) return;
      const ulaw = Buffer.from(b64, "base64");
      const pcm16le = ulawBufferToPCM16LEBuffer(ulaw);
      dg?.sendPCM16LE(pcm16le);
    }
    else if (evt.event === "stop") {
      console.log("Twilio STOP");
      dg?.close();
    }
  });
});

server.listen(PORT, () => console.log(`Server on :${PORT}`));
