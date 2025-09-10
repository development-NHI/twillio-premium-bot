/**
 * server.js — Old Line Barbershop voice agent (State-Machine + Fast Captures)
 * - Twilio Media Streams WS
 * - Deepgram ASR (URL-config WS; μ-law → PCM16LE @ 8kHz mono)
 * - OpenAI for FAQ intent + NLG (JSON contract)
 * - ElevenLabs TTS (ulaw_8000 streaming) — includes streamSid on frames
 * - Make.com webhooks for FAQ log + CREATE booking
 *
 * Env (match Render):
 *  PORT
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVEN_API_KEY
 *  ELEVEN_VOICE_ID             (optional; default provided)
 *  MAKE_CREATE                 (Make create hook)
 *  MAKE_READ                   (Make FAQ log hook)
 *  AGENT_PROMPT                (optional)
 *  TZ_NAME                     (e.g., "America/New_York"; default Eastern)
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
const ELEVENLABS_API_KEY = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
const MAKE_CREATE_URL = process.env.MAKE_CREATE || 'https://hook.us2.make.com/7hd4nxdrgytwukxw57cwyykhotv6hxrm';
const MAKE_FAQ_URL = process.env.MAKE_READ || 'https://hook.us2.make.com/6hmur673mpqw4xgy2bhzx4be4o32ziax';
const TZ_NAME = process.env.TZ_NAME || 'America/New_York'; // used only for “next weekday” math

const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });
const log = (...args) => console.log(new Date().toISOString(), '-', ...args);

if (!OPENAI_API_KEY) log('(!) OPENAI_API_KEY missing');
if (!DEEPGRAM_API_KEY) log('(!) DEEPGRAM_API_KEY missing');
if (!ELEVENLABS_API_KEY) log('(!) ELEVEN_API_KEY missing');

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------- WS ----------
const wss = new WebSocket.Server({ server });

// ---------- Agent Prompt ----------
const DEFAULT_AGENT_PROMPT = `
You are a friendly, human-sounding AI receptionist for Old Line Barbershop.

Booking Order (strict):
1) Service (haircut, beard trim, or combo).
2) Preferred date & time.
3) Confirm availability.
4) Then ask for name & phone (confirm caller’s if present).
5) Finalize and confirm details clearly.

Style:
- Short, natural sentences (< ~22 words).
- Contractions, micro-acks.
- One question at a time.
- No repeats; don’t re-ask details already provided.
- After confirming, say goodbye and hang up.
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
    lastAsk: 'NONE', // 'SERVICE' | 'TIME' | 'NAME' | 'PHONE' | 'CONFIRM' | 'NONE'
    callerPhone: '',
    asrText: '',
    metrics: { ulawBytes: 0, pcmBytes: 0, batchesTx: 0 },
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
let MU_LAW_LUT = null;
function buildMuLawLUT() {
  const lut = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = (((mantissa << 3) + 0x84) << (exponent + 2)) - 0x84 * 4;
    if (sign) sample = -sample;
    if (sample > 32767) sample = 32767;
    else if (sample < -32768) sample = -32768;
    lut[i] = sample;
  }
  return lut;
}
function ulawBufferToPCM16LEBuffer(ulawBuf) {
  if (!MU_LAW_LUT) MU_LAW_LUT = buildMuLawLUT();
  const out = Buffer.allocUnsafe(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    out.writeInt16LE(MU_LAW_LUT[ulawBuf[i]], i * 2);
  }
  return out;
}

// ---------- Deepgram realtime ----------
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
  dg.on('close', (c, r) => log('[Deepgram] closed', c, (r || '').toString?.() || ''));

  return {
    sendPCM16LE(buf) { if (open) dg.send(buf); else q.push(buf); },
    close() { try { dg.close(); } catch {} }
  };
}

// ---------- Utils: capture + time parsing ----------
function normalizeService(text) {
  if (!text) return '';
  const t = text.toLowerCase();
  if (/\b(both|combo|combo package|haircut\s*(?:&|and|\+)\s*beard|haircut\s*\+\s*beard)\b/.test(t)) return 'combo';
  if (/\bbeard( trim|)\b/.test(t)) return 'beard trim';
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return 'haircut';
  return '';
}

// very small helper for American-style “Friday at 1 PM”, “tomorrow 3”, “1:30 pm Friday”
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
function nextWeekdayIndex(fromIdx, targetIdx) {
  let diff = targetIdx - fromIdx;
  if (diff <= 0) diff += 7;
  return diff;
}
function parseDayTimeToISO(utterance) {
  if (!utterance) return '';
  const txt = utterance.toLowerCase().trim();

  // quick “tomorrow” or “today” checks
  const now = new Date();
  let base = new Date(now);
  if (/\btomorrow\b/.test(txt)) base = new Date(now.getTime() + 24*60*60*1000);

  // weekday detection
  let target = new Date(base);
  const wd = WEEKDAYS.findIndex(d => txt.includes(d));
  if (wd >= 0) {
    const fromIdx = base.getDay();
    const addDays = nextWeekdayIndex(fromIdx, wd);
    target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays);
  }

  // time: “1 pm”, “1:30 pm”, “13:00”, “1pm”
  const m = txt.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return '';
  let hh = parseInt(m[1], 10);
  let mm = parseInt(m[2] || '0', 10);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
    target.setHours(hh, mm, 0, 0);
    return target.toISOString();
  }
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

function debounceRepeat(convo, text, ms = 2000) {
  const now = Date.now();
  if (!text) return false;
  if (text === convo.lastTTS && (now - convo.lastTTSAt) < ms) return true;
  convo.lastTTS = text;
  convo.lastTTSAt = now;
  return false;
}

// Small captures
function captureNameMaybe(utterance) {
  // if user says just “Nate” or “It’s Nate”
  if (!utterance) return '';
  const t = utterance.trim();
  if (/^\s*(it'?s|this is)\s+([A-Za-z][A-Za-z\-']{1,30})\s*$/i.test(t)) {
    return t.replace(/^\s*(it'?s|this is)\s+/i, '').trim();
  }
  if (/^[A-Za-z][A-Za-z\-']{1,30}\s*$/.test(t)) return t.trim();
  return '';
}
function capturePhoneMaybe(utterance) {
  if (!utterance) return '';
  const digits = utterance.replace(/[^\d]/g, '');
  // accept 10 or 11 (leading 1)
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return '';
}

// ---------- OpenAI (for FAQ intent + natural lines) ----------
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
- Classify FAQ only if caller ASKED about hours/prices/services/location.
- If caller asks to book, set intent="CREATE". Don’t ask for NAME/PHONE until after time is set.
- Keep reply short; single sentence; <= ~22 words; one question max.
- Never repeat a question that was just asked (the app controls that).
`,
    `Context:
phase=${convo.phase}
service=${convo.slots.service}
startISO=${convo.slots.startISO}
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

async function openAINLG(convo, hint = '') {
  const sys = `
You are a warm front-desk receptionist.
Write ONE short, conversational sentence next.
Use contractions and micro-acks. One question max. <22 words.
No greetings if forbidGreet=true. Avoid repeating.
`.trim();

  const ctx = `
State:
phase=${convo.phase}
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
${hint ? 'Hint: ' + hint : ''}
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
  return (data.choices?.[0]?.message?.content || 'Okay.').trim();
}

// ---------- TTS ----------
async function ttsToTwilio(ws, text, voiceId = ELEVEN_VOICE_ID) {
  if (!text) return;
  const convo = ws.__convo;
  if (debounceRepeat(convo, text)) return;

  const streamSid = ws.__streamSid;
  if (!streamSid) { log('[TTS] missing streamSid'); return; }
  if (!ELEVENLABS_API_KEY) { log('[TTS] ELEVEN_API_KEY missing; skipping'); return; }

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

  if (!resp.ok) { log('[TTS] HTTP', resp.status, await resp.text().catch(()=>'')); return; }

  const reader = resp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const b64 = Buffer.from(value).toString('base64');
    safeSend(ws, JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
  }
  safeSend(ws, JSON.stringify({ event: 'mark', streamSid, mark: { name: 'eos' } }));
}

// ---------- Orchestration ----------
function safeSend(ws, data) { try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch {} }
function twilioSay(ws, text) { log('[SAY]', text); return ttsToTwilio(ws, text); }

function decideNext(convo) {
  // Never re-ask the same thing twice consecutively
  const avoid = (q) => (convo.lastAsk === q ? 'NONE' : q);

  if (!convo.slots.service) return avoid('SERVICE');
  if (!convo.slots.startISO) return avoid('TIME');
  if (!convo.slots.name) return avoid('NAME');
  if (!convo.slots.phone && !convo.callerPhone) return avoid('PHONE');
  return 'CONFIRM';
}

async function onUserUtterance(ws, utterance) {
  const convo = ws.__convo;
  if (!convo) return;

  // 1) Deterministic captures
  // service
  if (!convo.slots.service) {
    const svc = normalizeService(utterance);
    if (svc) convo.slots.service = svc;
  }
  // time
  if (!convo.slots.startISO) {
    const iso = parseDayTimeToISO(utterance);
    if (iso) {
      convo.slots.startISO = iso;
      convo.slots.endISO = computeEndISO(iso);
    }
  }
  // name / phone (only if we’re in contact phase or just asked for it)
  if (!convo.slots.name && (convo.lastAsk === 'NAME' || convo.phase === 'collect_contact')) {
    const n = captureNameMaybe(utterance);
    if (n) convo.slots.name = n;
  }
  if (!convo.slots.phone && (convo.lastAsk === 'PHONE' || convo.phase === 'collect_contact')) {
    const p = capturePhoneMaybe(utterance);
    if (p) convo.slots.phone = p;
  }

  // 2) OpenAI for FAQ-only classification (don’t let it drive slots)
  let parsed = {};
  try {
    parsed = await openAIExtract(utterance, convo);
  } catch (e) {
    parsed = { intent: 'UNKNOWN', faq_topic: '', ask: 'NONE', reply: '' };
  }

  // Log FAQ
  if (parsed.intent === 'FAQ' && parsed.faq_topic) {
    postToMakeFAQ(parsed.faq_topic).catch(()=>{});
  }

  // 3) Phase machine
  let next = decideNext(convo);
  if (next === 'NONE') {
    // If we just asked for something, and user didn't provide it, pivot wording with NLG
    next = convo.lastAsk || 'SERVICE';
  }

  // Move phase
  if (next === 'SERVICE') convo.phase = 'collect_service';
  else if (next === 'TIME') convo.phase = 'collect_time';
  else if (next === 'NAME' || next === 'PHONE') convo.phase = 'collect_contact';
  else if (next === 'CONFIRM') convo.phase = 'confirm_booking';

  // If ready, confirm and create
  if (convo.phase === 'confirm_booking' && isReadyToCreate(convo.slots)) {
    const humanTime = new Date(convo.slots.startISO).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
    const confirmLine = await openAINLG(
      { ...convo, forbidGreet: true },
      `Confirm: ${convo.slots.service} at ${humanTime}. Name ${convo.slots.name}, phone ${convo.slots.phone || convo.callerPhone}. Then say you’ll book it now.`
    );
    await twilioSay(ws, confirmLine);
    await finalizeCreate(ws, convo);
    return;
  }

  // Otherwise craft ONE short line depending on next
  let line = '';
  if (parsed.intent === 'FAQ' && parsed.reply) {
    // Keep FAQ short and optionally nudge booking
    line = parsed.reply;
    if (convo.slots.service || /book|appointment|schedule/i.test(utterance)) {
      line += ' Want to book something?';
    }
  } else {
    if (next === 'SERVICE') {
      line = await openAINLG({ ...convo, forbidGreet: true }, 'Ask which service they want: haircut, beard trim, or combo.');
    } else if (next === 'TIME') {
      const svc = convo.slots.service || 'that';
      line = await openAINLG({ ...convo, forbidGreet: true }, `Ask for a date and time for ${svc}.`);
    } else if (next === 'NAME') {
      line = await openAINLG({ ...convo, forbidGreet: true }, 'Ask for their first name.');
    } else if (next === 'PHONE') {
      if (convo.callerPhone) {
        line = await openAINLG({ ...convo, forbidGreet: true }, `Offer to use this phone number: ${convo.callerPhone}. Ask to confirm yes/no.`);
      } else {
        line = await openAINLG({ ...convo, forbidGreet: true }, 'Ask for a phone number to confirm the booking.');
      }
    } else {
      line = await openAINLG({ ...convo, forbidGreet: true }, 'Acknowledge and ask one precise next question.');
    }
  }

  convo.turns += 1;
  convo.forbidGreet = true;
  convo.lastAsk = next;
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

  const humanTime = new Date(convo.slots.startISO).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  const done = await openAINLG(
    { ...convo, forbidGreet: true, phase: 'done' },
    `Say the ${convo.slots.service} on ${humanTime} is confirmed under ${convo.slots.name}. Thank them and say goodbye.`
  );
  await twilioSay(ws, done);
}

// ---------- Make (FAQ) ----------
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

  let dg = null;
  let dgOpened = false;
  let frameCount = 0;
  const BATCH_FRAMES = 5; // ~100ms
  let pendingULaw = [];

  ws.on('error', (err) => log('[ERR] WS error', err.message));
  ws.on('close', () => {
    try { dg?.close(); } catch {}
    convoMap.delete(ws.__id);
    log('[INFO] WS closed');
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
      convo.callerPhone = (from || '').replace(/[^\d]/g, '').replace(/^1/, '') || '';
      convoMap.set(ws.__id, convo);
      log('[INFO] WS CONNECTED | CallSid:', callSid, '| streamSid:', streamSid, '| biz:', biz);
      log('[INFO] [agent] Using AGENT_PROMPT (first 120 chars):', (AGENT_PROMPT || '').slice(0, 120), '…');

      if (DEEPGRAM_API_KEY) {
        dg = startDeepgramLinear16({
          onOpen: () => { log('[INFO] [ASR] Deepgram open'); log('[INFO] [ASR] ready'); },
          onPartial: () => { if (!dgOpened) { dgOpened = true; log('[INFO] [ASR] receiving transcripts'); } },
          onFinal:   (t) => { if (!dgOpened) { dgOpened = true; log('[INFO] [ASR] receiving transcripts'); } handleASRFinal(ws, t); },
          onError:   (e) => log('[ERR] [ASR] error', e?.message || e),
          onAnyMessage: () => {}
        });
        setTimeout(() => { if (!dgOpened) log('[WARN] Deepgram connected but no transcripts yet'); }, 4000);
      } else {
        log('[WARN] No DEEPGRAM_API_KEY — ASR disabled');
      }

      // Greeting
      const greet = 'Hi, thanks for calling Old Line Barbershop. How can I help you today?';
      ws.__convo.turns = 0;
      ws.__convo.forbidGreet = false;
      log('[SAY]', greet);
      twilioSay(ws, greet).catch(()=>{});
      return;
    }

    if (evt === 'media') {
      frameCount++;
      if (frameCount % 50 === 1) log('[DEBUG] [media] frames:', frameCount);
      const b64 = msg.media?.payload || '';
      if (!b64) return;

      if (dg) {
        const ulaw = Buffer.from(b64, 'base64');
        pendingULaw.push(ulaw);
        if (pendingULaw.length >= BATCH_FRAMES) {
          const ulawChunk = Buffer.concat(pendingULaw);
          pendingULaw = [];
          try {
            const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
            ws.__convo.metrics.pcmBytes += pcm16le.length;
            ws.__convo.metrics.ulawBytes += ulawChunk.length;
            ws.__convo.metrics.batchesTx++;
            dg.sendPCM16LE(pcm16le);
          } catch (e) {
            log('[WARN] [media→DG] μ-law decode/send failed:', e.message);
          }
        }
      }
      return;
    }

    if (evt === 'mark') return;

    if (evt === 'stop') {
      log('[INFO] Twilio stream STOP');
      if (pendingULaw.length && dg) {
        try {
          const ulawChunk = Buffer.concat(pendingULaw);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          dg.sendPCM16LE(pcm16le);
        } catch (e) {
          log('[WARN] [media→DG] final flush failed:', e.message);
        }
        pendingULaw = [];
      }
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    if (evt === 'asr') {
      const final = msg?.text || '';
      if (final) handleASRFinal(ws, final);
      return;
    }
  });
});

// ---------- ASR final hook ----------
function handleASRFinal(ws, text) {
  const convo = ws.__convo;
  if (!convo) return;
  log('[ASR final]', text);
  convo.asrText = text;
  onUserUtterance(ws, text).catch(err => log('[onUserUtterance] error', err.message));
}

// ---------- Start server ----------
server.listen(PORT, () => {
  log('Server running on', PORT);
});
