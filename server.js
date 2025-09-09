// server.js — Twilio Connect/Stream + Deepgram (URL-config) + OpenAI brain + ElevenLabs TTS + Make webhooks

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;

// === Make.com webhook URLs (set in .env) ===
const MAKE_CREATE = process.env.MAKE_CREATE || "";
const MAKE_READ   = process.env.MAKE_READ   || "";
const MAKE_DELETE = process.env.MAKE_DELETE || "";

/* ===================== μ-law -> PCM16LE (correct) ===================== */
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

/* ===================== Deepgram realtime (URL-config) ===================== */
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY || "";

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
    headers: { Authorization: `token ${key}` },
    perMessageDeflate: false,
  });

  let open = false;
  const q = [];

  dg.on("open", () => {
    open = true;
    console.log("[Deepgram] ws open (URL-config)");
    onOpen?.();
    while (q.length) dg.send(q.shift());
  });

  dg.on("message", (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    onAnyMessage?.(ev);

    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || "").trim();
    if (!text) return;
    const isFinal = ev.is_final === true || ev.speech_final === true;
    if (isFinal) onFinal?.(text);
    else onPartial?.(text);
  });

  dg.on("error", (e) => {
    console.error("[Deepgram] ws error:", e?.message || e);
    onError?.(e);
  });

  dg.on("close", (c, r) => {
    console.log("[Deepgram] ws closed", c, r?.toString?.() || "");
  });

  return {
    sendPCM16LE(buf) { if (open) dg.send(buf); else q.push(buf); },
    close() { try { dg.close(); } catch {} },
  };
}

/* ===================== OpenAI brain ===================== */
async function brainReply({ systemPrompt, history, userText }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("(!) OPENAI_API_KEY missing — using echo fallback.");
    return `You said: "${userText}".`;
  }

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

  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error("[OpenAI] network error:", e?.message || e);
    return `You said: "${userText}".`;
  }

  if (!res.ok) {
    console.error("[OpenAI] HTTP", res.status, await safeRead(res));
    return `You said: "${userText}".`;
  }

  const json = await res.json();
  const txt = json.choices?.[0]?.message?.content?.trim();
  return txt || `You said: "${userText}".`;
}
async function safeRead(res) { try { return await res.text(); } catch { return "(no body)"; } }

/* ===================== ElevenLabs TTS ===================== */
async function speakEleven(ws, streamSid, text) {
  if (!streamSid) return;
  const key = process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) {
    console.log("(!) ELEVEN vars missing — skipping TTS");
    return;
  }
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
    });
  } catch (e) {
    console.error("[TTS] network error:", e?.message || e);
    return;
  }

  if (!res.ok || !res.body) {
    console.error("[TTS] HTTP", res.status, await safeRead(res));
    return;
  }

  console.log("[TTS] streaming reply bytes…");
  return new Promise((resolve, reject) => {
    res.body.on("data", (chunk) => {
      const base64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64 } }));
    });
    res.body.on("end", () => { console.log("[TTS] stream end"); resolve(); });
    res.body.on("error", (e) => { console.error("[TTS] stream error:", e?.message || e); reject(e); });
  });
}

/* ===================== Make Webhook Helpers ===================== */
async function callMake(webhook, payload, label) {
  if (!webhook) return;
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    console.log(`[Make ${label}] HTTP ${res.status}: ${text}`);
  } catch (e) {
    console.error(`[Make ${label}] webhook failed:`, e?.message || e);
  }
}

async function maybeFireMake(words, callSid) {
  if (/book|appointment|schedule|reserve/i.test(words)) {
    const payload = {
      api_key: "APPLES2025!",
      intent: "CREATE",
      biz: "acme-001",
      source: "phone",
      Event_Name: "Haircut",
      Start_Time: "2025-09-09T10:00:00-04:00",
      End_Time: "2025-09-09T10:30:00-04:00",
      Customer_Name: "John Doe",
      Customer_Phone: "+15551234567",
      Customer_Email: "john@example.com",
      Notes: words
    };
    callMake(MAKE_CREATE, payload, "CREATE");
  }

  if (/what.*schedule|show.*appointments|when.*available/i.test(words)) {
    const payload = {
      api_key: "APPLES2025!",
      intent: "READ",
      biz: "acme-001",
      source: "phone",
      window: {
        start: "2025-01-01T00:00:00-05:00",
        end: "2025-12-31T23:59:59-05:00"
      }
    };
    callMake(MAKE_READ, payload, "READ");
  }

  if (/cancel|delete|remove/i.test(words)) {
    const payload = {
      api_key: "APPLES2025!",
      intent: "DELETE",
      biz: "acme-001",
      source: "phone",
      event_id: "REPLACE_WITH_REAL_ID"
    };
    callMake(MAKE_DELETE, payload, "DELETE");
  }
}

