/**
 * server.js — Old Line Barbershop voice agent (sticky slots + strict flow)
 *
 * - Twilio Media Streams WS
 * - Deepgram ASR (URL-config; μ-law → PCM16LE @ 8kHz mono, batched)
 * - OpenAI (extraction + NLG; JSON contract)
 * - ElevenLabs TTS (ulaw_8000 streaming) — includes streamSid on frames
 * - Make.com webhooks for FAQ log + CREATE booking
 *
 * Env:
 *  PORT
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVEN_API_KEY
 *  ELEVEN_VOICE_ID           (optional; default below)
 *  MAKE_CREATE               (Create webhook)
 *  MAKE_READ                 (FAQ log webhook)
 *  AGENT_PROMPT             (optional)
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
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const ELEVEN_API_KEY   = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID  = process.env.ELEVEN_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
const MAKE_CREATE_URL  = process.env.MAKE_CREATE || 'https://hook.us2.make.com/7hd4nxdrgytwukxw57cwyykhotv6hxrm';
const MAKE_FAQ_URL     = process.env.MAKE_READ   || 'https://hook.us2.make.com/6hmur673mpqw4xgy2bhzx4be4o32ziax';
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 15000 });

const log = (...a) => console.log(new Date().toISOString(), '-', ...a);
if (!OPENAI_API_KEY)   log('[WARN] OPENAI_API_KEY missing');
if (!DEEPGRAM_API_KEY) log('[WARN] DEEPGRAM_API_KEY missing');
if (!ELEVEN_API_KEY)   log('[WARN] ELEVEN_API_KEY missing');

// ---------- HTTP (health) ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------- WS ----------
const wss = new WebSocket.Server({ server });

// ---------- Prompt ----------
const DEFAULT_AGENT_PROMPT = `
You are a friendly, human-sounding AI receptionist for Old Line Barbershop.
Short sentences (<~18–22 words), one question at a time, varied phrasing.
Do not greet again after first greeting.

STRICT BOOKING ORDER:
1) Service (haircut, beard trim, or combo).
2) Preferred date and time.
3) Confirm availability (assume available unless out of hours).
4) Then ask for name and phone; prefer caller’s number, confirm once.
5) Confirm details and end call.

Hours: Mon–Fri 9am–5pm only. Closed weekends.
If time is outside hours, suggest nearest valid time.
Treat “both/combo/haircut + beard” as combo.

FAQs (PRICES/HOURS/SERVICES/LOCATION): answer briefly, then ask if they want to book.

Be kind if caller jokes or is rude; steer back to the task.
`.trim();
const AGENT_PROMPT = process.env.AGENT_PROMPT || DEFAULT_AGENT_PROMPT;

// ---------- Static FAQ ----------
const STATIC_FAQ = {
  PRICES:   "Haircut $30. Beard trim $15. Combo (haircut + beard trim) $40.",
  HOURS:    "We’re open Monday–Friday, nine to five, and closed on weekends.",
  SERVICES: "We offer haircuts, beard trims, and a combo of both.",
  LOCATION: "We’re on Main Street in Ellicott City, next to the coffee shop."
};
const YES_RX = /\b(yes|yeah|yep|yup|sure|ok(?:ay)?|please|book it|let'?s (?:do|book) it|sounds good)\b/i;
const NO_RX  = /\b(no|nope|nah|not now|stop|cancel|never mind|nevermind)\b/i;
const RUDE_RX= /\b(mom|stupid|idiot|dumb|shut up|suck|wtf|fuck|shit|asshole)\b/i;

// ---------- State ----------
const convoMap = new Map();
const REQUIRED_ORDER = ['service', 'startISO', 'name', 'phone']; // hard gate: never re-ask filled slot

function newConvo(callSid, biz) {
  return {
    id: randomUUID(),
    callSid, biz,
    turns: 0,
    forbidGreet: false,
    phase: 'idle',
    callerPhone: '',
    lastUserFinal: '',
    isSpeaking: false,
    lastSpeechEndedAt: 0,
    ttsQueue: [],
    lastAsk: 'NONE',
    lastAskAt: 0,
    lastFaqTopic: '',
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

// ---------- Audio utils (μ-law → PCM16LE) ----------
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

// ---------- Deepgram (URL-config) ----------
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  const url = 'wss://api.deepgram.com/v1/listen'
    + '?encoding=linear16&sample_rate=8000&channels=1'
    + '&model=nova-2-phonecall&interim_results=true&smart_format=true&language=en-US&endpointing=250';
  const dg = new WebSocket(url, { headers: { Authorization: `token ${DEEPGRAM_API_KEY}` }, perMessageDeflate: false });
  let open = false; const q = [];
  dg.on('open', () => { open = true; onOpen?.(); while (q.length) dg.send(q.shift()); });
  dg.on('message', d => {
    let ev; try { ev = JSON.parse(d.toString()); } catch { return; }
    onAnyMessage?.(ev);
    if (ev.type !== 'Results') return;
    const alt = ev.channel?.alternatives?.[0]; if (!alt) return;
    const text = (alt.transcript || '').trim(); if (!text) return;
    const isFinal = ev.is_final === true || ev.speech_final === true;
    isFinal ? onFinal?.(text) : onPartial?.(text);
  });
  dg.on('error', e => onError?.(e));
  dg.on('close', (c,r) => log('[INFO] [Deepgram] closed', c, (r||'').toString?.()||''));
  return { sendPCM16LE(b){open?dg.send(b):q.push(b);}, close(){ try{dg.close();}catch{} } };
}

// ---------- Helpers ----------
function normalizeService(text='') {
  const t = text.toLowerCase();
  if (/\b(both|combo|haircut\s*(?:&|and|\+)\s*beard|haircut\s*\+\s*beard)\b/.test(t)) return 'combo';
  if (/\bbeard( trim|)\b/.test(t)) return 'beard trim';
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return 'haircut';
  return '';
}
function computeEndISO(startISO) {
  try {
    if (!startISO) return '';
    const d = new Date(startISO); if (isNaN(d)) return '';
    return new Date(d.getTime() + 30 * 60 * 1000).toISOString();
  } catch { return ''; }
}
function isReadyToCreate(slots) {
  return Boolean(slots.service && slots.startISO && (slots.endISO || computeEndISO(slots.startISO)) && slots.name && (slots.phone||'').trim());
}
function safeJSON(v, fb={}) { try { return JSON.parse(v); } catch { return fb; } }
function debounceRepeat(convo, text, ms=2500) {
  const now = Date.now(); if (!text) return false;
  if (text === convo._lastTTS && (now - (convo._lastTTSAt||0)) < ms) return true;
  convo._lastTTS = text; convo._lastTTSAt = now; return false;
}
function captureNameMaybe(u) {
  if (!u) return '';
  const t = u.trim();
  const pat = /\b(?:my name is|this is|it'?s|i am|i'm)\s+([A-Za-z][A-Za-z\-']{1,30})(?:\s+([A-Za-z][A-Za-z\-']{1,30}))?/i;
  const m = t.match(pat); if (m) return (m[1] + (m[2] ? ' ' + m[2] : '')).trim();
  if (/^[A-Za-z][A-Za-z\-']{1,30}(?:\s+[A-Za-z][A-Za-z\-']{1,30})?\s*$/.test(t)) {
    if (!/\b(mon|tue|wed|thu|fri|sat|sun|am|pm|\d)\b/i.test(t)) return t;
  }
  const m2 = t.match(/\bfirst name\b.*?\b([A-Z][a-zA-Z\-']{1,30})\b/); if (m2) return m2[1];
  return '';
}
function nextMissingSlot(slots) {
  for (const k of REQUIRED_ORDER) if (!slots[k]) return k;
  return '';
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
- If caller asks about prices/hours/services/location, set intent="FAQ" and faq_topic accordingly. Provide a SHORT reply.
- If caller asks to book, set intent="CREATE". Do not set "ask" to NAME/PHONE until availability is confirmed.
- Map “both/combo/haircut + beard” to service "combo".
- If user gives a specific day/time, fill Start_Time (ISO if obvious; else empty).
- Keep reply short; one sentence; one question max.
- If forbidGreet=true, never greet.
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

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.15,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: `Caller: ${utterance}` }],
      response_format: { type: 'json_object' }
    })
  });
  if (!resp.ok) throw new Error(`OpenAI extract ${resp.status}: ${await resp.text().catch(()=> '')}`);
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  return safeJSON(raw, { intent: 'UNKNOWN', faq_topic: '', ask: 'NONE', reply: '' });
}

// ---------- NLG ----------
async function openAINLG(convo, hint='') {
  const sys = `You are a warm front-desk receptionist. One short natural sentence. One question max. No greeting if forbidGreet=true. <22 words.`;
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
${AGENT_PROMPT}`.trim();

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.25,
      messages: [
        { role: 'system', content: sys },
        { role: 'system', content: ctx },
        { role: 'user', content: `Compose the next sentence. ${hint?('Hint: '+hint):''}` }
      ]
    })
  });
  if (!resp.ok) throw new Error(`OpenAI nlg ${resp.status}: ${await resp.text().catch(()=> '')}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || 'Okay.').trim();
}

// ---------- TTS ----------
async function ttsToTwilio(ws, text, voiceId = ELEVEN_VOICE_ID) {
  if (!text) return;
  const convo = ws.__convo;
  if (debounceRepeat(convo, text)) { log('[DEBUG] [debounce] suppress:', text); return; }

  const streamSid = ws.__streamSid;
  if (!streamSid || !ELEVEN_API_KEY) { log('[WARN] [TTS] missing streamSid or ELEVEN_API_KEY'); return; }

  // queue if speaking
  if (convo.isSpeaking) { convo.ttsQueue.push(text); return; }
  convo.isSpeaking = true;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'xi-api-key': ELEVEN_API_KEY, 'Accept': 'audio/wav', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_settings: { stability: 0.5, similarity_boost: 0.8 }, generation_config: { chunk_length_schedule: [120,160,200,240] } })
    });
  } catch (e) { log('[ERROR] [TTS fetch]', e.message); convo.isSpeaking = false; return; }

  if (!resp.ok) { log('[ERROR] [TTS HTTP]', resp.status, await resp.text().catch(()=>'')); convo.isSpeaking = false; return; }

  log('[INFO] [TTS ->]', text);
  const reader = resp.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      const b64 = Buffer.from(value).toString('base64');
      safeSend(ws, JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
    }
  } finally {
    safeSend(ws, JSON.stringify({ event: 'mark', streamSid, mark: { name: 'eos' } }));
    convo.lastSpeechEndedAt = Date.now();
    convo.isSpeaking = false;
    log('[INFO] [TTS end] bytes:', total);
    const next = convo.ttsQueue.shift(); if (next) ttsToTwilio(ws, next, voiceId);
  }
}

function safeSend(ws, data) { try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch {} }
function twilioSay(ws, text) { return ttsToTwilio(ws, text); }

// ---------- Flow control ----------
function ensureReplyOrAsk(parsed, utterance, phase) {
  // ensure minimum reply if model stays silent
  if (parsed.reply && parsed.reply.trim()) return parsed;

  const svcU = normalizeService(utterance);
  if ((parsed.intent === 'CREATE' || phase === 'collect_time')) {
    const svc = parsed.service || normalizeService(parsed.Event_Name) || svcU;
    if (svc && phase !== 'confirm_booking') { parsed.reply = `Got it — ${svc}. What date and time work for you?`; parsed.ask='TIME'; return parsed; }
  }
  if (parsed.intent === 'FAQ' && parsed.faq_topic) { parsed.reply = 'Anything else I can help with?'; parsed.ask='NONE'; return parsed; }
  parsed.reply = 'Got it. How can I help further?'; parsed.ask='NONE'; return parsed;
}

function setSlotOnce(convo, key, value) {
  if (!value) return false;
  if (!convo.slots[key]) { convo.slots[key] = value; log(`[INFO] [slot] set ${key}=`, value); return true; }
  if (convo.slots[key] !== value) { // allow change if user corrects
    convo.slots[key] = value; log(`[INFO] [slot] updated ${key}=`, value); return true;
  }
  return false;
}

async function onUserUtterance(ws, utterance) {
  const convo = ws.__convo; if (!convo) return;
  const raw = utterance.trim();
  log('[INFO] [USER]', raw);

  // Rude/banter deflection
  if (RUDE_RX.test(raw)) {
    const nm = nextMissingSlot(convo.slots);
    const steer = nm==='service' ? 'Which service would you like, haircut, beard trim, or the combo?' :
                 nm==='startISO' ? 'What date and time work for you?' :
                 nm==='name'     ? 'What name should I put on the booking?' :
                 nm==='phone'    ? 'What phone number should I use for confirmations?' :
                 'How can I help further?';
    await twilioSay(ws, `I’m here to help. ${steer}`);
    return;
  }

  // Extract semantics
  let parsed = {};
  try { parsed = await openAIExtract(raw, convo); }
  catch (e) { log('[ERROR] [extract]', e.message); parsed = { intent:'UNKNOWN', ask:'NONE', reply:'' }; }

  // YES after FAQ → coerce to CREATE
  if (YES_RX.test(raw) && (convo.phase === 'faq' || parsed.intent === 'FAQ' || convo.lastFaqTopic)) {
    parsed.intent = 'CREATE';
    if (!convo.slots.service) parsed.ask = 'SERVICE';
    parsed.reply = '';
    log('[DEBUG] [coerce] YES → CREATE');
  }

  parsed = ensureReplyOrAsk(parsed, raw, convo.phase);

  // Merge slots (sticky)
  const svc = parsed.service || normalizeService(parsed.Event_Name) || normalizeService(raw);
  if (svc) setSlotOnce(convo, 'service', svc);
  if (parsed.Start_Time) setSlotOnce(convo, 'startISO', parsed.Start_Time);
  if (!convo.slots.endISO && parsed.End_Time) setSlotOnce(convo, 'endISO', parsed.End_Time);
  if (convo.slots.startISO && !convo.slots.endISO) setSlotOnce(convo, 'endISO', computeEndISO(convo.slots.startISO));
  if (parsed.Customer_Name) setSlotOnce(convo, 'name', parsed.Customer_Name);
  if (parsed.Customer_Phone) setSlotOnce(convo, 'phone', parsed.Customer_Phone);
  if (parsed.Customer_Email) setSlotOnce(convo, 'email', parsed.Customer_Email);

  // Name capture from free-form
  if (!convo.slots.name) {
    const maybe = captureNameMaybe(raw);
    if (maybe) {
      setSlotOnce(convo, 'name', maybe);
      convo.lastAsk='CONFIRM_NAME'; convo.lastAskAt=Date.now();
      await twilioSay(ws, `Did I get your name as ${maybe}?`);
      return;
    }
  } else if (convo.lastAsk === 'CONFIRM_NAME') {
    if (NO_RX.test(raw)) { convo.slots.name=''; await twilioSay(ws, 'Sorry about that — what name should I use?'); return; }
    if (YES_RX.test(raw)) { convo.lastAsk='NONE'; }
  }

  // PHASE — never regress; never ask for already-filled slots
  if (parsed.intent === 'FAQ') {
    convo.phase = 'faq';
    convo.lastFaqTopic = String(parsed.faq_topic || '').toUpperCase();
  } else if (parsed.intent === 'CREATE' || convo.phase.startsWith('collect') || convo.phase==='idle' || convo.phase==='faq') {
    const missing = nextMissingSlot(convo.slots);
    if (missing === 'service')       convo.phase = 'collect_service';
    else if (missing === 'startISO') convo.phase = 'collect_time';
    else if (missing === 'name')     convo.phase = 'collect_contact';
    else if (missing === 'phone')    convo.phase = 'collect_contact';
    else                             convo.phase = 'confirm_booking';
  }

  // READY? → finalize
  if (convo.phase === 'confirm_booking' && isReadyToCreate(convo.slots)) {
    await finalizeCreate(ws, convo);
    return;
  }

  // Build the next line to say
  let line = '';

  // Static FAQ if applicable
  if (parsed.intent === 'FAQ' && parsed.faq_topic) {
    const topic = String(parsed.faq_topic || '').toUpperCase();
    if (STATIC_FAQ[topic]) line = `${STATIC_FAQ[topic]} Would you like to book an appointment?`;
  }

  // If still empty, pick the precise next ask based on missing slot
  if (!line) {
    const missing = nextMissingSlot(convo.slots);
    if (missing === 'service')       line = 'What service would you like — a haircut, beard trim, or the combo?';
    else if (missing === 'startISO') line = `What date and time work for your ${convo.slots.service || 'appointment'}?`;
    else if (missing === 'name')     line = 'What name should I put on the booking?';
    else if (missing === 'phone') {
      if (!convo.slots.phone && convo.callerPhone) {
        line = `Can I use ${convo.callerPhone} for confirmations?`;
      } else {
        line = 'What phone number should I use for confirmations?';
      }
    } else {
      // fallback to NLG if we somehow got here
      try { line = (parsed.reply||'').trim() || await openAINLG({ ...convo, forbidGreet:true }); }
      catch { line = 'Okay.'; }
    }
  }

  // Anti-repeat: if we asked the same thing seconds ago, rephrase
  const now = Date.now();
  if (line && convo.lastAsk !== 'NONE') {
    if ((now - convo.lastAskAt) < 2500) {
      try { line = await openAINLG({ ...convo, forbidGreet:true }, 'Re-ask naturally without repeating exact words.'); } catch {}
    }
  }

  // Track last ask from our chosen line
  const missingNow = nextMissingSlot(convo.slots);
  convo.lastAsk = missingNow ? missingNow.toUpperCase() : 'NONE';
  convo.lastAskAt = now;

  convo.turns += 1;
  convo.forbidGreet = true;
  await twilioSay(ws, line);
}

async function finalizeCreate(ws, convo) {
  if (!convo.slots.endISO && convo.slots.startISO) convo.slots.endISO = computeEndISO(convo.slots.startISO);
  if (!convo.slots.phone && convo.callerPhone) convo.slots.phone = convo.callerPhone;

  const payload = {
    Event_Name:    convo.slots.service || 'Appointment',
    Start_Time:    convo.slots.startISO || '',
    End_Time:      convo.slots.endISO || computeEndISO(convo.slots.startISO || ''),
    Customer_Name: convo.slots.name || '',
    Customer_Phone:convo.slots.phone || '',
    Customer_Email:convo.slots.email || '',
    Notes: `Booked by phone agent. CallSid=${convo.callSid || ''}`
  };
  log('[INFO] [CREATE payload]', payload);

  try {
    const r = await fetch(MAKE_CREATE_URL, {
      method: 'POST', agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) log('[WARN] [Make CREATE]', r.status, await r.text().catch(()=> ''));
    else log('[INFO] [Make CREATE] ok');
  } catch (e) { log('[ERROR] [Make CREATE]', e.message); }

  const confirm = `You’re set for a ${payload.Event_Name} on ${payload.Start_Time}. Thanks for calling Old Line Barbershop.`;
  await twilioSay(ws, confirm);
  convo.phase = 'done';
}

// ---------- FAQ webhook ----------
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
  const id = randomUUID(); ws.__id = id;

  // Deepgram pipe
  let dg = null, frameCount = 0, dgOpened = false;
  const BATCH_FRAMES = 5; // ~100ms
  let pendingULaw = [];

  ws.on('error', (e) => log('[ERROR] WS', e.message));
  ws.on('close', () => { try { dg?.close(); } catch{}; convoMap.delete(ws.__id); log('[INFO] WS closed'); });

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const evt = msg.event;

    if (evt === 'start') {
      const callSid   = msg?.start?.callSid || '';
      const from      = msg?.start?.customParameters?.from || msg?.start?.from || '';
      const streamSid = msg?.start?.streamSid || '';
      const convo = newConvo(callSid, biz);
      ws.__convo = convo; ws.__streamSid = streamSid; convo.callerPhone = from || ''; convoMap.set(ws.__id, convo);

      log('[INFO] WS CONNECTED | CallSid:', callSid, '| streamSid:', streamSid, '| biz:', biz);
      log('[INFO] [agent prompt 120]:', (AGENT_PROMPT||'').slice(0,120), '…');

      if (DEEPGRAM_API_KEY) {
        dg = startDeepgramLinear16({
          onOpen: () => { dgOpened = true; log('[INFO] [ASR] Deepgram open'); },
          onPartial: () => {},
          onFinal: (t) => handleASRFinal(ws, t),
          onError: (e) => log('[ERROR] [Deepgram]', e?.message || e),
          onAnyMessage: (ev) => { if (ev.type && ev.type!=='Results') log('[DEBUG] [DG msg]', ev.type); }
        });
        setTimeout(()=> { if (!dgOpened) log('[WARN] (!) Deepgram connected but no transcripts yet'); }, 4000);
      } else {
        log('[WARN] No DEEPGRAM_API_KEY — ASR disabled');
      }

      convo.turns = 0; convo.forbidGreet = false;
      await twilioSay(ws, 'Hi, thanks for calling Old Line Barbershop. How can I help you today?');
      return;
    }

    if (evt === 'media') {
      frameCount++; if (frameCount % 50 === 1) log('[DEBUG] [media] frames:', frameCount);
      const b64 = msg.media?.payload || ''; if (!b64) return;
      if (dg) {
        const ulaw = Buffer.from(b64, 'base64');
        pendingULaw.push(ulaw);
        if (pendingULaw.length >= BATCH_FRAMES) {
          const ulawChunk = Buffer.concat(pendingULaw);
          const pcm16le   = ulawBufferToPCM16LEBuffer(ulawChunk);
          try { dg.sendPCM16LE(pcm16le); } catch(e){ log('[ERROR] [media→DG]', e?.message||e); }
          pendingULaw = [];
        }
      }
      return;
    }

    if (evt === 'mark') return;

    if (evt === 'stop') {
      log('[INFO] Twilio stream STOP');
      if (pendingULaw.length && dg) {
        try { dg.sendPCM16LE(ulawBufferToPCM16LEBuffer(Buffer.concat(pendingULaw))); } catch {}
        pendingULaw = [];
      }
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    if (evt === 'asr') { const final = msg?.text || ''; if (final) handleASRFinal(ws, final); return; }
  });
});

// ---------- Speaking gate + ASR final ----------
function handleASRFinal(ws, text) {
  const convo = ws.__convo; if (!convo) return;
  const norm = (text||'').trim(); if (!norm) return;
  if (convo.isSpeaking) return;
  if (Date.now() - convo.lastSpeechEndedAt < 300) return;
  if (norm === convo.lastUserFinal) return; // de-dup
  convo.lastUserFinal = norm;
  log('[INFO] [ASR final]', norm);
  onUserUtterance(ws, norm).catch(e => log('[ERROR] [onUserUtterance]', e.message));
}

// ---------- Start ----------
server.listen(PORT, () => log('[INFO] Server running on', PORT));
