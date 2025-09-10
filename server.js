/**
 * server.js — Old Line Barbershop voice agent (CONFIRM-FIRST + contact heuristics)
 * Twilio Media Streams WS + Deepgram ASR + OpenAI extract/NLG + ElevenLabs TTS + Make.com
 *
 * Env:
 *  PORT
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVENLABS_API_KEY  (or ELEVEN_API_KEY)
 *  ELEVENLABS_VOICE_ID (or ELEVEN_VOICE_ID) — optional; defaults to Adam
 *  MAKE_CREATE_URL     (or MAKE_CREATE)
 *  MAKE_FAQ_URL        (or MAKE_READ)
 *  AGENT_PROMPT        (optional)
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
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';

// accept either ELEVENLABS_* or ELEVEN_*
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVEN_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Adam

// accept either explicit *_URL or MAKE_* short names
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL || process.env.MAKE_CREATE || '';
const MAKE_FAQ_URL    = process.env.MAKE_FAQ_URL    || process.env.MAKE_READ   || '';

const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });
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

if (!OPENAI_API_KEY)   log('WARN', 'OPENAI_API_KEY missing');
if (!DEEPGRAM_API_KEY) log('WARN', 'DEEPGRAM_API_KEY missing (ASR will be disabled)');
if (!ELEVENLABS_API_KEY) log('WARN', 'ELEVENLABS_API_KEY/ELEVEN_API_KEY missing (no audio will be streamed)');
if (!MAKE_CREATE_URL)  log('WARN', 'MAKE_CREATE_URL/MAKE_CREATE missing (CREATE won’t be posted)');
if (!MAKE_FAQ_URL)     log('WARN', 'MAKE_FAQ_URL/MAKE_READ missing (FAQ logging disabled)');

// ---------------------- Express HTTP ----------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------------------- WS Server ----------------------
const wss = new WebSocket.Server({ server });

// ---------------------- Agent Prompt ----------------------
const DEFAULT_AGENT_PROMPT = `
You are a friendly, human-sounding AI receptionist for Old Line Barbershop.

Core Responsibilities
- Greet callers warmly and say the business name right away.
- Answer FAQs (hours, pricing, services, location).
- Handle scheduling: booking, rescheduling, cancellations.

Booking Order (strict):
1) Service (haircut, beard trim, or combo = haircut + beard trim).
2) Preferred date/time.
3) Confirm availability (assume a single 30-min slot).
4) After availability, ask for name and phone (confirm caller’s number if provided).
5) Read back all details and ask for a yes/no confirmation.
6) On yes, finalize the booking. On no, ask what to change.

Rules
- Only book Mon–Fri, 9am–5pm; suggest nearest slot if outside hours.
- Never double-book; if details already confirmed and booked, don’t rebook.
- Speak in short natural sentences (<~22 words). One question at a time.
- Vary phrasing; use contractions; micro-acks.
- If answering FAQs, give the fact, then optionally offer to book.
- Don’t start booking unless they ask to book/reschedule/cancel.
- If unsure, say you’ll transfer and end.
- Don’t re-ask details already provided.
- Keep caller informed (“Let me check…”, “That time is available…”, “Your appointment is confirmed.”)
- When saying goodbye, hang up immediately.

Vocabulary: Treat “both/ combo / haircut and beard / haircut + beard” as the combo service.
If caller said “combo” and wants to book, keep that and move on to date/time.

System Controls
- If forbidGreet=true, don’t greet again.
- If suggestedPhone is set and phone not yet collected, confirm that number.
- Never output JSON to the caller.
`.trim();

const AGENT_PROMPT = (process.env.AGENT_PROMPT || DEFAULT_AGENT_PROMPT);

// ---------------------- State ----------------------
function newConvo(callSid, biz) {
  return {
    id: randomUUID(),
    callSid,
    biz,
    turns: 0,
    lastTTS: '',
    lastTTSAt: 0,
    forbidGreet: false,
    phase: 'idle', // idle|faq|collect_service|collect_time|collect_contact|confirm_booking|done
    callerPhone: '',
    asrText: '',
    awaitingAsk: 'NONE', // SERVICE|TIME|NAME|PHONE|CONFIRM|NONE
    created: false,
    createInFlight: false,
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

// ---------------------- μ-law → PCM16LE (8k mono) ----------------------
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
  if (ask === 'CONFIRM') return readbackLine(convo) + ' Is everything correct?';
  return 'How can I help further?';
}
function normalizeFutureStart(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(+dt)) return iso;
  const now = new Date();
  if (dt.getTime() < now.getTime()) {
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
function setSlot(convo, k, v) {
  if (typeof v === 'string') v = v.trim();
  if (!v) return;
  convo.slots[k] = v;
  log('INFO', '[slot set]', { k, v });
  if (k === 'service' && convo.awaitingAsk === 'SERVICE') convo.awaitingAsk = 'TIME';
  if (k === 'startISO' && convo.awaitingAsk === 'TIME')  convo.awaitingAsk = 'NAME';
  if (k === 'name' && convo.awaitingAsk === 'NAME')      convo.awaitingAsk = 'PHONE';
  if (k === 'phone' && convo.awaitingAsk === 'PHONE')    convo.awaitingAsk = 'NONE';
  ensureEndMatchesStart(convo);
}
function yesish(s) { return /\b(yes|yep|yeah|sure|correct|right|sounds good|that'?s (fine|right|correct)|confirm)\b/i.test(s); }
function noish(s) { return /\b(no|nope|nah|not (quite|correct|right)|change|wrong|different|actually)\b/i.test(s); }

function fmtTime(dtISO) {
  try {
    const d = new Date(dtISO);
    const opts = { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return d.toLocaleString('en-US', opts);
  } catch { return dtISO; }
}
function readbackLine(convo) {
  const s = convo.slots;
  const when = s.startISO ? fmtTime(s.startISO) : '';
  const phone = s.phone || convo.callerPhone || '';
  const bits = [
    s.service ? `${s.service}` : '',
    when ? `on ${when}` : '',
    s.name ? `for ${s.name}` : '',
    phone ? `at ${phone}` : ''
  ].filter(Boolean).join(', ');
  return bits ? `I have you for ${bits}.` : 'Let me confirm the details.';
}

// ---- NEW: Contact heuristics (prevents NAME/PHONE loops) ----
function maybeName(s) {
  if (!s) return '';
  const t = s.trim();

  // “This is Cameron”, “Name’s Cameron”, “I’m Cameron …”
  const m2 = t.match(/\b(?:this is|name'?s|i am|i'm)\s+([A-Za-z][A-Za-z.'\-]{1,24})(?:\s+([A-Za-z][A-Za-z.'\-]{1,24}))?/i);
  if (m2) return (m2[1] + (m2[2] ? ' ' + m2[2] : '')).trim();

  // Plain “Cameron.” or “Cameron Diaz.”
  const m3 = t.match(/^\s*([A-Za-z][A-Za-z.'\-]{1,24})(?:\s+([A-Za-z][A-Za-z.'\-]{1,24}))?\.?\s*$/);
  if (m3) return (m3[1] + (m3[2] ? ' ' + m3[2] : '')).trim();

  return '';
}
function normalizePhone(s) {
  if (!s) return '';
  const digits = String(s).replace(/[^\d]/g, '');
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    return `(${last10.slice(0,3)}) ${last10.slice(3,6)}-${last10.slice(6)}`;
  }
  return '';
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
- If caller asks about prices/hours/services/location, set intent="FAQ" and faq_topic. Provide a short reply.
- If caller asks to book, set intent="CREATE". Do not set "ask" to NAME/PHONE until availability is confirmed.
- Recognize “both/combo/haircut + beard” as service = "combo".
- If user gives a specific day/time, fill Start_Time (ISO if obvious; else leave empty).
- Keep reply short; <= ~22 words; one question max. No greetings if forbidGreet=true.
- If suggestedPhone present and phone not yet collected, propose confirming that number.`,
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
Write ONE short, conversational sentence next (<22 words).
Use contractions and micro-acks. Ask only ONE question.
No greetings if forbidGreet=true. Avoid repeating phrasing.
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

// ---------------------- ensureReplyOrAsk ----------------------
function ensureReplyOrAsk(parsed, utterance, convo) {
  const inBooking = ['collect_service','collect_time','collect_contact','confirm_booking'].includes(convo.phase);
  const canCollect = parsed.intent === 'CREATE' || inBooking;

  // Merge service from extractor, fallback to raw utterance
  const inferredService = parsed.service || normalizeService(parsed.Event_Name) || normalizeService(utterance);
  if (!convo.slots.service && inferredService) setSlot(convo, 'service', inferredService);

  const have = {
    service: convo.slots.service,
    startISO: convo.slots.startISO,
    name: convo.slots.name || parsed.Customer_Name,
    phone: convo.slots.phone || parsed.Customer_Phone || convo.callerPhone
  };
  if (have.name && !convo.slots.name) setSlot(convo, 'name', have.name);
  if (have.phone && !convo.slots.phone) setSlot(convo, 'phone', have.phone);

  // If we're ready, move to confirm
  if (canCollect && isReadyToCreate(convo.slots)) {
    convo.phase = 'confirm_booking';
    parsed.ask = 'CONFIRM';
    parsed.reply = makeQuestionForAsk('CONFIRM', convo);
    return parsed;
  }

  if (canCollect) {
    const askNeeded =
      (!have.service && 'SERVICE') ||
      (!have.startISO && 'TIME') ||
      (!convo.slots.name && 'NAME') ||
      (!convo.slots.phone && 'PHONE') ||
      'NONE';
    if (askNeeded !== 'NONE') {
      parsed.ask = askNeeded;
      parsed.reply = makeQuestionForAsk(askNeeded, convo);
      return parsed;
    }
  }

  parsed.ask = 'NONE';
  parsed.reply = parsed.reply || 'Got it. How can I help further?';
  return parsed;
}

// ---------------------- TTS -> Twilio ----------------------
async function ttsToTwilio(ws, text, voiceId = ELEVENLABS_VOICE_ID) {
  if (!text) return;

  const convo = ws.__convo;
  if (debounceRepeat(convo, text)) {
    log('DEBUG', '[debounce] suppress repeat', { text });
    return;
  }

  const streamSid = ws.__streamSid;
  if (!streamSid) { log('WARN', '[TTS] missing streamSid; cannot send audio'); return; }
  if (!ELEVENLABS_API_KEY) { log('WARN', '[TTS] ELEVENLABS_API_KEY missing; skipping audio'); return; }

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
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const b64 = Buffer.from(value).toString('base64');
      const frame = { event: 'media', streamSid, media: { payload: b64 } };
      safeSend(ws, JSON.stringify(frame));
    }
    safeSend(ws, JSON.stringify({ event: 'mark', streamSid, mark: { name: 'eos' } }));
  } catch (e) {
    log('ERROR', '[TTS fetch]', { error: e.message });
  }
}
function safeSend(ws, data) { try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch {} }
function twilioSay(ws, text) { return ttsToTwilio(ws, text); }

// ---------------------- Flow ----------------------
async function onUserUtterance(ws, utterance) {
  const convo = ws.__convo;
  if (!convo) return;
  if (convo.phase === 'done') return;

  log('INFO', '[USER]', { text: utterance });

  // If awaiting confirmation, allow quick yes/no path
  if (convo.awaitingAsk === 'CONFIRM') {
    if (yesish(utterance)) {
      await finalizeCreate(ws, convo);
      return;
    }
    if (noish(utterance)) {
      convo.phase = 'collect_service';
      convo.awaitingAsk = 'SERVICE';
      await twilioSay(ws, 'No problem. What would you like to change — the service, date/time, or your contact?');
      return;
    }
  }

  // 1) Extract semantics
  let parsed = await openAIExtract(utterance, convo);

  // 2) Merge slots
  // Service
  if (parsed.Event_Name) {
    const svc = normalizeService(parsed.Event_Name);
    if (svc) setSlot(convo, 'service', svc);
  }

  // Time
  const wantTime = (parsed.Start_Time && !convo.slots.startISO) || convo.awaitingAsk === 'TIME';
  if (wantTime) {
    const chosenStart = parsed.Start_Time || '';
    if (chosenStart) setSlot(convo, 'startISO', normalizeFutureStart(chosenStart));
    if (parsed.End_Time && !convo.slots.endISO) setSlot(convo, 'endISO', parsed.End_Time);
  }

  // Contact from extractor
  if (parsed.Customer_Name)  setSlot(convo, 'name',  parsed.Customer_Name);
  if (parsed.Customer_Phone) setSlot(convo, 'phone', parsed.Customer_Phone);
  if (parsed.Customer_Email) setSlot(convo, 'email', parsed.Customer_Email);

  ensureEndMatchesStart(convo);

  // ---- NEW: local fallbacks while asking for NAME/PHONE ----
  if (convo.awaitingAsk === 'NAME' && !convo.slots.name) {
    const n = maybeName(utterance);
    if (n) setSlot(convo, 'name', n);
  }
  if (convo.awaitingAsk === 'PHONE' && !convo.slots.phone) {
    const p = normalizePhone(utterance);
    if (p) setSlot(convo, 'phone', p);
  }
  // ---------------------------------------------------------

  // 3) Phase determination
  if (parsed.intent === 'FAQ') {
    convo.phase = 'faq';
  } else if (parsed.intent === 'CREATE' || ['collect_service','collect_time','collect_contact','confirm_booking'].includes(convo.phase)) {
    if (!convo.slots.service)          convo.phase = 'collect_service';
    else if (!convo.slots.startISO)    convo.phase = 'collect_time';
    else if (!convo.slots.name || !(convo.slots.phone || convo.callerPhone)) convo.phase = 'collect_contact';
    else                               convo.phase = 'confirm_booking';
  }

  // 4) FAQ fire-and-forget log
  if (parsed.intent === 'FAQ' && MAKE_FAQ_URL) {
    postToMakeFAQ(parsed.faq_topic).catch(() => {});
  }

  // 5) Decide what to say
  parsed = ensureReplyOrAsk(parsed, utterance, convo);

  // Track awaitingAsk
  if (parsed.ask && parsed.ask !== 'NONE') {
    convo.awaitingAsk = parsed.ask;
  }

  // 6) Speak
  const line = (parsed.reply || '').trim() || await openAINLG({ ...convo, forbidGreet: true });
  convo.turns += 1;
  convo.forbidGreet = true;
  await twilioSay(ws, line);
}

async function finalizeCreate(ws, convo) {
  if (convo.created || convo.createInFlight) {
    log('INFO', '[CREATE] already done/in-flight; skipping');
    await twilioSay(ws, 'Your appointment is confirmed. Anything else I can help with?');
    convo.awaitingAsk = 'NONE';
    return;
  }
  convo.createInFlight = true;

  if (!convo.slots.endISO && convo.slots.startISO) {
    convo.slots.endISO = computeEndISO(convo.slots.startISO);
  }
  if (!convo.slots.phone && convo.callerPhone) {
    convo.slots.phone = convo.callerPhone;
  }

  const payload = {
    Event_Name: convo.slots.service || 'Appointment',
    Start_Time: convo.slots.startISO || '',
    End_Time:   convo.slots.endISO || computeEndISO(convo.slots.startISO || ''),
    Customer_Name:  convo.slots.name || '',
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

  convo.created = true;
  convo.createInFlight = false;
  convo.phase = 'done';
  convo.awaitingAsk = 'NONE';

  const confirmLine = `All set. ${readbackLine(convo)} See you then. Anything else before I hang up?`;
  await twilioSay(ws, confirmLine);
}

// ---------------------- Make FAQ ----------------------
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
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const biz = params.get('biz') || 'acme-001';
  const id = randomUUID();
  ws.__id = id;

  ws.on('error', (err) => log('ERROR', 'WS error', { error: err.message }));
  ws.on('close', () => {
    try { ws.__dg?.close(); } catch {}
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
      const callSid  = msg?.start?.callSid || '';
      const from     = msg?.start?.customParameters?.from || msg?.start?.from || '';
      const streamSid = msg?.start?.streamSid || '';
      const convo = newConvo(callSid, biz);
      ws.__convo = convo;
      ws.__streamSid = streamSid;
      convo.callerPhone = from || '';
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

      convo.awaitingAsk = 'NONE';
      convo.turns = 0;
      convo.forbidGreet = false;
      twilioSay(ws, 'Hi, thanks for calling Old Line Barbershop. How can I help you today?').catch(() => {});
      return;
    }

    if (evt === 'media') {
      if (!ws.__frameCount) ws.__frameCount = 0;
      ws.__frameCount++;
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

    if (evt === 'mark') { log('DEBUG', '[mark]', { name: msg?.mark?.name }); return; }

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
