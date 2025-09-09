/**
 * server.js — Old Line Barbershop voice agent (WORKING PIPE)
 * - Twilio Media Streams WS
 * - Deepgram ASR (URL-config WS; μ-law → PCM16LE @ 8kHz mono)
 * - OpenAI for extraction + NLG (JSON contract)
 * - ElevenLabs TTS (ulaw_8000 streaming) — includes streamSid on frames
 * - Make.com webhooks for FAQ log + CREATE booking
 *
 * Env:
 *  PORT (Render)
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVENLABS_API_KEY
 *  MAKE_CREATE_URL
 *  MAKE_FAQ_URL
 *  AGENT_PROMPT (optional; otherwise uses default below)
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const https = require('https');

// ---------- Config / Globals ----------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL || 'https://hook.us2.make.com/7hd4nxdrgytwukxw57cwyykhotv6hxrm';
const MAKE_FAQ_URL = process.env.MAKE_FAQ_URL || 'https://hook.us2.make.com/6hmur673mpqw4xgy2bhzx4be4o32ziax';

// HTTP keep-alive agents to shave latency
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

// Minimal logger
const log = (...args) => console.log(new Date().toISOString(), '-', ...args);

// Quick env sanity
if (!OPENAI_API_KEY) log('(!) OPENAI_API_KEY missing');
if (!DEEPGRAM_API_KEY) log('(!) DEEPGRAM_API_KEY missing');
if (!ELEVENLABS_API_KEY) log('(!) ELEVENLABS_API_KEY missing');

// ---------- Express HTTP (health) ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------- WS Server (Twilio Media Streams) ----------
const wss = new WebSocket.Server({ server });

// ---------- Agent Prompt ----------
const DEFAULT_AGENT_PROMPT = `
You are a friendly, human-sounding AI receptionist for Old Line Barbershop.
Your job is to answer the phone, sound natural, and help customers with the same tasks a real receptionist would handle.

Core Responsibilities
- Greet callers warmly and always say the business name right away.
- Answer common questions clearly and directly (hours, pricing, services, location, etc.).
- Handle scheduling: booking, rescheduling, and cancellations.

Booking Order (strict):
1) Ask what service they want (haircut, beard trim, or combo = haircut + beard trim).
2) Ask for the preferred date and time.
3) Confirm availability.
4) After confirming availability, ask for name and phone number (prefer the caller’s number if provided; confirm with them).
5) Finalize the booking.

Always confirm appointment details before finalizing (service, date, time, customer name, and phone number).

Hours rule: Only book during business hours: Monday–Friday, 9 AM–5 PM (closed weekends).
Never double-book. If a requested time is unavailable, politely suggest the nearest open slot.

Conversation Style
- Speak in short, natural sentences; one short sentence at a time (< ~22 words).
- Use contractions and micro acknowledgements.
- Ask only one question at a time.
- Avoid repeating the same wording; vary phrasing.
- If answering FAQs, give the fact, then optionally ask if they’d like to book.
- Do not start booking unless they explicitly ask to book/reschedule/cancel.
- If you don’t know, say you’ll transfer them and politely end.
- Listen; don’t re-ask details already provided.
- Keep caller informed: (“Let me check…”, “That time is available…”, “Your appointment is confirmed.”)
- When saying goodbye, hang up immediately.

**Services vocabulary:** Treat “both”, “combo”, “haircut and beard trim”, “haircut + beard” as the combo service.
**If caller says “both/combo” and wants to book, keep the chosen service and move on to ask for date/time without re-asking service.**

System Controls
- If forbidGreet=true, don’t greet again.
- If suggestedPhone is set and phone not yet collected, confirm using that number.
- Keep replies conversational and natural. Never output JSON to the caller.
`.trim();

const AGENT_PROMPT = (process.env.AGENT_PROMPT || DEFAULT_AGENT_PROMPT);

// ---------- State ----------
/** convoMap key = ws.id */
const convoMap = new Map();

