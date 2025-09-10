/**
 * server.js — Old Line Barbershop voice agent (FINAL)
 * - Twilio Media Streams WS
 * - Deepgram ASR (URL-config WS; μ-law → PCM16LE @ 8kHz)
 * - OpenAI for extraction + NLG (JSON contract)
 * - ElevenLabs TTS (ulaw_8000 streaming) — includes streamSid on frames
 * - Make.com webhooks for FAQ log + CREATE booking
 *
 * Env:
 *  PORT
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVENLABS_API_KEY
 *  ELEVENLABS_VOICE_ID (optional; defaults to Adam)
 *  MAKE_CREATE_URL
 *  MAKE_FAQ_URL
 *  AGENT_PROMPT (optional)
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const https = require('https');

// ---------------------- Config / Globals ----------------------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL || '';
const MAKE_FAQ_URL = process.env.MAKE_FAQ_URL || '';

// keep-alive agents
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

// Node 22 has global fetch; bind to avoid “this” surprises
const fetchFN = (...args) => globalThis.fetch(...args);

// ---------------------- Logger ----------------------
function log(level, msg, meta = undefined) {
  if (meta && Object.keys(meta).length) {
    console.log(`${new Date().toISOString()} - [${level}] - ${msg} | ${JSON.stringify(meta)}`);
  } else {
    console.log(`${new Date().toISOString()} - [${level}] - ${msg}`);
  }
}

log('INFO', 'Startup env', {
  hasOpenAI: !!OPENAI_API_KEY,
  hasDG: !!DEEPGRAM_API_KEY,
  hasEleven: !!ELEVENLABS_API_KEY,
  hasMakeCreate: !!MAKE_CREATE_URL,
  hasMakeRead: !!MAKE_FAQ_URL,
  node: process.version,
  fetchSource: 'global'
});

if (!OPENAI_API_KEY) log('WARN', 'OPENAI_API_KEY missing');
if (!DEEPGRAM_API_KEY) log('WARN', 'DEEPGRAM_API_KEY missing (ASR will be disabled)');
if (!ELEVENLABS_API_KEY) log('WARN', 'ELEVENLABS_API_KEY missing (no audio will be streamed)');
if (!MAKE_CREATE_URL) log('WARN', 'MAKE_CREATE_URL missing (CREATE won’t be posted)');
if (!MAKE_FAQ_URL) log('WARN', 'MAKE_FAQ_URL missing (FAQ logging disabled)');

// ---------------------- Express HTTP ----------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------------------- WS Server (Twilio Media Streams) ----------------------
const wss = new WebSocket.Server({ server });

// ---------------------- Agent Prompt ----------------------
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

// ---------------------- State ----------------------
/** convoMap key = ws.__id */
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
    awaitingAsk: 'NONE', // moves: SERVICE -> TIME -> NAME -> PHONE -> NONE
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

// ---------------------- μ-law → PCM16LE (8k mono) with clamping ----------------------
function ulawByteToPcm16(u) {
  // ITU-T G.711 μ-law decode with clamp
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

// ---------------------- Deepgram realtime (URL-config) ----------------------
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  if (!DEEPGRAM_API_KEY) return null;

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
    log('INFO', '[ASR] Deepgram open');
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

  dg.on('error', (e) => { log('ERROR', '[ASR] error', { error: e?.message || String(e) }); onError?.(e); });
  dg.on('close', (c, r) => log('INFO', '[ASR] Deepgram closed', { code: c, reason: (r||'').toString?.() || '' }));

  return {
    sendPCM16LE(buf) { if (open) dg.send(buf); else q.push(buf); },
    close() { try { dg.close(); } catch {} }
  };
}

// ---------------------- Utilities ----------------------
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
  return Boolean(slots.service && slots.startISO && (slots.endISO || computeEndISO(slots.startISO)) && slots.name && (slots.phone || '').trim());
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
function makeQuestionForAsk(ask, convo) {
  if (ask === 'SERVICE') return 'What service would you like — a haircut, beard trim, or the combo?';
  if (ask === 'TIME') return `What date and time would you like for your ${convo.slots.service || 'appointment'}?`;
  if (ask === 'NAME') return 'Could I get your first name, please?';
  if (ask === 'PHONE') return 'What phone number should I use for confirmations?';
  return 'How can I help further?';
}
function normalizeFutureStart(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(+dt)) return iso;
  const now = new Date();
  if (dt.getTime() < now.getTime()) {
    // bump to a similar time in the near future (2–14 days)
    const bumped = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    bumped.setHours(dt.getHours(), dt.getMinutes(), 0, 0);
    log('WARN', '[time guardrail] bumped parsed Start_Time to future', { from: iso, to: bumped.toISOString() });
    return bumped.toISOString();
  }
  return dt.toISOString();
}
function ensureEndMatchesStart(convo) {
  if (convo.slots.startISO && !convo.slots.endISO) {
    convo.slots.endISO = computeEndISO(convo.slots.startISO);
  }
}

