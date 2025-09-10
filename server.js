/**
 * server.js — Old Line Barbershop voice agent (WS + DG + OpenAI + 11L + Make)
 *
 * Env (Render -> Environment):
 *  PORT
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVENLABS_API_KEY
 *  MAKE_CREATE_URL
 *  MAKE_FAQ_URL
 *  AGENT_PROMPT (optional)
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const https = require('https');
const { URL } = require('url');
const { randomUUID } = require('crypto');

// ---------- Config / Globals ----------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVEN_API_KEY || '';
const MAKE_CREATE_URL = process.env.MAKE_CREATE || '';
const MAKE_FAQ_URL = process.env.MAKE_READ || '';

const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

// ---------- Logger ----------
function log(level, msg, meta = {}) {
  const safeMeta = (() => {
    try { return Object.keys(meta).length ? ' | ' + JSON.stringify(meta) : ''; }
    catch { return ''; }
  })();
  console.log(`${new Date().toISOString()} - [${level}] - ${msg}${safeMeta}`);
}

// Startup env snapshot
log('INFO', 'Startup env', {
  hasOpenAI: !!OPENAI_API_KEY,
  hasDG: !!DEEPGRAM_API_KEY,
  hasEleven: !!ELEVENLABS_API_KEY,
  hasMakeCreate: !!MAKE_CREATE_URL,
  hasMakeRead: !!MAKE_FAQ_URL,
  node: process.version,
  fetchSource: typeof fetch === 'function' ? 'global' : 'missing'
});

// ---------- Express (health) ----------
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

// ---------- Conversation State ----------
/** convoMap key = ws.__id */
const convoMap = new Map();
const REQUIRED_ORDER = ['service', 'startISO', 'name', 'phone'];

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
    slots: { service: '', startISO: '', endISO: '', name: '', phone: '', email: '' }
  };
}

// ---------- μ-law → PCM16LE (8k mono) with saturation ----------
function ulawByteToPcm16(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mant = u & 0x0f;
  let sample = (((mant << 3) + 0x84) << (exp + 2)) - 0x84 * 4;
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

// ---------- Deepgram realtime (URL params) ----------
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

  dg.on('open', () => { open = true; onOpen?.(); while (q.length) dg.send(q.shift()); });
  dg.on('message', (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    onAnyMessage?.(ev);
    if (ev.type !== 'Results') return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || '').trim();
    if (!text) return;
    if (ev.is_final === true || ev.speech_final === true) onFinal?.(text);
    else onPartial?.(text);
  });
  dg.on('error', (e) => onError?.(e));
  dg.on('close', (c, r) => log('INFO', '[Deepgram] closed', { code: c, reason: r || '' }));

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
    return new Date(d.getTime() + 30 * 60 * 1000).toISOString();
  } catch { return ''; }
}
function isReadyToCreate(slots) {
  return Boolean(slots.service && slots.startISO && (slots.endISO || computeEndISO(slots.startISO)) && slots.name && (slots.phone || '').trim());
}
function safeJSON(val, fallback = {}) { try { return JSON.parse(val); } catch { return fallback; } }
function debounceRepeat(convo, text, ms = 2500) {
  const now = Date.now();
  if (!text) return false;
  if (text === convo.lastTTS && (now - convo.lastTTSAt) < ms) return true;
  convo.lastTTS = text; convo.lastTTSAt = now; return false;
}
function setSlot(convo, k, v) {
  if (typeof v === 'string') v = v.trim();
  convo.slots[k] = v;
  log('INFO', '[slot set]', { k, v });
}
function nextMissing(slots) {
  for (const k of REQUIRED_ORDER) if (!slots[k]) return k;
  return '';
}
function normalizeFutureStart(startISO) {
  // If parsed time is in the past, bump to the same time next valid future day (heuristic)
  try {
    if (!startISO) return startISO;
    const s = new Date(startISO);
    if (isNaN(s.getTime())) return startISO;
    const now = Date.now();
    if (s.getTime() < now) {
      // bump +7 days until in the future (cheap guardrail)
      let bumped = new Date(s.getTime());
      while (bumped.getTime() < now) bumped = new Date(bumped.getTime() + 7 * 24 * 3600 * 1000);
      log('WARN', '[time guardrail] bumped parsed Start_Time to future', { from: startISO, to: bumped.toISOString() });
      return bumped.toISOString();
    }
    return s.toISOString();
  } catch { return startISO; }
}

// NEW: force crisp questions for slot asks
function makeQuestionForAsk(ask, convo) {
  if (ask === 'TIME') {
    const svc = convo.slots.service || 'appointment';
    return `What date and time work for your ${svc}?`;
  }
  if (ask === 'NAME') return `What name should I put on the booking?`;
  if (ask === 'PHONE') {
    return convo.callerPhone
      ? `Can I use ${convo.callerPhone} for confirmations?`
      : `What phone number should I use for confirmations?`;
  }
  if (ask === 'SERVICE') return `What service would you like — a haircut, beard trim, or the combo?`;
  return '';
}

