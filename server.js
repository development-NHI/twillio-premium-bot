// server.js — Old Line Barbershop voice agent (warm-up + no-TTS-after-close + availability-first)

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || '';
const DEEPGRAM_API_KEY = process.env.DEPPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY || '';

const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVEN_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL || process.env.MAKE_CREATE || '';
const MAKE_READ_URL   = process.env.MAKE_READ_URL   || process.env.MAKE_READ   || '';
const MAKE_FAQ_URL    = process.env.MAKE_FAQ_URL    || '';

const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });
const fetchFN = (...args) => globalThis.fetch(...args);

function log(level, msg, meta) {
  if (meta && Object.keys(meta).length) console.log(`${new Date().toISOString()} - [${level}] - ${msg} | ${JSON.stringify(meta)}`);
  else console.log(`${new Date().toISOString()} - [${level}] - ${msg}`);
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

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DEFAULT_AGENT_PROMPT = `
You’re a warm, natural receptionist for Old Line Barbershop.

Flow:
1) Service (haircut, beard trim, combo) — but if caller gives a time first, accept it, then ask service.
2) Ask date/time if missing.
3) Check availability via Make READ; say clearly open/closed.
   - Open: “That time’s open — want me to book it?”
   - Closed: offer nearest inside Mon–Fri 9–5.
4) Then collect first name and phone.
5) Read back details; confirm yes/no.
6) On yes, create once. Then ask if they need anything else and hang up if not.

Warm-up:
- If the first couple turns are unclear/smalltalk, ask: “Are you calling to book, reschedule, cancel, or ask about hours/prices?”

Style:
- Short, friendly sentences. One question at a time. Micro-acks.
- Don’t re-ask known info. Never speak JSON.
- Hours: Mon–Fri, 9–5.
- Never create more than one appointment per call.

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
    askCounts: { SERVICE:0, TIME:0, NAME:0, PHONE:0, CONFIRM:0 },
    askLastAt: { SERVICE:0, TIME:0, NAME:0, PHONE:0, CONFIRM:0 },
    warmupTries: 0,
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
  for (let i = 0; i < ulawBuf.length; i++) out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i * 2);
  return out;
}

// ---------------------- Deepgram ----------------------
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  if (!DEEPGRAM_API_KEY) return null;
  const url =
    'wss://api.deepgram.com/v1/listen'
    + '?encoding=linear16&sample_rate=8000&channels=1'
    + '&model=nova-2-phonecall&interim_results=true&smart_format=true&language=en-US&endpointing=250';

  const dg = new WebSocket(url, { headers: { Authorization: `token ${DEEPGRAM_API_KEY}` }, perMessageDeflate: false });
  let open = false; const q = [];
  dg.on('open', () => { open = true; log('INFO', '[ASR] Deepgram open'); onOpen?.(); while (q.length) dg.send(q.shift()); });
  dg.on('message', (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    onAnyMessage?.(ev);
    if (ev.type !== 'Results') return;
    const alt = ev.channel?.alternatives?.[0]; if (!alt) return;
    const text = (alt.transcript || '').trim(); if (!text) return;
    const isFinal = ev.is_final === true || ev.speech_final === true;
    if (isFinal) onFinal?.(text); else onPartial?.(text);
  });
  dg.on('error', (e) => { log('ERROR', '[ASR] error', { error: e?.message || String(e) }); onError?.(e); });
  dg.on('close', (c, r) => log('INFO', '[ASR] Deepgram closed', { code: c, reason: (r||'').toString?.() || '' }));
  return { sendPCM16LE(buf){ if (open) dg.send(buf); else q.push(buf); }, close(){ try{ dg.close(); }catch{} } };
}

// ---------------------- Helpers ----------------------
function isWsLive(ws){ return ws && ws.readyState === WebSocket.OPEN && !ws.__ended; }

function normalizeService(text) {
  if (!text) return '';
  const t = text.toLowerCase();

  // Common mis-hearings mapped to haircut
  if (/\bfair ?card\b/.test(t)) return 'haircut';
  if (/\bhair ?kit\b/.test(t)) return 'haircut';
  if (/\bhair ?cat\b/.test(t)) return 'haircut';

  if (/\b(both|combo|combo package|haircut\s*(?:&|and|\+)\s*beard|haircut\s*\+\s*beard)\b/.test(t)) return 'combo';
  if (/\bbeard( |\-)?trim\b/.test(t)) return 'beard trim';
  if (/\bhair\s*cut\b|\bhaircut\b/.test(t)) return 'haircut';
  return '';
}
function computeEndISO(startISO) {
  try {
    if (!startISO) return '';
    const d = new Date(startISO);
    if (isNaN(d.getTime())) return '';
    return new Date(d.getTime() + 30 * 60 * 1000).toISOString();
  } catch { return ''; }
}
function safeJSON(v, fb = {}) { try { return JSON.parse(v); } catch { return fb; } }
function isReadyToCreate(slots) { return Boolean(slots.service && slots.startISO && (slots.endISO || computeEndISO(slots.startISO)) && slots.name && (slots.phone || '').trim()); }
function ensureEndMatchesStart(convo) { if (convo.slots.startISO && !convo.slots.endISO) convo.slots.endISO = computeEndISO(convo.slots.startISO); }
function normalizeFutureStart(iso) {
  if (!iso) return '';
  const dt = new Date(iso); if (isNaN(+dt)) return iso;
  const now = new Date();
  if (dt.getTime() < now.getTime()) {
    const bumped = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    bumped.setHours(dt.getHours(), dt.getMinutes(), 0, 0);
    log('WARN', '[time guardrail] bumped parsed Start_Time to future', { from: iso, to: bumped.toISOString() });
    return bumped.toISOString();
  }
  return dt.toISOString();
}
function yesish(s) { return /\b(yes|yep|yeah|sure|correct|right|sounds good|please do|book it|that works)\b/i.test(s); }
function noish(s)  { return /\b(no|nope|nah|not (quite|correct|right)|change|different|actually|hold off)\b/i.test(s); }
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
  const bits = [ s.service ? `${s.service}` : '', when ? `on ${when}` : '', s.name ? `for ${s.name}` : '', phone ? `at ${phone}` : '' ]
    .filter(Boolean).join(', ');
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
function debounceRepeat(convo, text, ms = 2500) {
  const now = Date.now();
  if (!text) return false;
  if (text === convo.lastTTS && (now - convo.lastTTSAt) < ms) return true;
  convo.lastTTS = text; convo.lastTTSAt = now; return false;
}
function shouldThrottleAsk(convo, ask, minMs=3000) {
  const now = Date.now();
  const last = convo.askLastAt[ask] || 0;
  if ((now - last) < minMs) return true; // too soon to repeat
  convo.askLastAt[ask] = now;
  convo.askCounts[ask] = (convo.askCounts[ask] || 0) + 1;
  return false;
}
function askLine(ask, convo) {
  const n = convo.askCounts[ask] || 0;
  if (ask === 'SERVICE') {
    if (n === 0) return 'What service can I get you — haircut, beard trim, or the combo?';
    if (n === 1) return 'Got it. Is that for a haircut, beard trim, or the combo?';
    return 'I can check it for a haircut to start — want that, or a different service?';
  }
  if (ask === 'TIME')    return n ? `What day and time works for your ${convo.slots.service || 'appointment'}?` : `What date and time would you like?`;
  if (ask === 'NAME')    return n ? 'What’s your first name?' : 'Great — can I grab your first name?';
  if (ask === 'PHONE')   return n ? 'And your best phone to confirm?' : 'And what’s the best phone for confirmations?';
  if (ask === 'CONFIRM') return readbackLine(convo) + ' Everything look right?';
  return 'How can I help further?';
}

// ---------------------- Availability via Make READ ----------------------
async function readAvailability({ service, startISO, endISO }) {
  if (!MAKE_READ_URL) {
    log('WARN', '[Make READ] unavailable; assuming available');
    return { checked: true, available: true, suggestionISO: '' };
  }
  const payload = { Event_Name: service || 'Appointment', Start_Time: startISO || '', End_Time: endISO || (startISO ? computeEndISO(startISO) : '') };
  try {
    const r = await fetchFN(MAKE_READ_URL, {
      method: 'POST', agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const txt = await r.text();
    if (!r.ok) { log('WARN', '[Make READ] non-200', { status: r.status, body: txt.slice(0, 500) }); return { checked: true, available: true, suggestionISO: '' }; }
    const data = safeJSON(txt, {});
    let available = true, suggestionISO = '';
    if (typeof data.available === 'boolean') { available = !!data.available; suggestionISO = data.suggestionStart || data.suggestionISO || ''; }
    else if (Array.isArray(data.busy)) {
      const s = new Date(startISO).getTime(); const e = new Date(endISO || computeEndISO(startISO)).getTime();
      const overlaps = data.busy.some(b => Math.max(s, new Date(b.start).getTime()) < Math.min(e, new Date(b.end).getTime()));
      available = !overlaps; suggestionISO = data.suggestionStart || '';
    } else if (Array.isArray(data.events)) {
      const s = new Date(startISO).getTime(); const e = new Date(endISO || computeEndISO(startISO)).getTime();
      const overlaps = data.events.some(ev => Math.max(s, new Date(ev.start || ev.Start_Time).getTime()) < Math.min(e, new Date(ev.end || ev.End_Time).getTime()));
      available = !overlaps;
    }
    return { checked: true, available, suggestionISO };
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
- If they ask availability like “any time tomorrow?”, set intent="CREATE" and prefer asking for a time if missing.
- Don’t jump to NAME/PHONE until availability has been checked for a time.
- Treat “both/combo/haircut + beard” as service = "combo".
- Keep reply short, one question max. No greetings if forbidGreet=true.`,
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
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        response_format: { type: 'json_object' }
      })
    });
    if (!resp.ok) { const txt = await resp.text().catch(()=> ''); throw new Error(`${resp.status} ${txt}`); }
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || '{}';
    return safeJSON(raw, { intent: 'UNKNOWN', faq_topic: '', ask: 'NONE', reply: '' });
  } catch (e) {
    log('ERROR', '[extract]', { error: e.message });
    return { intent: 'UNKNOWN', faq_topic: '', ask: 'NONE', reply: '' };
  }
}

