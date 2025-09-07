// server.js — Twilio Connect/Stream + Deepgram ASR (linear16 with explicit "start" config) + OpenAI + ElevenLabs
// Changes: Deepgram "start" message, model=nova-2-phonecall, always send audio (no VAD filter), 100ms batching, extra DG logs.

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;

// =============== μ-law -> PCM16 (correct) ===============
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

// =============== Deepgram realtime (explicit "start" config) ===============
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY || "";

  const url = "wss://api.deepgram.com/v1/listen"; // config via "start" message
  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${key}` },
    perMessageDeflate: false,
  });

  let open = false;
  const q = [];

  dg.on("open", () => {
    open = true;
    console.log("[Deepgram] ws open");
    // Send explicit start/config message
    const startMsg = {
      type: "start",
      encoding: "linear16",
      sample_rate: 8000,
      channels: 1,
      model: "nova-2-phonecall",
      interim_results: true,
      smart_format: true,
      language: "en-US",
      endpointing: 250,       // try quicker end-of-utterance
      diarize: false
    };
    dg.send(JSON.stringify(startMsg));
    onOpen?.();
    while (q.length) dg.send(q.shift());
  });

  dg.on("message", (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch {
      // not JSON (rare) — ignore
      return;
    }
    onAnyMessage?.(ev);

    if (ev.type !== "transcript") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || "").trim();
    if (!text) return;
    const isFinal = ev.is_final || alt?.words?.some(w => w?.is_final);
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
    sendPCM16LE(buf) {
      if (open) dg.send(buf);
      else q.push(buf);
    },
    close() { try { dg.close(); } catch {} },
  };
}

// =============== OpenAI brain (tiny) ===============
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

// =============== ElevenLabs TTS (μ-law 8k streaming) ===============
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

// =============== HTTP app (health + browser check) ===============
const app = express();
app.get("/",  (_, res) => res.type("text/plain").send("OK"));
app.get("/twilio",  (_, res) => res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio"));
app.get("/twilio/", (_, res) => res.status(426).type("text/plain").send("Upgrade Required: connect via wss://<host>/twilio/"));
const server = http.createServer(app);

// =============== WebSocket (manual upgrade) ===============
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
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

// =============== WS logic: Twilio μ-law → 100ms batch → decode → Deepgram → OpenAI → ElevenLabs ===============
wss.on("connection", (ws) => {
  let streamSid = null;
  let dg = null;
  let dgOpened = false;
  let frameCount = 0;
  const history = [];

  // batch 5 frames (≈100ms) for lower latency
  const BATCH_FRAMES = 5;
  let pendingULaw = [];

  const systemPrompt =
    "You are a premium phone assistant. Be concise, friendly, and proactive. " +
    "Ask clarifying questions before acting. If booking is mentioned, gather date/time/name and confirm next steps plainly.";

  async function handleUserText(text) {
    console.log("[final ]", text);
    const reply = await brainReply({ systemPrompt, history, userText: text });
    history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    await speakEleven(ws, streamSid, reply);
  }

  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid || null;
      const biz = evt.start?.customParameters?.biz || "default";
      console.log("WS CONNECTED | streamSid:", streamSid, "| biz:", biz);

      if (process.env.DEEPGRAM_API_KEY) {
        dg = startDeepgramLinear16({
          onOpen: () => { console.log("[Deepgram] opened (ready for audio)"); },
          onPartial: (t) => { if (!dgOpened) { console.log("[deepgram] receiving transcripts"); dgOpened = true; } console.log("[partial]", t); },
          onFinal: (t) => { if (!dgOpened) { console.log("[deepgram] receiving transcripts"); dgOpened = true; } handleUserText(t); },
          onError: (e) => { console.error("[Deepgram] error cb:", e?.message || e); },
          onAnyMessage: (ev) => {
            // Log non-transcript messages to see warnings/errors/config acks
            if (ev.type && ev.type !== "transcript") {
              console.log("[Deepgram] msg:", JSON.stringify(ev));
            }
          }
        });
        setTimeout(() => {
          if (!dgOpened) console.log("(!) Deepgram connected but no transcripts yet (explicit start sent)");
        }, 5000);
      } else {
        console.log("(!) No DEEPGRAM_API_KEY — ASR disabled (it won't hear you).");
      }

      await speakEleven(ws, streamSid, "Hi there. How can I help you?");
    }

    else if (evt.event === "media") {
      frameCount++;
      if (frameCount % 50 === 1) console.log("[media] frames so far:", frameCount);
      const b64 = evt.media?.payload || "";
      if (!b64) {
        if (frameCount % 50 === 1) console.log("[media] empty frame payload");
        return;
      }
      const ulaw = Buffer.from(b64, "base64");
      if (frameCount % 100 === 1) {
        const sample = ulaw.subarray(0, Math.min(8, ulaw.length));
        console.log("[media] first bytes:", [...sample].map(x => x.toString(16).padStart(2,"0")).join(" "));
      }

      if (dg) {
        pendingULaw.push(ulaw);
        if (pendingULaw.length >= BATCH_FRAMES) {
          const ulawChunk = Buffer.concat(pendingULaw);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          console.log(`[media→DG] send PCM16 chunk ${pcm16le.length}B (from ${ulawChunk.length}B μ-law)`);
          try { dg.sendPCM16LE(pcm16le); } catch (e) { console.error("[media] sendPCM16 error:", e?.message || e); }
          pendingULaw = [];
        }
      }
    }

    else if (evt.event === "stop") {
      console.log("Twilio stream STOP");
      if (pendingULaw.length && dg) {
        const ulawChunk = Buffer.concat(pendingULaw);
        const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
        console.log(`[media→DG] final PCM16 chunk ${pcm16le.length}B (from ${ulawChunk.length}B μ-law) | on stop`);
        try { dg.sendPCM16LE(pcm16le); } catch {}
        pendingULaw = [];
      }
      if (dg) dg.close();
    }
  });

  ws.on("close", () => { if (dg) dg.close(); console.log("WS closed"); });
  ws.on("error", (e) => console.error("WS error", e?.message || e));
});

server.listen(PORT, () => console.log(`Server running on 0.0.0.0:${PORT}`));