// Local date/time parser (fallback when LLM misses)
function parseWhen(text, now = new Date()) {
  if (!text) return { startISO: '', endISO: '' };
  const s = text.trim();

  const re1 = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?:\s+at\s+|\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
  const m1 = s.match(re1);
  if (m1) {
    let [_, mm, dd, yyyy, hh, min, ampm] = m1;
    const year = yyyy ? (yyyy.length === 2 ? 2000 + parseInt(yyyy,10) : parseInt(yyyy,10)) : now.getFullYear();
    let hour = parseInt(hh, 10);
    const minute = min ? parseInt(min, 10) : 0;
    if (ampm) {
      const a = ampm.toLowerCase();
      if (a === 'pm' && hour < 12) hour += 12;
      if (a === 'am' && hour === 12) hour = 0;
    }
    const dt = new Date(year, parseInt(mm,10)-1, parseInt(dd,10), hour, minute, 0);
    if (!isNaN(+dt)) {
      const end = new Date(dt.getTime() + 30*60*1000);
      return { startISO: dt.toISOString(), endISO: end.toISOString() };
    }
  }

  const reTime = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
  const mt = s.match(reTime);
  if (mt) {
    let [__, hh, min, ampm] = mt;
    let hour = parseInt(hh,10);
    const minute = min ? parseInt(min,10) : 0;
    const a = ampm.toLowerCase();
    if (a === 'pm' && hour < 12) hour += 12;
    if (a === 'am' && hour === 12) hour = 0;
    let dt = new Date(now);
    dt.setSeconds(0); dt.setMilliseconds(0);
    dt.setHours(hour, minute, 0, 0);
    if (dt.getTime() < now.getTime()) dt = new Date(dt.getTime() + 24*3600*1000);
    const end = new Date(dt.getTime() + 30*60*1000);
    return { startISO: dt.toISOString(), endISO: end.toISOString() };
  }

  const reDate = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/;
  const md = s.match(reDate);
  if (md) {
    let [_, mm, dd, yyyy] = md;
    const year = yyyy.length === 2 ? 2000 + parseInt(yyyy,10) : parseInt(yyyy,10);
    const dt = new Date(year, parseInt(mm,10)-1, parseInt(dd,10), 10, 0, 0);
    if (!isNaN(+dt)) {
      const end = new Date(dt.getTime() + 30*60*1000);
      return { startISO: dt.toISOString(), endISO: end.toISOString() };
    }
  }
  return { startISO: '', endISO: '' };
}

// Slot setter that advances awaitingAsk
function setSlot(convo, k, v) {
  if (typeof v === 'string') v = v.trim();
  convo.slots[k] = v;
  log('INFO', '[slot set]', { k, v });

  if (k === 'service' && convo.awaitingAsk === 'SERVICE') convo.awaitingAsk = 'TIME';
  if (k === 'startISO' && convo.awaitingAsk === 'TIME')  convo.awaitingAsk = 'NAME';
  if (k === 'name' && convo.awaitingAsk === 'NAME')      convo.awaitingAsk = 'PHONE';
  if (k === 'phone' && convo.awaitingAsk === 'PHONE')    convo.awaitingAsk = 'NONE';
  log('DEBUG', '[awaitingAsk set]', { awaitingAsk: convo.awaitingAsk });
}