function newConvo(callSid, biz) {
  return {
    id: randomUUID(),
    callSid,
    biz,
    turns: 0,
    lastTTS: '',
    lastTTSAt: 0,
    forbidGreet: false,
    phase: 'idle',
    callerPhone: '',
    asrText: '',
    // slots
    slots: {
      service: '',
      startISO: '',
      endISO: '',
      name: '',
      phone: '',
      email: ''
    }
  };
}

// ---------- μ-law → PCM16LE (8k mono) ----------
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

// ---------- Deepgram realtime (URL-config) ----------
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  const url =
    'wss://api.deepgram.com/v1/listen'
    + '?encoding=linear16'
    + '&sample_rate=8000'
    + '&channels=1'
    + '&model=nova-2-phonecall'
    + '&interim_results=true'
    + '&smart_format=true'
    + '&language=en-US'
    + '&endpointing=250';

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });

  let open = false;
  const q = [];

  dg.on('open', () => {
    open = true;
    onOpen?.();
    while (q.length) dg.send(q.shift());
  });

  dg.on('message', (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    onAnyMessage?.(ev);
    if (ev.type !== 'Results') return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || '').trim();
    if (!text) return;
    const isFinal = ev.is_final === true || ev.speech_final === true;
    if (isFinal) onFinal?.(text);
    else onPartial?.(text);
  });

  dg.on('error', (e) => onError?.(e));
  dg.on('close', (c, r) => log('[Deepgram] closed', c, (r||'').toString?.() || ''));

  return {
    sendPCM16LE(buf) { if (open) dg.send(buf); else q.push(buf); },
    close() { try { dg.close(); } catch {} }
  };
}

// ---------- Utilities ----------
function normalizeService(text) {
  if (!text) return '';
  const t = text.toLowerCase();
  if (/\b(both|combo|combo package|haircut\s*(?:&|and|\+)\s*beard|haircut\s*\+\s*beard)\b/.test(t)) return 'combo';
  if (/\bbeard( trim|)\b/.test(t)) return 'beard trim';
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return 'haircut';
  return '';
}
function computeEndISO(startISO) {
  try {
    if (!startISO) return '';
    const d = new Date(startISO);
    if (isNaN(d.getTime())) return '';
    const end = new Date(d.getTime() + 30 * 60 * 1000);
    return end.toISOString();
  } catch { return ''; }
}
function isReadyToCreate(slots) {
  return Boolean(
    slots.service &&
    slots.startISO &&
    (slots.endISO || computeEndISO(slots.startISO)) &&
    slots.name &&
    (slots.phone || '').trim()
  );
}
function safeJSON(val, fallback = {}) {
  try { return JSON.parse(val); } catch { return fallback; }
}
function debounceRepeat(convo, text, ms = 2500) {
  const now = Date.now();
  if (!text) return false;
  if (text === convo.lastTTS && (now - convo.lastTTSAt) < ms) return true;
  convo.lastTTS = text;
  convo.lastTTSAt = now;
  return false;
}

// ---------- OpenAI (extract) ----------
async function openAIExtract(utterance, convo) {
  const sys = [
    `Return a strict JSON object with fields:
{
  "intent": "FAQ" | "CREATE" | "READ" | "CANCEL" | "RESCHEDULE" | "SMALLTALK" | "UNKNOWN",
  "faq_topic": "HOURS" | "PRICES" | "SERVICES" | "LOCATION" | "" ,
  "Event_Name": "",
  "Start_Time": "",
  "End_Time": "",
  "Customer_Name": "",
  "Customer_Phone": "",
  "Customer_Email": "",
  "window": { "start": "", "end": "" },
  "ask": "NONE" | "SERVICE" | "TIME" | "NAME" | "PHONE" | "CONFIRM",
  "reply": ""
}

Rules:
- If caller asks about prices/hours/services/location, set intent="FAQ" and faq_topic accordingly. Provide a short reply.
- If caller asks to book, set intent="CREATE". Do not set "ask" to NAME/PHONE until availability is confirmed.
- Recognize “both/combo/haircut + beard” as service = "combo".
- If user gives a specific day/time, fill Start_Time (ISO if obvious; else leave empty).
- Keep reply short; conversational; single sentence; <= ~22 words; one question max.
- If forbidGreet=true, do not greet in reply.
- If suggestedPhone present and phone not yet collected, propose confirming that number with a short yes/no question.
`,
    `Context:
phase=${convo.phase}
forbidGreet=${convo.forbidGreet}
service=${convo.slots.service}
startISO=${convo.slots.startISO}
endISO=${convo.slots.endISO}
name=${convo.slots.name}
phone=${convo.slots.phone}
callerPhone=${convo.callerPhone}
`,
    `AGENT PROMPT:
${AGENT_PROMPT}`
  ].join('\n\n');

  const user = `Caller: ${utterance}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_object' }
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`OpenAI extract error ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  const parsed = safeJSON(raw, {
    intent: 'UNKNOWN',
    faq_topic: '',
    ask: 'NONE',
    reply: ''
  });
  return parsed;
}

