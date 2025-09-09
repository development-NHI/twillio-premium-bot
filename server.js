// server.js — Phone agent with Make (READ/CREATE/DELETE), email optional, slot-filling, conflict checks
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const PORT = process.env.PORT || 10000;

// ===== Your Make webhooks (set these in Render env) =====
const MAKE_CREATE = process.env.MAKE_CREATE || "https://hook.us2.make.com/XXXX-create";
const MAKE_READ   = process.env.MAKE_READ   || "https://hook.us2.make.com/XXXX-read";
const MAKE_DELETE = process.env.MAKE_DELETE || "https://hook.us2.make.com/XXXX-delete";

// ===== μ-law -> PCM16LE =====
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
  for (let i = 0; i < ulawBuf.length; i++) out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i * 2);
  return out;
}

// ===== Deepgram realtime (with send queue) =====
function startDeepgram({ onOpen, onPartial, onFinal, onError }) {
  const WebSocket = require("ws");
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) { console.log("(!) No DEEPGRAM_API_KEY — ASR disabled."); return null; }

  const url = "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16&sample_rate=8000&channels=1"
    + "&model=nova-2-phonecall&interim_results=true&smart_format=true"
    + "&language=en-US&endpointing=250";

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${key}` },
    perMessageDeflate: false,
  });

  let isOpen = false;
  const queue = [];

  dg.on("open", () => {
    isOpen = true;
    console.log("[Deepgram] ws open");
    onOpen?.();
    while (queue.length) { try { dg.send(queue.shift()); } catch (e) { console.error("[DG] flush error:", e?.message || e); break; } }
  });

  dg.on("message", (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const txt = (alt.transcript || "").trim();
    if (!txt) return;
    if (ev.is_final === true || ev.speech_final === true) onFinal?.(txt);
    else onPartial?.(txt);
  });

  dg.on("error", (e) => { console.error("[Deepgram] error:", e?.message || e); onError?.(e); });
  dg.on("close", (c, r) => { isOpen = false; console.log("[Deepgram] closed", c, r?.toString?.() || ""); });

  return {
    sendPCM16LE(buf) {
      try {
        if (isOpen && dg.readyState === WebSocket.OPEN) dg.send(buf);
        else queue.push(buf);
      } catch (e) { console.error("[DG] send error:", e?.message || e); }
    },
    close() { try { dg.close(); } catch {} }
  };
}

// ===== OpenAI helpers =====
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
    temperature: 0.5,
    max_tokens: 120
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  if (!res.ok) return `You said: "${userText}".`;
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || `You said: "${userText}".`;
}

// Extract structured booking details. Email is optional; never block on it.
async function extractBookingData(userText, memory) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { intent: "UNKNOWN" };

  const body = {
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
Return JSON ONLY describing appointment intent. Do slot-filling with any known context ("memory") if present.

Fields:
- intent: CREATE, READ, DELETE, UNKNOWN
- Event_Name: string (default "Haircut")
- Start_Time: ISO 8601 (YYYY-MM-DDTHH:mm:ss) if given
- End_Time: ISO 8601 (Start+30m if Start_Time present & End_Time missing)
- Customer_Name: string (default from memory.name or "unknown")
- Customer_Phone: string (default from memory.phone or "unknown")
- Customer_Email: string (default from memory.email or "")
- id: string (only for DELETE; default "")
- Notes: string

Rules:
- Email is OPTIONAL. Never require email to create a booking.
- If Start_Time missing, leave it empty. Same for Event_Name if unclear.
- Use memory defaults when user doesn't restate info.
- Output VALID JSON only.
`
      },
      { role: "user", content: `Known memory/context:\n${JSON.stringify(memory || {}, null, 2)}` },
      { role: "user", content: userText }
    ]
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const json = await res.json();
  try { return JSON.parse(json.choices?.[0]?.message?.content || "{}"); }
  catch { return { intent: "UNKNOWN" }; }
}

// ===== ElevenLabs TTS =====
async function speakEleven(ws, streamSid, text) {
  if (!streamSid) return;
  const key = process.env.ELEVEN_API_KEY;
  const voiceId = process.env.ELEVEN_VOICE_ID;
  if (!key || !voiceId) { console.log("(!) ELEVEN vars missing — skipping TTS"); return; }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
    });
    if (!res.ok || !res.body) {
      console.error("[TTS] HTTP", res.status, await res.text().catch(() => "(no body)"));
      return;
    }
    return new Promise((resolve) => {
      res.body.on("data", (chunk) => {
        const base64 = Buffer.from(chunk).toString("base64");
        try { ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64 } })); } catch {}
      });
      res.body.on("end", resolve);
    });
  } catch (e) { console.error("[TTS] error:", e?.message || e); }
}