// NEW: align End_Time to Start_Time + 30m if mismatched
function ensureEndMatchesStart(convo) {
  if (!convo.slots.startISO) return;
  const s = Date.parse(convo.slots.startISO);
  const e = Date.parse(convo.slots.endISO || '');
  if (!isNaN(s) && (isNaN(e) || e <= s)) {
    convo.slots.endISO = computeEndISO(convo.slots.startISO);
    log('INFO', '[end fix] aligning End_Time to Start_Time +30m', { start: convo.slots.startISO, end: convo.slots.endISO });
  }
}

// ---------- OpenAI: Extract ----------
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
  log('DEBUG', '[OpenAI extract ->]', { sysFirst120: sys.slice(0,120), utterance });

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }
    })
  }).catch(e => { throw new Error(e.message || 'fetch failed'); });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`OpenAI extract error ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  const parsed = safeJSON(raw, { intent: 'UNKNOWN', faq_topic: '', ask: 'NONE', reply: '' });
  log('DEBUG', '[OpenAI extract <-]', parsed);
  return parsed;
}

// ---------- OpenAI: NLG (fallback/confirm) ----------
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

  const user = `Compose the next thing to say to the caller.${promptHints ? ' Hint: ' + promptHints : ''}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [{ role: 'system', content: sys }, { role: 'system', content: ctx }, { role: 'user', content: user }]
    })
  }).catch(e => { throw new Error(e.message || 'fetch failed'); });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`OpenAI nlg error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  return text || 'Okay.';
}

// ---------- TTS (ElevenLabs) -> Twilio media frames ----------
async function ttsToTwilio(ws, text, voiceId = 'pNInz6obpgDQGcFmaJgB') {
  if (!text) return;

  const convo = ws.__convo;
  if (debounceRepeat(convo, text)) {
    log('DEBUG', '[debounce] suppress repeat', { text });
    return;
  }

  const streamSid = ws.__streamSid;
  if (!streamSid) { log('WARN', '[TTS] missing streamSid; cannot send audio'); return; }
  if (!ELEVENLABS_API_KEY) { log('WARN', '[TTS] ELEVENLABS_API_KEY missing; skipping audio'); return; }

  log('INFO', '[TTS ->]', { text });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  const resp = await fetch(url, {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Accept': 'audio/wav', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_settings: { stability: 0.5, similarity_boost: 0.8 }, generation_config: { chunk_length_schedule: [120,160,200,240] } })
  }).catch(e => { log('ERROR', '[TTS fetch]', { error: e.message }); return null; });

  if (!resp || !resp.ok) {
    if (resp) log('ERROR', '[TTS HTTP]', { status: resp.status, txt: await resp.text().catch(()=> '') });
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
  log('INFO', '[TTS end]', { bytes: total });
}

// ---------- Twilio helpers ----------
function safeSend(ws, data) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch (e) { log('ERROR', '[WS send]', { error: e.message }); }
}
function twilioSay(ws, text) { return ttsToTwilio(ws, text); }

// ---------- ensureReplyOrAsk (FORCED QUESTIONS + CONFIRM) ----------
function ensureReplyOrAsk(parsed, utterance, phase, convo) {
  // Promote asks if we already have a slot
  if (parsed.ask === 'SERVICE' && convo?.slots?.service) parsed.ask = 'TIME';
  if (parsed.ask === 'TIME' && convo?.slots?.startISO) parsed.ask = 'NAME';

  // If we’re missing a specific slot, force a crisp question
  const askNeeded =
    (!convo.slots.service && 'SERVICE') ||
    (!convo.slots.startISO && 'TIME') ||
    (!convo.slots.name && 'NAME') ||
    (!convo.slots.phone && 'PHONE') || 'NONE';

  if (askNeeded !== 'NONE') {
    parsed.ask = askNeeded;
    parsed.reply = makeQuestionForAsk(askNeeded, convo);
    return parsed;
  }

  // In confirm phase, force a confirm question
  if (convo.phase === 'confirm_booking') {
    parsed.ask = 'CONFIRM';
    parsed.reply = `Just to confirm: ${convo.slots.service} at ${convo.slots.startISO} for ${convo.slots.name}. Is that right?`;
    return parsed;
  }

  // fallback: keep flow moving
  const svcU = normalizeService(utterance);
  if ((parsed.intent === 'CREATE' || phase === 'collect_time')) {
    const svc = parsed.service || normalizeService(parsed.Event_Name) || svcU || convo?.slots?.service;
    if (svc && phase !== 'confirm_booking') {
      parsed.ask = 'TIME';
      parsed.reply = `Got it — ${svc}. What date and time work for you?`;
      return parsed;
    }
  }
  if (parsed.intent === 'FAQ' && parsed.faq_topic) {
    parsed.ask = 'NONE';
    parsed.reply = 'Anything else I can help with?';
    return parsed;
  }
  parsed.ask = 'NONE';
  parsed.reply = 'Got it. How can I help further?';
  return parsed;
}

// ---------- Flow Orchestration ----------
async function onUserUtterance(ws, utterance) {
  const convo = ws.__convo;
  if (!convo) return;

  log('INFO', '[USER]', { text: utterance });

  // Extract semantics
  let parsed;
  try {
    parsed = await openAIExtract(utterance, convo);
  } catch (e) {
    log('ERROR', '[extract]', { error: e.message });
    parsed = { intent: 'UNKNOWN', ask: 'NONE', reply: '' };
  }

  // Normalize/ensure reply
  parsed = ensureReplyOrAsk(parsed, utterance, convo.phase, convo);

  // Merge slots
  if (parsed.service || parsed.Event_Name) {
    const svc = parsed.service || normalizeService(parsed.Event_Name);
    if (svc) setSlot(convo, 'service', svc);
  }

  if (parsed.Start_Time) {
    const normStart = normalizeFutureStart(parsed.Start_Time);
    setSlot(convo, 'startISO', normStart);
  }
  if (!convo.slots.endISO && parsed.End_Time) setSlot(convo, 'endISO', parsed.End_Time);
  if (!convo.slots.endISO && convo.slots.startISO) setSlot(convo, 'endISO', computeEndISO(convo.slots.startISO));
  ensureEndMatchesStart(convo);

  if (parsed.Customer_Name) setSlot(convo, 'name', parsed.Customer_Name);
  if (parsed.Customer_Phone) setSlot(convo, 'phone', parsed.Customer_Phone);
  if (parsed.Customer_Email) setSlot(convo, 'email', parsed.Customer_Email);

  // Phase transitions
  if (parsed.intent === 'FAQ') {
    convo.phase = 'faq';
  } else if (parsed.intent === 'CREATE') {
    if (!convo.slots.service) convo.phase = 'collect_service';
    else if (!convo.slots.startISO) convo.phase = 'collect_time';
    else if (!convo.slots.name || !(convo.slots.phone || convo.callerPhone)) convo.phase = 'collect_contact';
    else convo.phase = 'confirm_booking';
  }
  log('DEBUG', '[phase]', { phase: convo.phase, missing: nextMissing(convo.slots) || 'none' });

  // Log FAQ to Make (non-blocking)
  if (parsed.intent === 'FAQ' && MAKE_FAQ_URL) {
    postToMakeFAQ(parsed.faq_topic || '').catch(() => {});
  }

  // Create if ready
  if (convo.phase === 'confirm_booking' && isReadyToCreate(convo.slots)) {
    await finalizeCreate(ws, convo);
    return;
  }

  // Decide what to say: prefer forced slot question when applicable
  let line = (parsed.reply || '').trim();

  if (parsed.ask && ['SERVICE','TIME','NAME','PHONE'].includes(parsed.ask)) {
    line = makeQuestionForAsk(parsed.ask, convo) || line;
  }

  if (!line) {
    const missing = nextMissing(convo.slots);
    line = makeQuestionForAsk(
      missing === 'service' ? 'SERVICE' :
      missing === 'startISO' ? 'TIME' :
      missing === 'name' ? 'NAME' :
      missing === 'phone' ? 'PHONE' : 'NONE', convo
    ) || await openAINLG({ ...convo, forbidGreet:true }).catch(()=> 'Okay.');
  }

  convo.turns += 1;
  convo.forbidGreet = true;
  await twilioSay(ws, line);
}

async function finalizeCreate(ws, convo) {
  // End time safety
  if (!convo.slots.endISO && convo.slots.startISO) setSlot(convo, 'endISO', computeEndISO(convo.slots.startISO));
  ensureEndMatchesStart(convo);
  // Phone fallback from caller
  if (!convo.slots.phone && convo.callerPhone) setSlot(convo, 'phone', convo.callerPhone);

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
    if (MAKE_CREATE_URL) {
      const r = await fetch(MAKE_CREATE_URL, {
        method: 'POST',
        agent: keepAliveHttpsAgent,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) log('WARN', '[Make CREATE] non-200', { status: r.status, txt: await r.text().catch(()=> '') });
      else log('INFO', '[Make CREATE] ok');
    } else {
      log('WARN', '[Make CREATE] skipped (no MAKE_CREATE_URL)');
    }
  } catch (e) {
    log('ERROR', '[Make CREATE] error', { error: e.message });
  }

  const confirmLine = await openAINLG(
    { ...convo, forbidGreet: true, phase: 'done' },
    `Confirm booking and say goodbye. Service=${convo.slots.service}, start=${convo.slots.startISO}, name=${convo.slots.name}`
  ).catch(()=> 'Your appointment is confirmed. Thanks for calling!');
  await twilioSay(ws, confirmLine);
}

async function postToMakeFAQ(topic) {
  try {
    await fetch(MAKE_FAQ_URL, {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'FAQ', topic })
    });
  } catch (e) {
    log('WARN', '[Make FAQ] error', { error: e.message });
  }
}

// ---------- WS Handlers ----------
wss.on('connection', (ws, req) => {
  // Parse Twilio params
  let params = {};
  try { params = new URL(req.url, `http://${req.headers.host}`).searchParams; } catch {}
  const biz = params.get?.('biz') || 'acme-001';

  const id = randomUUID();
  ws.__id = id;

  ws.on('error', (err) => log('ERROR', 'WS error', { error: err.message }));
  ws.on('close', () => {
    try { ws.__dg?.close(); } catch {}
    convoMap.delete(ws.__id);
    log('INFO', 'WS closed');
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { log('DEBUG', '[WS raw non-JSON]', { raw: raw.toString().slice(0,120) }); return; }
    const evt = msg.event;

    if (evt === 'connected') { log('DEBUG', '[WS event ignored]', { evt }); return; }

    if (evt === 'start') {
      const callSid = msg?.start?.callSid || '';
      const from = msg?.start?.customParameters?.from || msg?.start?.from || '';
      const streamSid = msg?.start?.streamSid || '';
      const path = params.get?.('path') || '/twilio';

      const convo = newConvo(callSid, biz);
      ws.__convo = convo;
      ws.__streamSid = streamSid;
      convo.callerPhone = from || '';
      convoMap.set(ws.__id, convo);

      log('INFO', 'WS CONNECTED', { path, callSid, streamSid, biz });
      log('INFO', '[agent prompt 120]', { text: AGENT_PROMPT.slice(0,120) });

      // Start Deepgram pipe
      if (DEEPGRAM_API_KEY) {
        ws.__dg = startDeepgramLinear16({
          onOpen: () => log('INFO', '[ASR] Deepgram open'),
          onPartial: (t) => log('DEBUG', '[ASR partial]', { t }),
          onFinal: (t) => { log('INFO', '[ASR final]', { t }); handleASRFinal(ws, t); },
          onError: (e) => log('ERROR', '[ASR] Deepgram error', { error: e?.message || String(e) }),
          onAnyMessage: (ev) => { if (ev.type && ev.type !== 'Results') log('DEBUG', '[ASR msg]', { type: ev.type }); }
        });
      } else {
        log('WARN', 'No DEEPGRAM_API_KEY — ASR disabled');
      }

      // Greeting
      ws.__convo.turns = 0;
      ws.__convo.forbidGreet = false;
      twilioSay(ws, 'Hi, thanks for calling Old Line Barbershop. How can I help you today?').catch(() => {});
      return;
    }

    if (evt === 'media') {
      ws.__frameCount = (ws.__frameCount || 0) + 1;
      if (!(ws.__frameCount % 50)) log('DEBUG', '[media] frames', { frameCount: ws.__frameCount });
      const b64 = msg.media?.payload || '';
      if (!b64) return;
      if (ws.__dg) {
        try {
          ws.__pendingULaw = ws.__pendingULaw || [];
          ws.__pendingULaw.push(Buffer.from(b64, 'base64'));
          const BATCH_FRAMES = 5; // ≈100ms
          if (ws.__pendingULaw.length >= BATCH_FRAMES) {
            const ulawChunk = Buffer.concat(ws.__pendingULaw);
            ws.__pendingULaw = [];
            const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
            ws.__dg.sendPCM16LE(pcm16le);
          }
        } catch (e) {
          log('ERROR', '[media→DG] send error', { error: e.message });
        }
      }
      return;
    }

    if (evt === 'mark') { log('DEBUG', '[mark]', { name: msg?.mark?.name }); return; }

    if (evt === 'stop') {
      log('INFO', 'Twilio stream STOP');
      try {
        if (ws.__pendingULaw?.length && ws.__dg) {
          const ulawChunk = Buffer.concat(ws.__pendingULaw);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          ws.__dg.sendPCM16LE(pcm16le);
        }
      } catch {}
      try { ws.__dg?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    // Optional synthetic "asr" passthrough event pattern
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
  convo.asrText = text;
  onUserUtterance(ws, text).catch(err => log('ERROR', '[onUserUtterance]', { error: err.message }));
}

// ---------- Start server ----------
server.listen(PORT, () => {
  log('INFO', 'Server running', { PORT: String(PORT) });
});