function ensureReplyOrAsk(parsed, utterance, phase) {
  const svcU = normalizeService(utterance);
  if (svcU && !parsed.service && !parsed.Event_Name) {
    parsed.service = svcU;
    parsed.Event_Name = svcU;
  }
  if (parsed.reply && parsed.reply.trim()) return parsed;

  if ((parsed.intent === 'CREATE' || phase === 'collect_time')) {
    const svc = parsed.service || normalizeService(parsed.Event_Name) || svcU;
    if (svc && phase !== 'confirm_booking') {
      parsed.reply = `Got it—${svc}. What date and time work for you?`;
      parsed.ask = 'TIME';
      return parsed;
    }
  }
  if (parsed.intent === 'FAQ' && parsed.faq_topic) {
    parsed.reply = 'We’re set; anything else I can answer?';
    parsed.ask = 'NONE';
    return parsed;
  }
  parsed.reply = 'Got it. How can I help further?';
  parsed.ask = 'NONE';
  return parsed;
}

// ---------- NLG ----------
async function openAINLG(convo, promptHints = '') {
  const sys = `
You are a warm front-desk receptionist.
Write ONE short, conversational sentence next.
Use contractions and micro-acks. Ask only ONE question next (if any).
No greetings if forbidGreet=true. Avoid repeating the same wording.
Keep < 22 words. Keep it natural and specific to the current state.
`.trim();

  const ctx = `
State:
phase=${convo.phase}
forbidGreet=${convo.forbidGreet}
service=${convo.slots.service}
startISO=${convo.slots.startISO}
endISO=${convo.slots.endISO}
name=${convo.slots.name}
phone=${convo.slots.phone}
callerPhone=${convo.callerPhone}
AGENT PROMPT:
${AGENT_PROMPT}
`.trim();

  const user = `
Compose the next thing to say to the caller.
${promptHints ? 'Hint: ' + promptHints : ''}
`.trim();

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: sys },
        { role: 'system', content: ctx },
        { role: 'user', content: user }
      ]
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`OpenAI nlg error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  return text || 'Okay.';
}

// ---------- TTS (ElevenLabs) -> Twilio WS media frames ----------
async function ttsToTwilio(ws, text, voiceId = 'pNInz6obpgDQGcFmaJgB') {
  if (!text) return;

  const convo = ws.__convo;
  if (debounceRepeat(convo, text)) {
    log('[debounce] suppress repeat:', text);
    return;
  }

  const streamSid = ws.__streamSid;
  if (!streamSid) {
    log('[TTS] missing streamSid; cannot send audio');
    return;
  }
  if (!ELEVENLABS_API_KEY) {
    log('[TTS] ELEVENLABS_API_KEY missing; skipping audio');
    return;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  const resp = await fetch(url, {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Accept': 'audio/wav',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      generation_config: { chunk_length_schedule: [120, 160, 200, 240] }
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    log('[TTS] HTTP error', resp.status, t);
    return;
  }

  const reader = resp.body.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    const b64 = Buffer.from(value).toString('base64');
    safeSend(ws, JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
  }

  safeSend(ws, JSON.stringify({ event: 'mark', streamSid, mark: { name: 'eos' } }));
  log('[TTS] end bytes:', total);
}

// ---------- ASR final hook ----------
function handleASRFinal(ws, text) {
  const convo = ws.__convo;
  if (!convo) return;
  convo.asrText = text;
  onUserUtterance(ws, text).catch(err => log('[onUserUtterance] error', err.message));
}

// ---------- Twilio helpers ----------
function safeSend(ws, data) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch {}
}
function twilioSay(ws, text) { return ttsToTwilio(ws, text); }

// ---------- Flow Orchestration ----------
async function onUserUtterance(ws, utterance) {
  const convo = ws.__convo;
  if (!convo) return;

  let parsed = {};
  try {
    parsed = await openAIExtract(utterance, convo);
  } catch (e) {
    log('[OpenAI extract] error', e.message);
    parsed = { intent: 'UNKNOWN', ask: 'NONE', reply: '' };
  }

  parsed = ensureReplyOrAsk(parsed, utterance, convo.phase);

  // Merge slots
  if (parsed.service || parsed.Event_Name) {
    const svc = parsed.service || normalizeService(parsed.Event_Name);
    if (svc) convo.slots.service = svc;
  }
  if (parsed.Start_Time) convo.slots.startISO = parsed.Start_Time;
  if (!convo.slots.endISO && parsed.End_Time) convo.slots.endISO = parsed.End_Time;
  if (!convo.slots.endISO && convo.slots.startISO) {
    convo.slots.endISO = computeEndISO(convo.slots.startISO);
  }
  if (parsed.Customer_Name) convo.slots.name = parsed.Customer_Name;
  if (parsed.Customer_Phone) convo.slots.phone = parsed.Customer_Phone;
  if (parsed.Customer_Email) convo.slots.email = parsed.Customer_Email;

  // Phase
  const ask = parsed.ask || 'NONE';
  if (parsed.intent === 'FAQ') {
    convo.phase = 'faq';
  } else if (parsed.intent === 'CREATE') {
    if (!convo.slots.service) convo.phase = 'collect_service';
    else if (!convo.slots.startISO) convo.phase = 'collect_time';
    else if (!convo.slots.name || !(convo.slots.phone || convo.callerPhone)) convo.phase = 'collect_contact';
    else convo.phase = 'confirm_booking';
  }

  // Log FAQ to Make (non-blocking)
  if (parsed.intent === 'FAQ') postToMakeFAQ(parsed.faq_topic).catch(() => {});

  // Create if ready
  if (convo.phase === 'confirm_booking' && isReadyToCreate(convo.slots)) {
    await finalizeCreate(ws, convo);
    return;
  }

  // Speak
  let line = (parsed.reply || '').trim();
  if (!convo.slots.phone && convo.callerPhone && (ask === 'PHONE' || convo.phase === 'collect_contact')) {
    line = await openAINLG({ ...convo, forbidGreet: true }, `Confirm this phone number is okay to use: ${convo.callerPhone}`);
  } else if (!line) {
    line = await openAINLG({ ...convo, forbidGreet: true });
  }

  convo.turns += 1;
  convo.forbidGreet = true;
  await twilioSay(ws, line);
}

async function finalizeCreate(ws, convo) {
  if (!convo.slots.endISO && convo.slots.startISO) {
    convo.slots.endISO = computeEndISO(convo.slots.startISO);
  }
  if (!convo.slots.phone && convo.callerPhone) {
    convo.slots.phone = convo.callerPhone;
  }

  const payload = {
    Event_Name: convo.slots.service || 'Appointment',
    Start_Time: convo.slots.startISO || '',
    End_Time: convo.slots.endISO || computeEndISO(convo.slots.startISO || ''),
    Customer_Name: convo.slots.name || '',
    Customer_Phone: convo.slots.phone || '',
    Customer_Email: convo.slots.email || '',
    Notes: `Booked by phone agent. CallSid=${convo.callSid || ''}`
  };

  try {
    const r = await fetch(MAKE_CREATE_URL, {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) log('[Make CREATE] non-200', r.status, await r.text().catch(() => ''));
    else log('[Make CREATE] ok');
  } catch (e) {
    log('[Make CREATE] error', e.message);
  }

  const confirmLine = await openAINLG(
    { ...convo, forbidGreet: true, phase: 'done' },
    `Confirm booking with details and say goodbye. Service=${convo.slots.service}, start=${convo.slots.startISO}`
  );
  await twilioSay(ws, confirmLine);
}

async function postToMakeFAQ(topic) {
  try {
    await fetch(MAKE_FAQ_URL, {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'FAQ', topic: topic || '' })
    });
  } catch {}
}

// ---------- WS Handlers ----------
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const biz = params.get('biz') || 'acme-001';
  const id = randomUUID();
  ws.__id = id;

  // Deepgram pipe state
  let dg = null;
  let dgOpened = false;
  let frameCount = 0;
  const BATCH_FRAMES = 5;     // 5 * 20ms = ~100ms batches
  let pendingULaw = [];

  ws.on('error', (err) => log('WS error', err.message));
  ws.on('close', () => {
    try { dg?.close(); } catch {}
    convoMap.delete(ws.__id);
    log('WS closed');
  });

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const evt = msg.event;

    if (evt === 'start') {
      const callSid = msg?.start?.callSid || '';
      const from = msg?.start?.customParameters?.from || msg?.start?.from || '';
      const streamSid = msg?.start?.streamSid || '';
      const convo = newConvo(callSid, biz);
      ws.__convo = convo;
      ws.__streamSid = streamSid;
      convo.callerPhone = from || '';
      convoMap.set(ws.__id, convo);
      log('WS CONNECTED |', id, '| CallSid:', callSid, '| streamSid:', streamSid, '| biz:', biz);

      // Start Deepgram if key present
      if (DEEPGRAM_API_KEY) {
        dg = startDeepgramLinear16({
          onOpen: () => log('[Deepgram] opened'),
          onPartial: (t) => { if (!dgOpened) { dgOpened = true; log('[Deepgram] receiving transcripts'); } },
          onFinal:   (t) => { if (!dgOpened) { dgOpened = true; log('[Deepgram] receiving transcripts'); } handleASRFinal(ws, t); },
          onError:   (e) => log('[Deepgram] error', e?.message || e),
          onAnyMessage: (ev) => { if (ev.type && ev.type !== 'Results') log('[Deepgram] msg:', ev.type); }
        });
        setTimeout(() => {
          if (!dgOpened) log('(!) Deepgram connected but no transcripts yet');
        }, 5000);
      } else {
        log('(!) No DEEPGRAM_API_KEY — ASR disabled');
      }

      // Greeting
      ws.__convo.turns = 0;
      ws.__convo.forbidGreet = false;
      twilioSay(ws, 'Hi, thanks for calling Old Line Barbershop. How can I help you today?').catch(() => {});
      return;
    }

    if (evt === 'media') {
      frameCount++;
      const b64 = msg.media?.payload || '';
      if (!b64) return;

      // Collect μ-law frames and batch to ~100ms
      if (dg) {
        const ulaw = Buffer.from(b64, 'base64');
        pendingULaw.push(ulaw);
        if (pendingULaw.length >= BATCH_FRAMES) {
          const ulawChunk = Buffer.concat(pendingULaw);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          try { dg.sendPCM16LE(pcm16le); } catch (e) { log('[media→DG] send error:', e?.message || e); }
          pendingULaw = [];
        }
      }
      return;
    }

    if (evt === 'mark') return;

    if (evt === 'stop') {
      log('Twilio stream STOP');
      // flush any remaining audio to DG
      if (pendingULaw.length && dg) {
        try {
          const ulawChunk = Buffer.concat(pendingULaw);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          dg.sendPCM16LE(pcm16le);
        } catch {}
        pendingULaw = [];
      }
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    // Optional synthetic "asr" event passthrough (if your infra pipes DG back)
    if (evt === 'asr') {
      const final = msg?.text || '';
      if (final) handleASRFinal(ws, final);
      return;
    }
  });
});

// ---------- Start server ----------
server.listen(PORT, () => {
  log('Server running on', PORT);
});