async function openAINLG(convo, hint = '') {
  const sys = `You're a friendly front-desk human. One short, natural sentence (<22 words). Micro-acks. One question max. No greetings if forbidGreet=true.`;
  const ctx = `State:
phase=${convo.phase}
forbidGreet=${convo.forbidGreet}
service=${convo.slots.service}
startISO=${convo.slots.startISO}
name=${convo.slots.name}
phone=${convo.slots.phone}
AGENT PROMPT:
${AGENT_PROMPT}`;
  const user = `Say the next line. ${hint ? 'Hint: ' + hint : ''}`;

  try {
    const resp = await fetchFN('https://api.openai.com/v1/chat/completions', {
      method: 'POST', agent: keepAliveHttpsAgent,
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini', temperature: 0.5,
        messages: [{ role: 'system', content: sys }, { role: 'system', content: ctx }, { role: 'user', content: user }]
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
  const inBooking = ['collect_service','collect_time','check_availability','collect_contact','confirm_booking'].includes(convo.phase);
  const canCollect = parsed.intent === 'CREATE' || inBooking;

  // Merge service fallback (includes fuzzy)
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

  // Warm-up: if UNKNOWN/SMALLTALK in idle early turns, nudge
  if ((parsed.intent === 'UNKNOWN' || parsed.intent === 'SMALLTALK') && convo.phase === 'idle' && convo.warmupTries < 2) {
    convo.warmupTries += 1;
    parsed.ask = 'NONE';
    parsed.reply = 'I can book, reschedule, cancel, or answer hours/prices. What would you like to do?';
    return parsed;
  }

  // Ready -> confirm
  if (canCollect && isReadyToCreate(convo.slots)) {
    convo.phase = 'confirm_booking';
    parsed.ask = 'CONFIRM';
    parsed.reply = askLine('CONFIRM', convo);
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

    let askNeeded =
      (!have.service && 'SERVICE') ||
      (!have.startISO && 'TIME') ||
      (!convo.slots.name && 'NAME') ||
      (!convo.slots.phone && 'PHONE') ||
      'NONE';

    // Anti-loop default: if stuck on SERVICE and we already have a time, assume haircut after 2 tries
    if (askNeeded === 'SERVICE' && have.startISO && (convo.askCounts.SERVICE || 0) >= 2) {
      setSlot(convo, 'service', 'haircut'); // default
      convo.phase = 'check_availability';
      parsed.ask = 'NONE';
      parsed.reply = 'I’ll check that time for a haircut. Tell me if you prefer beard trim or the combo.';
      return parsed;
    }

    if (askNeeded !== 'NONE') {
      parsed.ask = askNeeded;
      parsed.reply = askLine(askNeeded, convo);
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
  if (!isWsLive(ws)) return; // <-- don't synth/log after close
  const convo = ws.__convo;
  if (debounceRepeat(convo, text)) { log('DEBUG', '[debounce] suppress repeat', { text }); return; }

  // Throttle repeats of the SAME question type
  if (convo.awaitingAsk && convo.awaitingAsk !== 'NONE' && shouldThrottleAsk(convo, convo.awaitingAsk)) {
    log('DEBUG', '[ask throttle]', { ask: convo.awaitingAsk });
    return;
  }

  const streamSid = ws.__streamSid;
  if (!streamSid) { log('WARN', '[TTS] missing streamSid'); return; }
  if (!ELEVENLABS_API_KEY) { log('WARN', '[TTS] ELEVEN_API_KEY missing'); return; }

  log('INFO', '[TTS ->]', { text });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  try {
    const resp = await fetchFN(url, {
      method: 'POST', agent: keepAliveHttpsAgent,
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Accept': 'audio/wav', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_settings: { stability: 0.5, similarity_boost: 0.8 }, generation_config: { chunk_length_schedule: [120,160,200,240] } })
    });
    if (!resp.ok) { const t = await resp.text().catch(()=> ''); log('ERROR', '[TTS fetch]', { error: `${resp.status} ${t}` }); return; }

    const reader = resp.body.getReader();
    while (true) {
      if (!isWsLive(ws)) break;
      const { value, done } = await reader.read();
      if (done) break;
      if (!isWsLive(ws)) break;
      const b64 = Buffer.from(value).toString('base64');
      const frame = { event: 'media', streamSid, media: { payload: b64 } };
      if (isWsLive(ws)) ws.send(JSON.stringify(frame));
    }
    if (isWsLive(ws)) ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'eos' } }));
  } catch (e) {
    log('ERROR', '[TTS fetch]', { error: e.message });
  }
}
function twilioSay(ws, text) { return ttsToTwilio(ws, text); }

// ---------------------- Main flow ----------------------
async function onUserUtterance(ws, utterance) {
  if (!isWsLive(ws)) return;
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

  ensureEndMatchesStart(convo);

  // 3) Phase
  if (parsed.intent === 'FAQ') {
    convo.phase = 'faq';
  } else if (parsed.intent === 'CREATE' || ['collect_service','collect_time','check_availability','collect_contact','confirm_booking'].includes(convo.phase)) {
    if (!convo.slots.service)                         convo.phase = 'collect_service';
    else if (!convo.slots.startISO)                   convo.phase = 'collect_time';
    else if (!convo.availability.checked)             convo.phase = 'check_availability';
    else if (!convo.slots.name || !convo.slots.phone) convo.phase = 'collect_contact';
    else                                              convo.phase = 'confirm_booking';
  }

  // 4) FAQ log (optional)
  if (parsed.intent === 'FAQ' && MAKE_FAQ_URL) {
    fetchFN(MAKE_FAQ_URL, {
      method: 'POST', agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'FAQ', topic: parsed.faq_topic || '' })
    }).catch(()=>{});
  }

  // 5) Availability check stage
  if (convo.phase === 'check_availability' && convo.slots.startISO && convo.slots.service && !convo.availability.checked) {
    await twilioSay(ws, 'One moment while I check the schedule.');
    const res = await readAvailability({
      service: convo.slots.service,
      startISO: convo.slots.startISO,
      endISO: convo.slots.endISO || computeEndISO(convo.slots.startISO)
    });
    convo.availability = res;

    if (!isWsLive(ws)) return;

    if (res.available) {
      convo.phase = 'collect_contact';
      convo.awaitingAsk = 'NAME';
      await twilioSay(ws, `Good news — ${fmtTime(convo.slots.startISO)} is open. Want me to book it? I’ll just need your first name.`);
      return;
    } else {
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

  // 6) Decide next line
  parsed = ensureReplyOrAsk(parsed, utterance, convo);
  if (parsed.ask && parsed.ask !== 'NONE') convo.awaitingAsk = parsed.ask;

  const line = (parsed.reply || '').trim() || await openAINLG({ ...convo, forbidGreet: true });
  if (!isWsLive(ws)) return;
  convo.turns += 1; convo.forbidGreet = true;
  await twilioSay(ws, line);
}

// ---------------------- Create (with re-check) ----------------------
async function finalizeCreate(ws, convo) {
  if (!isWsLive(ws)) return;
  if (convo.created || convo.createInFlight) {
    log('INFO', '[CREATE] already done/in-flight; skipping');
    await twilioSay(ws, 'Your appointment’s confirmed. Anything else I can help with?');
    convo.awaitingAsk = 'NONE'; return;
  }

  // Re-check availability before booking
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
        method: 'POST', agent: keepAliveHttpsAgent,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) log('WARN', '[Make CREATE] non-200', { status: r.status, body: await r.text().catch(()=> '') });
      else log('INFO', '[Make CREATE] ok');
    } catch (e) { log('ERROR', '[Make CREATE]', { error: e.message }); }
  } else {
    log('WARN', '[Make CREATE] skipped; MAKE_CREATE missing', payload);
  }

  convo.created = true;
  convo.createInFlight = false;
  convo.phase = 'done';
  convo.awaitingAsk = 'NONE';

  await twilioSay(ws, `All set. ${readbackLine(convo)} See you then. Anything else before I hang up?`);
}

// ---------------------- ASR final hook ----------------------
function handleASRFinal(ws, text) {
  if (!isWsLive(ws)) return;
  const convo = ws.__convo; if (!convo) return;
  convo.asrText = text;
  onUserUtterance(ws, text).catch(err => log('ERROR', '[onUserUtterance]', { error: err.message }));
}

// ---------------------- WebSocket handlers ----------------------
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const biz = params.get('biz') || 'acme-001';

  ws.__ended = false;

  ws.on('error', (err) => log('ERROR', 'WS error', { error: err.message }));
  ws.on('close', () => { ws.__ended = true; try { ws.__dg?.close(); } catch {} log('INFO', 'WS closed'); });

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
      if (ws.__ended) return;
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
      ws.__ended = true;
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
      if (ws.__ended) return;
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
