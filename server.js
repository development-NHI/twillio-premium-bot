// server.js — Twilio Connect/Stream + Deepgram ASR + OpenAI brain + ElevenLabs TTS
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// ====== config ======
const PORT = process.env.PORT || 10000;

// ====== audio helpers (μ-law @ 8kHz, 20ms frames) ======
const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160;

function muLawToPCM16(mu) {
  const out = new Int16Array(mu.length);
  for (let i = 0; i < mu.length; i++) {
    let u = mu[i] ^ 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    out[i] = (u & 0x80) ? (0x84 - t) << 2 : (t - 0x84) << 2;
  }
  return out;
}

// ====== Deepgram realtime (inline) ======
function startDeepgram({ onPartial, onFinal }) {
  const WebSocket = require("ws");
  const url = "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&punctuate=true&vad_turnoff=500";
  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY || ""}` },
    perMessageDeflate: false,
  });
  let open = false;
  const q = [];
  dg.on("open", () => { open = true; while (q.length) dg.send(q.shift()); });
  dg.on("message", (data) => {
    try {
      const ev = JSON.parse(data.toString());
      if (ev.type !== "transcript") return;
      const alt = ev.channel?.alternatives?.[0];
      if (!alt) return;
      const text = (alt.transcript || "").trim();
      if (!text) return;
      const isFinal = ev.is_final || alt.words?.some(w => w?.is_final);
      if (isFinal) onFinal?.(text); else onPartial?.(text);
    } catch {}
  });
  dg.on("error", (e) => console.error("[Deepgram] ws error:", e.message || e));
  dg.on("close", () => console.log("[Deepgram] ws closed"));
  return {
    sendPCM16(int16) {
      const buf = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
      if (open) dg.send(buf); else q.push(buf);
    },
    close() { try { dg.close(); } catch {} }
  };
}

// ====== OpenAI brain (tiny, fast) ======
async function brainReply({ systemPrompt, history, userText }) {
  if (!process.env.OPENAI_API_KEY) {
    // Safe fallback if no key yet
    return `You said: "${userText}". How can I help further?`;
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
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    console.error("[OpenAI] HTTP", res.status);
    return `You said: "${userText}".`;
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || `You said: "${userText}".`;
}

// ====== ElevenLabs TTS (μ-law 8k streaming) ======
async function speakEleven(ws, streamSid, text) {
  if (!streamSid) return;
  const key = process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) {
    console.log("(!) ELEVEN vars missing — skipping TTS");
    return;
  }
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  });
  if (!res.ok || !res.body) { console.error("[TTS] HTTP", res.status); return; }
  return new Promise((resolve, reject) => {
    res.body.on("data", (chunk) => {
      const base64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64 } }));
    });
    res.body.on("end", resolve);
    res.body.on("error", reject);
  });
}

// ====== HTTP app ======
const app = express();
app.get("/", (_, res) => res.type("text/plain").send("OK"));
app.get("/twilio",  (_, res) => res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio"));
app.get("/twilio/", (_, res) => res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio/"));
const server = http.createServer(app);

// ====== WebSocket (manual upgrade) ======
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname !== "/twilio" && u.pathname !== "/twilio/") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } catch { try { socket.destroy(); } catch {} }
});

// ====== WS logic: ASR in → LLM → TTS out ======
wss.on("connection", (ws) => {
  let streamSid = null;
  let dg = null;                 // Deepgram session
  const history = [];            // short chat history

  // simple system prompt (swap in your big Make prompt later)
  const systemPrompt =
    "You are a premium phone assistant. Be concise, friendly, and proactive. " +
    "Ask clarifying questions before acting. If the caller mentions booking, gather date/time/name and confirm next steps plainly.";

  async function handleUserText(text) {
    // get model reply
    const reply = await brainReply({ systemPrompt, history, userText: text });
    history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    // speak it
    await speakEleven(ws, streamSid, reply);
  }

  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      const biz = evt.start?.customParameters?.biz || "default";
      console.log("WS CONNECTED | streamSid:", streamSid, "| biz:", biz);

      // spin up Deepgram if key present
      if (process.env.DEEPGRAM_API_KEY) {
        dg = startDeepgram({
          onPartial: (t) => console.log("[partial]", t),
          onFinal:   (t) => { console.log("[final ]", t); handleUserText(t); }
        });
      } else {
        console.log("(!) No DEEPGRAM_API_KEY — ASR disabled (it won't hear you).");
      }

      // opening line (so it feels alive immediately)
      await speakEleven(ws, streamSid, "Hi there. How can I help you?");
    }
    else if (evt.event === "media") {
      // caller audio (20ms μ-law base64) → feed to Deepgram
      if (dg) {
        const ulaw = Buffer.from(evt.media?.payload || "", "base64");
        const pcm16 = muLawToPCM16(ulaw);
        dg.sendPCM16(pcm16);
      }
    }
    else if (evt.event === "stop") {
      console.log("Twilio stream STOP");
      if (dg) dg.close();
    }
  });

  ws.on("close", () => { if (dg) dg.close(); console.log("WS closed"); });
  ws.on("error", (e) => console.error("WS error", e));
});

server.listen(PORT, () => console.log(`Server running on 0.0.0.0:${PORT}`));