// ---------------------- OpenAI (extract) ----------------------
async function openAIExtract(utterance, convo) {
  const sys = [
    `Return a strict JSON object with fields:
{"intent":"FAQ"|"CREATE"|"READ"|"CANCEL"|"RESCHEDULE"|"SMALLTALK"|"UNKNOWN",
 "faq_topic":"HOURS"|"PRICES"|"SERVICES"|"LOCATION"|"" ,
 "Event_Name":"",
 "Start_Time":"",
 "End_Time":"",
 "Customer_Name":"",
 "Customer_Phone":"",
 "Customer_Email":"",
 "window":{"start":"","end":""},
 "ask":"NONE"|"SERVICE"|"TIME"|"NAME"|"PHONE"|"CONFIRM",
 "reply":""}

Rules:
- If caller asks about prices/hours/services/location, set intent="FAQ" and faq_topic accordingly. Provide a short reply.
- If caller asks to book, set intent="CREATE". Do not set "ask" to NAME/PHONE until availability is confirmed.
- Recognize “both/combo/haircut + beard” as service = "combo".
- If user gives a specific day/time, fill Start_Time (ISO if obvious; else leave empty).
- Keep reply short; <= ~22 words; one question max. No greetings if forbidGreet=true.
- If suggestedPhone present and phone not yet collected, propose confirming that number with a short yes/no question.`,
    `Context:
phase=${convo.phase}
forbidGreet=${convo.forbidGreet}
service=${convo.slots.service}
startISO=${convo.slots.startISO}
endISO=${convo.slots.endISO}
name=${convo.slots.name}
phone=${convo.slots.phone}
callerPhone=${convo.callerPhone}`,
    `AGENT PROMPT:
${AGENT_PROMPT}`
  ].join('\n\n');

  const user = `Caller: ${utterance}`;

  try {
    log('DEBUG', '[OpenAI extract ->]', { sysFirst120: sys.slice(0,120), utterance });
    const resp = await fetchFN('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
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
      throw new Error(`${resp.status} ${txt}`);
    }
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    const parsed = safeJSON(raw, { intent: 'UNKNOWN', faq_topic: '', ask: 'NONE', reply: '' });
    log('DEBUG', '[OpenAI extract <-]', parsed);
    return parsed;
  } catch (e) {
    log('ERROR', '[extract]', { error: e.message });
    return { intent: 'UNKNOWN', faq_topic: '', ask: 'NONE', reply: '' };
  }
}

// ---------------------- NLG ----------------------
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

  try {
    const resp = await fetchFN('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
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
      const t = await resp.text().catch(() => '');
      throw new Error(`${resp.status} ${t}`);
    }
    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    return text || 'Okay.';
  } catch (e) {
    log('ERROR', '[nlg]', { error: e.message });
    return 'Okay.';
  }
}

// ---------------------- ensureReplyOrAsk (uses *merged* slots) ----------------------
function ensureReplyOrAsk(parsed, utterance, convo) {
  const inBooking = ['collect_service','collect_time','collect_contact','confirm_booking'].includes(convo.phase);
  const canCollect = parsed.intent === 'CREATE' || inBooking;

  const have = {
    service: convo.slots.service || parsed.service || normalizeService(parsed.Event_Name),
    startISO: convo.slots.startISO || parsed.Start_Time,
    name: convo.slots.name || parsed.Customer_Name,
    phone: convo.slots.phone || parsed.Customer_Phone || convo.callerPhone
  };

  if (canCollect) {
    const askNeeded =
      (!have.service && 'SERVICE') ||
      (!have.startISO && 'TIME') ||
      (!have.name && 'NAME') ||
      (!have.phone && 'PHONE') ||
      'NONE';

    if (askNeeded !== 'NONE') {
      parsed.ask = askNeeded;
      parsed.reply = makeQuestionForAsk(askNeeded, convo);
      return parsed;
    }
  }

  // If there's already a reply, keep it
  if (parsed.reply && parsed.reply.trim()) return parsed;

  // Fallback: keep moving towards booking
  if (have.service && !have.startISO) {
    parsed.ask = 'TIME';
    parsed.reply = makeQuestionForAsk('TIME', convo);
    return parsed;
  }
  parsed.ask = 'NONE';
  parsed.reply = 'Got it. How can I help further?';
  return parsed;
}

// ---------------------- TTS (ElevenLabs) -> Twilio media ----------------------
async function ttsToTwilio(ws, text, voiceId = ELEVENLABS_VOICE_ID) {
  if (!text) return;

  const convo = ws.__convo;
  if (debounceRepeat(convo, text)) {
    log('DEBUG', '[debounce] suppress repeat', { text });
    return;
  }

  const streamSid = ws.__streamSid;
  if (!streamSid) {
    log('WARN', '[TTS] missing streamSid; cannot send audio');
    return;
  }
  if (!ELEVENLABS_API_KEY) {
    log('WARN', '[TTS] ELEVENLABS_API_KEY missing; skipping audio');
    return;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  try {
    log('INFO', '[TTS ->]', { text });
    const resp = await fetchFN(url, {
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
      log('ERROR', '[TTS fetch]', { error: `${resp.status} ${t}` });
      return;
    }

    const reader = resp.body.getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      const b64 = Buffer.from(value).toString('base64');
      const frame = { event: 'media', streamSid, media: { payload: b64 } };
      safeSend(ws, JSON.stringify(frame));
    }
    safeSend(ws, JSON.stringify({ event: 'mark', streamSid, mark: { name: 'eos' } }));
    log('INFO', '[TTS end]', { bytes: total });
  } catch (e) {
    log('ERROR', '[TTS fetch]', { error: e.message });
  }
}

function safeSend(ws, data) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch {}
}