// ===== Make helper =====
async function callMake(url, payload) {
  if (!url) return null;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text || null; }
  } catch (e) { console.error("[Make] call failed:", e?.message || e); return null; }
}

// ===== HTTP app: TwiML + health =====
const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/twilio", (req, res) => {
  const host = req.headers.host;
  const biz = req.query.biz ? `?biz=${encodeURIComponent(req.query.biz)}` : "";
  res.type("text/xml").send(`
<Response>
  <Start>
    <Stream url="wss://${host}/twilio${biz}" />
  </Start>
  <Say>Hi, I'm listening.</Say>
</Response>`.trim());
});

app.get("/", (_, r) => r.type("text/plain").send("OK"));

const server = http.createServer(app);

// ===== WebSocket (Twilio Media Streams) =====
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname !== "/twilio") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// ===== Per-call memory for slot-filling =====
function makeEmptyMemory() {
  return {
    name: "", phone: "", email: "", // contact remembered if provided
    lastIntent: "",                 // last intent seen
    draft: {                        // current working booking
      Event_Name: "",
      Start_Time: "",
      End_Time: "",
      Customer_Name: "",
      Customer_Phone: "",
      Customer_Email: "",
      Notes: "",
      id: ""
    }
  };
}

// ===== Main call flow =====
wss.on("connection", (ws, req) => {
  let streamSid = null;
  let dg = null;
  let frameCount = 0;
  let pendingULaw = [];
  const BATCH_FRAMES = 5; // 100ms
  const history = [];
  const systemPrompt =
    process.env.AGENT_PROMPT ||
    "You are a barbershop phone assistant. Be concise and proactive. Confirm details clearly.";

  // per-call memory for slot-filling
  const memory = makeEmptyMemory();

  async function handleUserText(text) {
    console.log("[user]", text);

    // Extract using memory context (email optional by design)
    const extracted = await extractBookingData(text, {
      name: memory.name, phone: memory.phone, email: memory.email,
      draft: memory.draft
    });
    console.log("[extracted]", extracted);

    // Merge into memory.draft (slot-fill)
    if (extracted.Customer_Name)  memory.name  = extracted.Customer_Name;
    if (extracted.Customer_Phone) memory.phone = extracted.Customer_Phone;
    if (extracted.Customer_Email) memory.email = extracted.Customer_Email;

    memory.draft.Event_Name     = extracted.Event_Name     || memory.draft.Event_Name || "Haircut";
    memory.draft.Start_Time     = extracted.Start_Time     || memory.draft.Start_Time;
    memory.draft.End_Time       = extracted.End_Time       || memory.draft.End_Time;
    memory.draft.Customer_Name  = memory.name  || "unknown";
    memory.draft.Customer_Phone = memory.phone || "unknown";
    memory.draft.Customer_Email = memory.email || ""; // optional
    memory.draft.Notes          = extracted.Notes || memory.draft.Notes || "";
    memory.draft.id             = extracted.id || memory.draft.id || "";

    const intent = (extracted.intent || "UNKNOWN").toUpperCase();
    memory.lastIntent = intent;

    // Compute End_Time default if Start_Time exists but End_Time missing
    if (memory.draft.Start_Time && !memory.draft.End_Time) {
      try {
        const start = new Date(memory.draft.Start_Time);
        const end = new Date(start.getTime() + 30 * 60000);
        memory.draft.End_Time = end.toISOString().slice(0, 19);
      } catch {}
    }

    // Helpers to ask for missing critical info
    const needStart = !memory.draft.Start_Time;
    const needService = !memory.draft.Event_Name;

    // Branching:
    if (intent === "READ" && MAKE_READ) {
      // If no window provided, ask for a date or default to “today”
      const payload = {
        intent: "READ",
        window: extracted.window || undefined, // if the user said a range
        // You can add filters here later if you want (barber/service)
      };
      const resp = await callMake(MAKE_READ, payload);
      const events = Array.isArray(resp?.events) ? resp.events : Array.isArray(resp) ? resp : [];
      if (events.length) {
        const list = events.slice(0, 3).map(e => `${e.summary || e.title || "Appointment"} at ${e.start || e.start_time}`).join(", ");
        await speakEleven(ws, streamSid, `I found ${events.length} appointments. For example: ${list}.`);
      } else {
        await speakEleven(ws, streamSid, "I didn't find any appointments for that time range.");
      }
      return;
    }

    if (intent === "DELETE" && MAKE_DELETE) {
      if (!memory.draft.id) {
        await speakEleven(ws, streamSid, "What’s the appointment ID or the exact date and time you want to cancel?");
        return;
      }
      const deleted = await callMake(MAKE_DELETE, { intent: "DELETE", id: memory.draft.id });
      if (deleted && (deleted.ok || deleted.deleted || deleted.id)) {
        await speakEleven(ws, streamSid, "Your appointment has been cancelled.");
      } else {
        await speakEleven(ws, streamSid, "I couldn't cancel that appointment. Can you confirm the ID or time?");
      }
      return;
    }

    if (intent === "CREATE" && MAKE_CREATE && MAKE_READ) {
      // Don’t require email. Only require Start_Time (End_Time will default) and have a service name.
      if (needStart) { await speakEleven(ws, streamSid, "What date and time would you like?"); return; }
      if (needService) { await speakEleven(ws, streamSid, "What service would you like? For example, a haircut or beard trim."); return; }

      // Check conflicts first
      const conflicts = await callMake(MAKE_READ, {
        intent: "READ",
        window: { start: memory.draft.Start_Time, end: memory.draft.End_Time }
      });
      const conflictList = Array.isArray(conflicts?.events) ? conflicts.events : Array.isArray(conflicts) ? conflicts : [];
      if (conflictList.length > 0) {
        await speakEleven(ws, streamSid, "Sorry, that time is already booked. Do you want a different time?");
        return;
      }

      // Build payload for Make create — omit email if blank
      const createPayload = {
        intent: "CREATE",
        Event_Name: memory.draft.Event_Name || "Haircut",
        Start_Time: memory.draft.Start_Time,
        End_Time: memory.draft.End_Time,
        Customer_Name: memory.draft.Customer_Name || "unknown",
        Customer_Phone: memory.draft.Customer_Phone || "unknown",
        Notes: memory.draft.Notes || ""
      };
      if (memory.draft.Customer_Email && memory.draft.Customer_Email.trim()) {
        createPayload.Customer_Email = memory.draft.Customer_Email.trim();
      }

      const created = await callMake(MAKE_CREATE, createPayload);
      if (created && (created.id || created.eventId || created.ok || created.created)) {
        await speakEleven(ws, streamSid, `All set. Your ${createPayload.Event_Name} is booked for ${createPayload.Start_Time}.`);
      } else {
        await speakEleven(ws, streamSid, "I couldn't finish the booking just now. Want me to try a different time?");
      }
      return;
    }

    // fallback: general assistant talk
    const reply = await brainReply({ systemPrompt, history, userText: text });
    history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    await speakEleven(ws, streamSid, reply);
  }

  ws.on("message", async (buf) => {
    let evt; try { evt = JSON.parse(buf.toString()); } catch { return; }

    if (evt.event === "start") {
      streamSid = evt.start?.streamSid;
      console.log("WS CONNECTED |", streamSid);
      dg = startDeepgram({ onOpen: () => {}, onPartial: () => {}, onFinal: (t) => handleUserText(t) });
      await speakEleven(ws, streamSid, "Hi there, how can I help?");
    } else if (evt.event === "media") {
      frameCount++;
      const b64 = evt.media?.payload || "";
      if (!b64) return;
      const ulaw = Buffer.from(b64, "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= BATCH_FRAMES && dg) {
        const ulawChunk = Buffer.concat(pendingULaw);
        const pcm16 = ulawBufferToPCM16LEBuffer(ulawChunk);
        dg.sendPCM16LE(pcm16);
        pendingULaw = [];
      }
    } else if (evt.event === "stop") {
      console.log("Twilio stream STOP");
      if (pendingULaw.length && dg) {
        try {
          const ulawChunk = Buffer.concat(pendingULaw);
          const pcm16 = ulawBufferToPCM16LEBuffer(ulawChunk);
          dg.sendPCM16LE(pcm16);
        } catch {}
        pendingULaw = [];
      }
      if (dg) dg.close();
    }
  });

  ws.on("close", () => { if (dg) dg.close(); });
  ws.on("error", (e) => console.error("WS error", e?.message || e));
});

server.listen(PORT, () => console.log("Server running on", PORT));
