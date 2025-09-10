/**
 * server.js — Old Line Barbershop voice agent
 * - Confirm-first flow
 * - Make READ availability check before booking
 * - Friendlier, less robotic prompts + micro-acks
 * - Name/phone heuristics to avoid loops
 * - Guards against double booking (single CREATE per call + re-check)
 *
 * Env (all optional fallbacks included):
 *  PORT
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVENLABS_API_KEY  or ELEVEN_API_KEY
 *  ELEVENLABS_VOICE_ID or ELEVEN_VOICE_ID   (defaults to Adam)
 *  MAKE_CREATE_URL     or MAKE_CREATE        (POST to create)
 *  MAKE_READ_URL       or MAKE_READ          (POST to read/freebusy/availability)
 *  MAKE_FAQ_URL        (optional analytics log for FAQs)
 *  AGENT_PROMPT        (optional)
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';

const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVEN_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Adam

const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL || process.env.MAKE_CREATE || '';
const MAKE_READ_URL   = process.env.MAKE_READ_URL   || process.env.MAKE_READ   || '';
const MAKE_FAQ_URL    = process.env.MAKE_FAQ_URL    || ''; // optional

const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });
const fetchFN = (...args) => globalThis.fetch(...args);

// ---------------------- Logger ----------------------
function log(level, msg, meta) {
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
  hasMakeRead: !!MAKE_READ_URL,
  node: process.version,
});

if (!OPENAI_API_KEY)     log('WARN', 'OPENAI_API_KEY missing');
if (!DEEPGRAM_API_KEY)   log('WARN', 'DEEPGRAM_API_KEY missing (ASR disabled)');
if (!ELEVENLABS_API_KEY) log('WARN', 'ELEVEN_API_KEY/ELEVENLABS_API_KEY missing (no voice)');
if (!MAKE_CREATE_URL)    log('WARN', 'MAKE_CREATE missing (CREATE won’t post)');
if (!MAKE_READ_URL)      log('WARN', 'MAKE_READ missing (no availability checks)');

// ---------------------- HTTP ----------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------------------- WS ----------------------
const wss = new WebSocket.Server({ server });

// ---------------------- Prompt ----------------------
const DEFAULT_AGENT_PROMPT = `
You’re a warm, natural-sounding receptionist for Old Line Barbershop.

Flow (strict):
1) Ask the service (haircut, beard trim, or combo).
2) Ask for a date/time.
3) Check availability via our system. Tell them plainly if it’s open or booked.
   - If open: “That time’s open — want me to book it?”
   - If booked: offer the nearest time within Mon–Fri 9–5.
4) Then collect first name and phone.
5) Read back *all* details and ask to confirm yes/no.
6) On yes: book once, then wrap up and hang up after they’re done.
   On no: ask what to change.

Style rules:
- Short, friendly sentences. One question at a time.
- Vary phrasing and use micro-acks (“Got it”, “Sure”, “No worries”).
- Don’t re-ask info you already have.
- Never speak JSON.
- Office hours: Mon–Fri, 9am–5pm; suggest the nearest slot inside hours.
- Don’t create more than one appointment per call.

Combo vocabulary: “both / combo / haircut + beard / haircut and beard” = combo.
`.trim();

const AGENT_PROMPT = process.env.AGENT_PROMPT || DEFAULT_AGENT_PROMPT;

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
    phase: 'idle', // idle|faq|collect_service|collect_time|check_availability|collect_contact|confirm_booking|done
    callerPhone: '',
    asrText: '',
    awaitingAsk: 'NONE', // SERVICE|TIME|NAME|PHONE|CONFIRM|NONE
    created: false,
    createInFlight: false,
    availability: { checked: false, available: null, suggestionISO: '' },
    slots: { service: '', startISO: '', endISO: '', name: '', phone: '', email: '' }
  };
}

// ---------------------- Audio utils ----------------------
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

// ---------------------- Deepgram ----------------------
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  if (!DEEPGRAM_API_KEY) return null;
  const url =
    'wss://api.deepgram.com/v1/listen'
    + '?encoding=linear16&sample_rate=8000&channels=1'
    + '&model=nova-2-phonecall&interim_results=true&smart_format=true&language=en-US&endpointing=250';

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });

  let open = false;
  const q = [];

  dg.on('open', () => { open = true; log('INFO', '[ASR] Deepgram open'); onOpen?.(); while (q.length) dg.send(q.shift()); });

  dg.on('message', (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    onAnyMessage?.(ev);
    if (ev.type !== 'Results') return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || '').trim();
    if (!text) return;
    const isFinal = ev.is_final === true || ev.speech_final === true;
    if (isFinal) onFinal?.(text); else onPartial?.(text);
  });

  dg.on('error', (e) => { log('ERROR', '[ASR] error', { error: e?.message || String(e) }); onError?.(e); });
  dg.on('close', (c, r) => log('INFO', '[ASR] Deepgram closed', { code: c, reason: (r||'').toString?.() || '' }));

  return {
    sendPCM16LE(buf) { if (open) dg.send(buf); else q.push(buf); },
    close() { try { dg.close(); } catch {} }
  };
}

// ---------------------- Helpers ----------------------
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
function safeJSON(v, fb = {}) { try { return JSON.parse(v); } catch { return fb; } }
function isReadyToCreate(slots) {
  return Boolean(slots.service && slots.startISO && (slots.endISO || computeEndISO(slots.startISO)) && slots.name && (slots.phone || '').trim());
}
function ensureEndMatchesStart(convo) {
  if (convo.slots.startISO && !convo.slots.endISO) {
    convo.slots.endISO = computeEndISO(convo.slots.startISO);
  }
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
function yesish(s) { return /\b(yes|yep|yeah|sure|correct|right|sounds good|that'?s (fine|right|correct)|please do|book it)\b/i.test(s); }
function noish(s)  { return /\b(no|nope|nah|not (quite|correct|right)|change|wrong|different|actually|hold off)\b/i.test(s); }
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
function setSlot(convo, k, v) {
  if (typeof v === 'string') v = v.trim();
  if (!v) return;
  convo.slots[k] = v;
  log('INFO', '[slot set]', { k, v });
  if (k === 'service' && convo.awaitingAsk === 'SERVICE') convo.awaitingAsk = 'TIME';
  if (k === 'startISO' && convo.awaitingAsk === 'TIME')  convo.awaitingAsk = 'NAME'; // we’ll check availability right after
  if (k === 'name' && convo.awaitingAsk === 'NAME')      convo.awaitingAsk = 'PHONE';
  if (k === 'phone' && convo.awaitingAsk === 'PHONE')    convo.awaitingAsk = 'NONE';
  ensureEndMatchesStart(convo);
}
function makeQuestionForAsk(ask, convo) {
  if (ask === 'SERVICE') return 'What service can I get you — haircut, beard trim, or the combo?';
  if (ask === 'TIME')    return `What day and time works for your ${convo.slots.service || 'appointment'}?`;
  if (ask === 'NAME')    return 'Great — can I grab your first name?';
  if (ask === 'PHONE')   return 'And what’s the best phone for confirmations?';
  if (ask === 'CONFIRM') return readbackLine(convo) + ' Everything look right?';
  return 'How can I help further?';
}
function debounceRepeat(convo, text, ms = 2500) {
  const now = Date.now();
  if (!text) return false;
  if (text === convo.lastTTS && (now - convo.lastTTSAt) < ms) return true;
  convo.lastTTS = text; convo.lastTTSAt = now; return false;
}
function maybeName(s) {
  if (!s) return '';
  const t = s.trim();
  const m2 = t.match(/\b(?:this is|name'?s|i am|i'm)\s+([A-Za-z][A-Za-z.'\-]{1,24})(?:\s+([A-Za-z][A-Za-z.'\-]{1,24}))?/i);
  if (m2) return (m2[1] + (m2[2] ? ' ' + m2[2] : '')).trim();
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

// ---------------------- Availability via Make READ ----------------------
async function readAvailability({ service, startISO, endISO }) {
  if (!MAKE_READ_URL) {
    log('WARN', '[Make READ] unavailable; assuming available');
    return { checked: true, available: true, suggestionISO: '' };
  }

  const payload = {
    Event_Name: service || 'Appointment',
    Start_Time: startISO || '',
    End_Time: endISO || (startISO ? computeEndISO(startISO) : ''),
  };

  try {
    const r = await fetchFN(MAKE_READ_URL, {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const txt = await r.text();
    if (!r.ok) {
      log('WARN', '[Make READ] non-200', { status: r.status, body: txt.slice(0, 500) });
      // fail-open: don’t block bookings if READ endpoint hiccups
      return { checked: true, available: true, suggestionISO: '' };
    }

    const data = safeJSON(txt, {});
    // Supported shapes:
    // 1) { available: true/false, suggestionStart: "ISO" }
    // 2) { busy: [{start:"", end:""}], window:{start:"", end:""} }
    // 3) { events:[{start:"", end:""}, ...] }
    let available = true;
    let suggestionISO = '';

    if (typeof data.available === 'boolean') {
      available = !!data.available;
      suggestionISO = data.suggestionStart || data.suggestionISO || '';
    } else if (Array.isArray(data.busy)) {
      const s = new Date(startISO).getTime();
      const e = new Date(endISO || computeEndISO(startISO)).getTime();
      const overlaps = data.busy.some(b => {
        const bs = new Date(b.start).getTime(); const be = new Date(b.end).getTime();
        return Math.max(s, bs) < Math.min(e, be);
      });
      available = !overlaps;
      suggestionISO = data.suggestionStart || '';
    } else if (Array.isArray(data.events)) {
      const s = new Date(startISO).getTime();
      const e = new Date(endISO || computeEndISO(startISO)).getTime();
      const overlaps = data.events.some(ev => {
        const bs = new Date(ev.start || ev.Start_Time).getTime(); const be = new Date(ev.end || ev.End_Time).getTime();
        return Math.max(s, bs) < Math.min(e, be);
      });
      available = !overlaps;
    }

    return { checked: true, available, suggestionISO: suggestionISO || '' };
  } catch (e) {
    log('ERROR', '[Make READ]', { error: e.message });
    return { checked: true, available: true, suggestionISO: '' }; // fail-open
  }
}

// ---------------------- OpenAI (extract + NLG) ----------------------
async function openAIExtract(utterance, convo) {
  const sys = [
    `Return JSON:
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
- If they ask about availability like “any time tomorrow?”, set intent="CREATE" and prefer asking for specific time.
- Don’t jump to NAME/PHONE until availability for a time has been checked.
- Treat “both/combo/haircut + beard” as service = "combo".
- Keep reply short, friendly, one question max. No greetings if forbidGreet=true.`,
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
        temperature: 0.3,
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
    return safeJSON(raw, { intent: 'UNKNOWN', faq_topic: '', ask: 'NONE', reply: '' });
  } catch (e) {
    log('ERROR', '[extract]', { error: e.message });
    return { intent: 'UNKNOWN', faq_topic: '', ask: 'NONE', reply: '' };
  }
}

async function openAINLG(convo, hint = '') {
  const sys = `
You're a friendly front-desk human. Write ONE short, natural sentence (<22 words).
Use contractions, micro-acks, varied phrasing. One question max. No greetings if forbidGreet=true.
`.trim();

  const ctx = `
State:
phase=${convo.phase}
forbidGreet=${convo.forbidGreet}
service=${convo.slots.service}
startISO=${convo.slots.startISO}
name=${convo.slots.name}
phone=${convo.slots.phone}
AGENT PROMPT:
${AGENT_PROMPT}
`.trim();

  const user = `Say the next line. ${hint ? 'Hint: ' + hint : ''}`;

  try {
    const resp = await fetchFN('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.5, // a touch more variety
        messages: [
          { role: 'system', content: sys },
          { role: 'system', content: ctx },
          { role: 'user', content: user }
        ]
      })
    });
    if (!resp.ok) { const t = await resp.text().catch(()=> ''); throw new Error(`${resp.status} ${t}`); }
    const data = await resp.json();
    return (data.choices?.[0]?.message?.content || 'Okay.').trim();
  } catch (e) {
    log('ERROR', '[nlg]', { error: e.message });
    return 'Okay.';
  }
}

// ---------------------- Ask/Reply decision ----------------------
function ensureReplyOrAsk(parsed, utterance, convo) {
  const inBooking = ['collect_service','collect_time','check_availability','collect_contact','confirm_booking']
    .includes(convo.phase);
  const canCollect = parsed.intent === 'CREATE' || inBooking;

  // Merge service fallback
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

  // Confirm path if fully ready
  if (canCollect && isReadyToCreate(convo.slots)) {
    convo.phase = 'confirm_booking';
    parsed.ask = 'CONFIRM';
    parsed.reply = makeQuestionForAsk('CONFIRM', convo);
    return parsed;
  }

  if (canCollect) {
    // If we have service+time but haven't checked availability, do that next
    if (have.service && have.startISO && !convo.availability.checked) {
      convo.phase = 'check_availability';
      parsed.ask = 'NONE';
      parsed.reply = 'Give me a sec while I check that time.';
      return parsed;
    }

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

// ---------------------- TTS to Twilio ----------------------
async function ttsToTwilio(ws, text, voiceId = ELEVENLABS_VOICE_ID) {
  if (!text) return;
  const convo = ws.__convo;
  if (debounceRepeat(convo, text)) { log('DEBUG', '[debounce] suppress repeat', { text }); return; }

  const streamSid = ws.__streamSid;
  if (!streamSid) { log('WARN', '[TTS] missing streamSid'); return; }
  if (!ELEVENLABS_API_KEY) { log('WARN', '[TTS] ELEVEN_API_KEY missing'); return; }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

  try {
    log('INFO', '[TTS ->]', { text });
    const resp = await fetchFN(url, {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Accept': 'audio/wav', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        generation_config: { chunk_length_schedule: [120,160,200,240] }
      })
    });

    if (!resp.ok) { const t = await resp.text().catch(()=> ''); log('ERROR', '[TTS fetch]', { error: `${resp.status} ${t}` }); return; }

    const reader = resp.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const b64 = Buffer.from(value).toString('base64');
      const frame = { event: 'media', streamSid, media: { payload: b64 } };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'eos' } }));
  } catch (e) {
    log('ERROR', '[TTS fetch]', { error: e.message });
  }
}
function twilioSay(ws, text) { return ttsToTwilio(ws, text); }

// ---------------------- Main flow ----------------------
async function onUserUtterance(ws, utterance) {
  const convo = ws.__convo;
  if (!convo || convo.phase === 'done') return;

  log('INFO', '[USER]', { text: utterance });

  // Fast yes/no on confirm
  if (convo.awaitingAsk === 'CONFIRM') {
    if (yesish(utterance)) { await finalizeCreate(ws, convo); return; }
    if (noish(utterance)) {
      convo.phase = 'collect_service';
      convo.awaitingAsk = 'SERVICE';
      await twilioSay(ws, 'No worries. What would you like to change — the service, the time, or your contact?');
      return;
    }
  }

  // 1) Extract
  let parsed = await openAIExtract(utterance, convo);

  // 2) Merge slots
  if (parsed.Event_Name) {
    const svc = normalizeService(parsed.Event_Name);
    if (svc) setSlot(convo, 'service', svc);
  }

  const needTime = (parsed.Start_Time && !convo.slots.startISO) || convo.awaitingAsk === 'TIME';
  if (needTime) {
    const chosenStart = parsed.Start_Time || '';
    if (chosenStart) setSlot(convo, 'startISO', normalizeFutureStart(chosenStart));
    if (parsed.End_Time && !convo.slots.endISO) setSlot(convo, 'endISO', parsed.End_Time);
  }

  if (parsed.Customer_Name)  setSlot(convo, 'name',  parsed.Customer_Name);
  if (parsed.Customer_Phone) setSlot(convo, 'phone', parsed.Customer_Phone);
  if (parsed.Customer_Email) setSlot(convo, 'email', parsed.Customer_Email);

  // Local fallbacks while asking for NAME/PHONE
  if (convo.awaitingAsk === 'NAME'  && !convo.slots.name)  { const n = maybeName(utterance); if (n) setSlot(convo, 'name', n); }
  if (convo.awaitingAsk === 'PHONE' && !convo.slots.phone) { const p = normalizePhone(utterance); if (p) setSlot(convo, 'phone', p); }

  ensureEndMatchesStart(convo);

  // 3) Phase determination
  if (parsed.intent === 'FAQ') {
    convo.phase = 'faq';
  } else if (parsed.intent === 'CREATE' || ['collect_service','collect_time','check_availability','collect_contact','confirm_booking'].includes(convo.phase)) {
    if (!convo.slots.service)                       convo.phase = 'collect_service';
    else if (!convo.slots.startISO)                 convo.phase = 'collect_time';
    else if (!convo.availability.checked)           convo.phase = 'check_availability';
    else if (!convo.slots.name || !convo.slots.phone) convo.phase = 'collect_contact';
    else                                            convo.phase = 'confirm_booking';
  }

  // 4) FAQ analytics (optional)
  if (parsed.intent === 'FAQ' && MAKE_FAQ_URL) {
    fetchFN(MAKE_FAQ_URL, {
      method: 'POST', agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'FAQ', topic: parsed.faq_topic || '' })
    }).catch(()=>{});
  }

  // 5) If we have service+time but no availability check yet, do it now (and *don’t* ask for name yet)
  if (convo.phase === 'check_availability' && convo.slots.startISO && convo.slots.service && !convo.availability.checked) {
    await twilioSay(ws, 'One moment while I check the schedule.');
    const res = await readAvailability({
      service: convo.slots.service,
      startISO: convo.slots.startISO,
      endISO: convo.slots.endISO || computeEndISO(convo.slots.startISO)
    });
    convo.availability = res;

    if (res.available) {
      // Friendly “yes, want to book?”
      convo.phase = 'collect_contact';
      convo.awaitingAsk = 'NAME';
      await twilioSay(ws, `Good news — ${fmtTime(convo.slots.startISO)} is open. Want me to book it? I’ll just need your first name.`);
      return;
    } else {
      // Offer suggestion
      const alt = res.suggestionISO ? fmtTime(res.suggestionISO) : '';
      convo.phase = 'collect_time';
      convo.awaitingAsk = 'TIME';
      const line = alt
        ? `Looks like that time’s taken. I can do ${alt}. Would you like that, or another time?`
        : `Looks like that time’s taken. Is there another time that works?`;
      await twilioSay(ws, line);
      return;
    }
  }

  // 6) Decide what to say next
  parsed = ensureReplyOrAsk(parsed, utterance, convo);

  if (parsed.ask && parsed.ask !== 'NONE') {
    convo.awaitingAsk = parsed.ask;
  }

  const line = (parsed.reply || '').trim() || await openAINLG({ ...convo, forbidGreet: true });
  convo.turns += 1;
  convo.forbidGreet = true;
  await twilioSay(ws, line);
}

// ---------------------- Create (with re-check) ----------------------
async function finalizeCreate(ws, convo) {
  if (convo.created || convo.createInFlight) {
    log('INFO', '[CREATE] already done/in-flight; skipping');
    await twilioSay(ws, 'Your appointment’s confirmed. Anything else I can help with?');
    convo.awaitingAsk = 'NONE';
    return;
  }

  // Safety: re-check availability right before booking
  const recheck = await readAvailability({
    service: convo.slots.service,
    startISO: convo.slots.startISO,
    endISO: convo.slots.endISO || computeEndISO(convo.slots.startISO)
  });
  if (!recheck.available) {
    convo.availability = recheck;
    convo.phase = 'collect_time';
    convo.awaitingAsk = 'TIME';
    const alt = recheck.suggestionISO ? ` Nearest is ${fmtTime(recheck.suggestionISO)}.` : '';
    await twilioSay(ws, `Ah, that slot just got taken.${alt} What time should I try instead?`);
    return;
  }

  convo.createInFlight = true;
  if (!convo.slots.endISO && convo.slots.startISO) convo.slots.endISO = computeEndISO(convo.slots.startISO);
  if (!convo.slots.phone && convo.callerPhone)     convo.slots.phone = convo.callerPhone;

  const payload = {
    Event_Name:      convo.slots.service || 'Appointment',
    Start_Time:      convo.slots.startISO || '',
    End_Time:        convo.slots.endISO || computeEndISO(convo.slots.startISO || ''),
    Customer_Name:   convo.slots.name || '',
    Customer_Phone:  convo.slots.phone || '',
    Customer_Email:  convo.slots.email || '',
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
    log('WARN', '[Make CREATE] skipped; MAKE_CREATE missing', payload);
  }

  convo.created = true;
  convo.createInFlight = false;
  convo.phase = 'done';
  convo.awaitingAsk = 'NONE';

  const confirmLine = `All set. ${readbackLine(convo)} See you then. Anything else before I hang up?`;
  await twilioSay(ws, confirmLine);
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

  ws.on('error', (err) => log('ERROR', 'WS error', { error: err.message }));
  ws.on('close', () => { try { ws.__dg?.close(); } catch {} log('INFO', 'WS closed'); });

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { log('DEBUG', '[WS event ignored]', { evt: 'non-json' }); return; }
    const evt = msg.event; if (!evt) { log('DEBUG', '[WS event ignored]', msg); return; }
    if (evt === 'connected') { log('DEBUG', '[WS event ignored]', { evt }); return; }

    if (evt === 'start') {
      const callSid   = msg?.start?.callSid || '';
      const from      = msg?.start?.customParameters?.from || msg?.start?.from || '';
      const streamSid = msg?.start?.streamSid || '';
      const convo = newConvo(callSid, biz);
      ws.__convo = convo; ws.__streamSid = streamSid;
      convo.callerPhone = from || '';
      log('INFO', 'WS CONNECTED', { path: req.url, callSid, streamSid, biz });

      // Start Deepgram
      let dgOpened = false;
      ws.__dg = startDeepgramLinear16({
        onPartial: (t) => { if (!dgOpened) { dgOpened = true; } log('DEBUG', '[ASR partial]', { t }); },
        onFinal:   (t) => { log('INFO', '[ASR final]', { t }); handleASRFinal(ws, t); },
        onAnyMessage: (ev) => { if (ev.type && ev.type !== 'Results') log('DEBUG', '[ASR event]', { type: ev.type }); }
      });

      convo.awaitingAsk = 'NONE';
      convo.turns = 0;
      convo.forbidGreet = false;
      twilioSay(ws, 'Hi, thanks for calling Old Line Barbershop. How can I help you today?').catch(() => {});
      return;
    }

    if (evt === 'media') {
      const b64 = msg.media?.payload || ''; if (!b64) return;
      if (!ws.__ulawBatch) ws.__ulawBatch = [];
      ws.__ulawBatch.push(Buffer.from(b64, 'base64'));
      const BATCH_FRAMES = 5; // ~100ms
      if (ws.__ulawBatch.length >= BATCH_FRAMES && ws.__dg) {
        try {
          const ulawChunk = Buffer.concat(ws.__ulawBatch);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          ws.__dg.sendPCM16LE(pcm16le);
        } catch (e) { log('ERROR', '[media→DG] send error', { error: e?.message || String(e) }); }
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