function twilioSay(ws, text) { return ttsToTwilio(ws, text); }

// ---------------------- Flow Orchestration ----------------------
async function onUserUtterance(ws, utterance) {
  const convo = ws.__convo;
  if (!convo) return;

  log('INFO', '[USER]', { text: utterance });

  // 1) Extract semantics
  let parsed = await openAIExtract(utterance, convo);

  // 2) MERGE SLOTS FIRST (from parsed AND local parse)
  // Service
  if (parsed.service || parsed.Event_Name) {
    const svc = parsed.service || normalizeService(parsed.Event_Name);
    if (svc) setSlot(convo, 'service', svc);
  }

  // Times
  const wantTime = (parsed.Start_Time && !convo.slots.startISO) || convo.awaitingAsk === 'TIME';
  if (wantTime) {
    const local = parseWhen(utterance);
    const chosenStart = parsed.Start_Time || local.startISO;
    const chosenEnd   = parsed.End_Time   || local.endISO;
    if (chosenStart) setSlot(convo, 'startISO', normalizeFutureStart(chosenStart));
    if (chosenEnd && !convo.slots.endISO) setSlot(convo, 'endISO', chosenEnd);
  }
  // Contact
  if (parsed.Customer_Name) setSlot(convo, 'name', parsed.Customer_Name);
  if (parsed.Customer_Phone) setSlot(convo, 'phone', parsed.Customer_Phone);
  if (parsed.Customer_Email) setSlot(convo, 'email', parsed.Customer_Email);
  ensureEndMatchesStart(convo);

  // 3) Phase determination (after slots merged)
  if (parsed.intent === 'FAQ') {
    convo.phase = 'faq';
  } else if (parsed.intent === 'CREATE' || ['collect_service','collect_time','collect_contact','confirm_booking'].includes(convo.phase)) {
    if (!convo.slots.service)          convo.phase = 'collect_service';
    else if (!convo.slots.startISO)    convo.phase = 'collect_time';
    else if (!convo.slots.name || !(convo.slots.phone || convo.callerPhone)) convo.phase = 'collect_contact';
    else                               convo.phase = 'confirm_booking';
  } // else leave as-is

  log('DEBUG', '[phase]', { phase: convo.phase, missing:
    (!convo.slots.service && 'service') ||
    (!convo.slots.startISO && 'startISO') ||
    (!convo.slots.name && 'name') ||
    (!(convo.slots.phone||convo.callerPhone) && 'phone') || 'none'
  });

  // 4) FAQ fire-and-forget log
  if (parsed.intent === 'FAQ' && MAKE_FAQ_URL) {
    postToMakeFAQ(parsed.faq_topic).catch(() => {});
  }

  // 5) If ready, finalize booking
  if (convo.phase === 'confirm_booking' && isReadyToCreate(convo.slots)) {
    await finalizeCreate(ws, convo);
    return;
  }

  // 6) Decide what to say (AFTER merge)
  parsed = ensureReplyOrAsk(parsed, utterance, convo);

  // Track awaitingAsk based on parsed.ask
  if (parsed.ask && parsed.ask !== 'NONE') {
    convo.awaitingAsk = parsed.ask;
    log('DEBUG', '[awaitingAsk set]', { awaitingAsk: convo.awaitingAsk });
  }

  // 7) Speak
  const line = (parsed.reply || '').trim() || await openAINLG({ ...convo, forbidGreet: true });
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

  if (MAKE_CREATE_URL) {
    try {
      const r = await fetchFN(MAKE_CREATE_URL, {
        method: 'POST',
        agent: keepAliveHttpsAgent,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) log('WARN', '[Make CREATE] non-200', { status: r.status, body: await r.text().catch(()=> '') });
      else log('INFO', '[Make CREATE] ok');
    } catch (e) {
      log('ERROR', '[Make CREATE]', { error: e.message });
    }
  } else {
    log('WARN', '[Make CREATE] skipped; MAKE_CREATE_URL missing', payload);
  }

  const confirmLine = await openAINLG(
    { ...convo, forbidGreet: true, phase: 'done' },
    `Confirm booking and say goodbye. Service=${convo.slots.service}, start=${convo.slots.startISO}, name=${convo.slots.name}`
  );
  await twilioSay(ws, confirmLine);
}

async function postToMakeFAQ(topic) {
  try {
    await fetchFN(MAKE_FAQ_URL, {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'FAQ', topic: topic || '' })
    });
  } catch (e) {
    log('ERROR', '[Make FAQ]', { error: e.message });
  }
}