/* ===================== HTTP app (health + browser check) ===================== */
const app = express();
app.get("/",  (_, res) => res.type("text/plain").send("OK"));
app.get("/twilio",  (_, res) => res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio"));
app.get("/twilio/", (_, res) => res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio/"));
const server = http.createServer(app);

/* ===================== WebSocket (manual upgrade) ===================== */
const { WebSocketServer: WSS } = require("ws");
const wss = new WSS({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    console.log("[UPGRADE] path:", u.pathname, "search:", u.search);
    if (u.pathname !== "/twilio" && u.pathname !== "/twilio/") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch (e) {
    console.error("[UPGRADE] exception:", e?.message || e);
    try { socket.destroy(); } catch {}
  }
});

/* ===================== Twilio μ-law → Deepgram → OpenAI → ElevenLabs ===================== */
wss.on("connection", (ws) => {
  let streamSid = null;
  let dg = null;
  let dgOpened = false;
  let frameCount = 0;
  const history = [];

  const BATCH_FRAMES = 5;
  let pendingULaw = [];

  const systemPrompt =
    process.env.AGENT_PROMPT ||
    "You are a premium phone assistant. Be concise, friendly, and proactive.";

  async function handleUserText(text, callSid) {
    console.log("[final ]", text);
    maybeFireMake(text, callSid).catch(() => {});
    const reply = await brainReply({ systemPrompt, history, userText: text });
    history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    await speakEleven(ws, streamSid, reply);
  }

  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      const callSid = evt.start?.callSid || null;
      console.log("WS CONNECTED | streamSid:", streamSid);

      if (process.env.DEEPGRAM_API_KEY) {
        dg = startDeepgramLinear16({
          onOpen: () => console.log("[Deepgram] opened (ready for audio)"),
          onPartial: (t) => { if (!dgOpened) { console.log("[deepgram] receiving transcripts"); dgOpened = true; } console.log("[partial]", t); },
          onFinal:   (t) => { if (!dgOpened) { console.log("[deepgram] receiving transcripts"); dgOpened = true; } handleUserText(t, callSid); },
          onError:   (e) => console.error("[Deepgram] error cb:", e?.message || e),
          onAnyMessage: (ev) => { if (ev.type && ev.type !== "Results") console.log("[Deepgram] msg:", JSON.stringify(ev)); }
        });
      } else {
        console.log("(!) No DEEPGRAM_API_KEY — ASR disabled.");
      }

      await speakEleven(ws, streamSid, "Hi there. How can I help you?");
    }

    else if (evt.event === "media") {
      frameCount++;
      const b64 = evt.media?.payload || "";
      if (!b64) return;

      const ulaw = Buffer.from(b64, "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= BATCH_FRAMES && dg) {
        const ulawChunk = Buffer.concat(pendingULaw);
        const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
        dg.sendPCM16LE(pcm16le);
        pendingULaw = [];
      }
    }

    else if (evt.event === "stop") {
      console.log("Twilio stream STOP");
      if (pendingULaw.length && dg) {
        const ulawChunk = Buffer.concat(pendingULaw);
        const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
        dg.sendPCM16LE(pcm16le);
        pendingULaw = [];
      }
      if (dg) dg.close();
    }
  });

  ws.on("close", () => { if (dg) dg.close(); console.log("WS closed"); });
  ws.on("error", (e) => console.error("WS error", e?.message || e));
});

server.listen(PORT, () => console.log(`Server running on 0.0.0.0:${PORT}`));