// ---------------------- ASR final hook ----------------------
function handleASRFinal(ws, text) {
  const convo = ws.__convo;
  if (!convo) return;
  convo.asrText = text;
  onUserUtterance(ws, text).catch(err => log('ERROR', '[onUserUtterance]', { error: err.message }));
}

// ---------------------- WS Handlers ----------------------
wss.on('connection', (ws, req) => {
  // Twilio sends querystring; parse it
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const biz = params.get('biz') || 'acme-001';
  const id = randomUUID();
  ws.__id = id;

  ws.on('error', (err) => log('ERROR', 'WS error', { error: err.message }));
  ws.on('close', () => {
    try { ws.__dg?.close(); } catch {}
    convoMap.delete(ws.__id);
    log('INFO', 'WS closed');
  });

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch {
      log('DEBUG', '[WS event ignored]', { evt: 'non-json' }); return;
    }

    const evt = msg.event;
    if (!evt) { log('DEBUG', '[WS event ignored]', msg); return; }

    if (evt === 'connected') { log('DEBUG', '[WS event ignored]', { evt }); return; }

    if (evt === 'start') {
      const callSid = msg?.start?.callSid || '';
      const from = msg?.start?.customParameters?.from || msg?.start?.from || '';
      const streamSid = msg?.start?.streamSid || '';
      const convo = newConvo(callSid, biz);
      ws.__convo = convo;
      ws.__streamSid = streamSid;
      convo.callerPhone = from || '';
      convoMap.set(ws.__id, convo);
      log('INFO', 'WS CONNECTED', { path: req.url, callSid, streamSid, biz });
      log('INFO', '[agent prompt 120]', { text: AGENT_PROMPT.slice(0, 120) });

      // Start Deepgram
      let dgOpened = false;
      ws.__dg = startDeepgramLinear16({
        onOpen: () => {},
        onPartial: (t) => { if (!dgOpened) { dgOpened = true; } log('DEBUG', '[ASR partial]', { t }); },
        onFinal:   (t) => { log('INFO', '[ASR final]', { t }); handleASRFinal(ws, t); },
        onError:   (e) => {},
        onAnyMessage: (ev) => { if (ev.type && ev.type !== 'Results') log('DEBUG', '[ASR event]', { type: ev.type }); }
      });

      // init ask state
      convo.awaitingAsk = 'NONE';
      log('DEBUG', '[awaitingAsk set]', { awaitingAsk: convo.awaitingAsk });

      // Greeting
      convo.turns = 0;
      convo.forbidGreet = false;
      twilioSay(ws, 'Hi, thanks for calling Old Line Barbershop. How can I help you today?').catch(() => {});
      return;
    }

    if (evt === 'media') {
      // Collect μ-law frames and stream to DG in small batches
      if (!ws.__frameCount) ws.__frameCount = 0;
      ws.__frameCount++;
      log('DEBUG', '[media] frames', { frameCount: ws.__frameCount });

      const b64 = msg.media?.payload || '';
      if (!b64) return;

      if (!ws.__ulawBatch) ws.__ulawBatch = [];
      ws.__ulawBatch.push(Buffer.from(b64, 'base64'));

      const BATCH_FRAMES = 5; // ~100ms
      if (ws.__ulawBatch.length >= BATCH_FRAMES && ws.__dg) {
        try {
          const ulawChunk = Buffer.concat(ws.__ulawBatch);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          ws.__dg.sendPCM16LE(pcm16le);
        } catch (e) {
          log('ERROR', '[media→DG] send error', { error: e?.message || String(e) });
        }
        ws.__ulawBatch = [];
      }
      return;
    }

    if (evt === 'mark') {
      log('DEBUG', '[mark]', { name: msg?.mark?.name });
      return;
    }

    if (evt === 'stop') {
      log('INFO', 'Twilio stream STOP');
      if (ws.__ulawBatch?.length && ws.__dg) {
        try {
          const ulawChunk = Buffer.concat(ws.__ulawBatch);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          ws.__dg.sendPCM16LE(pcm16le);
        } catch {}
        ws.__ulawBatch = [];
      }
      try { ws.__dg?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    // Optional synthetic "asr" event passthrough
    if (evt === 'asr') {
      const final = msg?.text || '';
      if (final) handleASRFinal(ws, final);
      return;
    }

    log('DEBUG', '[WS event ignored]', msg);
  });
});

// ---------------------- Start server ----------------------
server.listen(PORT, () => {
  log('INFO', 'Server running', { PORT: String(PORT) });
});
