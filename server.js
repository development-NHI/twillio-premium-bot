/**
 * server.js — Old Line Barbershop voice agent (LOW-LATENCY + DEEP DEBUG)
 * - Twilio Media Streams WS
 * - Deepgram ASR (URL-config WS; μ-law → PCM16LE @ 8kHz mono)
 * - OpenAI for extraction + NLG (JSON contract)
 * - ElevenLabs TTS (ulaw_8000 streaming; includes streamSid on frames)
 * - Make.com webhooks (FAQ log + CREATE booking)
 *
 * Env (Render):
 *  PORT
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVEN_API_KEY
 *  ELEVEN_VOICE_ID
 *  MAKE_CREATE
 *  MAKE_READ
 *  AGENT_PROMPT (optional)
 *
 * Debug/Perf:
 *  LOG_LEVEL=debug|info|warn|error   (default: info)
 *  DEBUG_FRAMES=1                    (log every media batch; default logs every 25th frame)
 *  DG_ENDPOINTING_MS=150             (finalization speed; lower = faster)
 *  BATCH_FRAMES=3                    (μ-law frames per batch → Deepgram; 3 ≈ 60ms)
 *  ELEVEN_LATENCY=4                  (0–4; 4 = lowest latency)
 *  TRACE_IDS=1                       (prefix each log line with call trace id)
 *  AUDIO_DUMP=1                      (write small ulaw/pcm snippets to /tmp)
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
const { randomUUID, randomBytes } = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------- Logger ----------------
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOGNUM = LEVELS[LOG_LEVEL] ?? LEVELS.info;
const WITH_TRACE = !!Number(process.env.TRACE_IDS || 0);

function mkLogger(prefix = '') {
  const fmt = (lvl, args, trace) => {
    const ts = new Date().toISOString();
    const tag = `[${lvl.toUpperCase()}]`;
    const pfx = prefix ? ` ${prefix}` : '';
    const tr = trace ? ` ${trace}` : '';
    console.log(ts, '-', tag + pfx + tr, '-', ...args);
  };
  return {
    debug: (...a) => (LEVELS.debug >= LOGNUM) && fmt('debug', a),
    info:  (...a) => (LEVELS.info  >= LOGNUM) && fmt('info',  a),
    warn:  (...a) => (LEVELS.warn  >= LOGNUM) && fmt('warn',  a),
    error: (...a) => (LEVELS.error >= LOGNUM) && fmt('error', a),
    span(label) {
      const t0 = process.hrtime.bigint();
      return {
        end(ok = true, extra = '') {
          const ns = Number(process.hrtime.bigint() - t0);
          const ms = (ns / 1e6).toFixed(1);
          const lvl = ok ? 'debug' : 'warn';
          if (LEVELS[lvl] >= LOGNUM) fmt(lvl, [`[${label}] ${ms} ms ${extra}`]);
          return ms;
        }
      };
    }
  };
}
const log = mkLogger();

// ---------------- Config / Globals ----------------
const PORT = process.env.PORT || 10000;

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY || '';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const ELEVEN_API_KEY   = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID  = process.env.ELEVEN_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';

const MAKE_CREATE_URL  = process.env.MAKE_CREATE || '';
const MAKE_FAQ_URL     = process.env.MAKE_READ || '';

const DG_ENDPOINTING_MS = Number(process.env.DG_ENDPOINTING_MS || 150);
const BATCH_FRAMES      = Number(process.env.BATCH_FRAMES || 3);
const ELEVEN_LATENCY    = Number(process.env.ELEVEN_LATENCY || 4);
const DEBUG_FRAMES      = Number(process.env.DEBUG_FRAMES || 0);
const AUDIO_DUMP        = !!Number(process.env.AUDIO_DUMP || 0);

// keep-alive to shave TLS setup
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

// env summary (redacted)
(function envSummary() {
  const redact = (s) => (s ? s.slice(0, 4) + '…' + s.slice(-4) : '(missing)');
  log.info('Env summary',
    { OPENAI: !!OPENAI_API_KEY, DG: !!DEEPGRAM_API_KEY, ELEVEN: !!ELEVEN_API_KEY,
      ELEVEN_VOICE_ID,
      MAKE_CREATE: !!MAKE_CREATE_URL, MAKE_READ: !!MAKE_FAQ_URL,
      DG_ENDPOINTING_MS, BATCH_FRAMES, ELEVEN_LATENCY, LOG_LEVEL });
})();

// ---------------- Express HTTP (health) ----------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------------- WS Server (Twilio Media Streams) ----------------
const wss = new WebSocket.Server({ server });

// ---------------- Agent Prompt ----------------
const DEFAULT_AGENT_PROMPT = `
You are a friendly, human-sounding AI receptionist for Old Line Barbershop.
[trimmed for brevity — identical to previous working version]
`.trim();
const AGENT_PROMPT = (process.env.AGENT_PROMPT || DEFAULT_AGENT_PROMPT);

// ---------------- State ----------------
const convoMap = new Map();
function newConvo(callSid, biz) {
  return {
    id: randomUUID(),
    callSid, biz,
    turns: 0,
    lastTTS: '', lastTTSAt: 0,
    forbidGreet: false,
    phase: 'idle',
    callerPhone: '',
    asrText: '',
    // live metrics
    metrics: {
      framesRx: 0, batchesTx: 0, ulawBytes: 0, pcmBytes: 0,
      dgPartials: 0, dgFinals: 0, ttsBytes: 0,
      tFirstDGPartialMs: null, tFirstDGFinalMs: null,
      tStartMs: Date.now()
    },
    // slots
    slots: { service: '', startISO: '', endISO: '', name: '', phone: '', email: '' }
  };
}

// ---------------- μ-law → PCM16LE ----------------
function ulawByteToPcm16(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << (exponent + 2)) - 0x84 * 4;
  return sign ? -sample : sample;
}
function ulawBufferToPCM16LEBuffer(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i * 2);
  return out;
}

// ---------------- Deepgram realtime ----------------
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  const url =
    'wss://api.deepgram.com/v1/listen'
    + '?encoding=linear16&sample_rate=8000&channels=1'
    + '&model=nova-2-phonecall&interim_results=true&smart_format=true'
    + '&language=en-US'
    + `&endpointing=${DG_ENDPOINTING_MS}`
    + '&vad_events=true';

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
    const text = (alt?.transcript || '').trim();
    if (!text) return;
    (ev.is_final || ev.speech_final) ? onFinal?.(text) : onPartial?.(text);
  });
  dg.on('error', (e) => onError?.(e));
  dg.on('close', (c, r) => log.info('[ASR] Deepgram closed', c, (r||'').toString?.() || ''));

  return {
    sendPCM16LE(buf) { open ? dg.send(buf) : q.push(buf); },
    close() { try { dg.close(); } catch {} }
  };
}

// ---------------- Utils ----------------
function normalizeService(text) {
  if (!text) return '';
  const t = text.toLowerCase();
  if (/\b(both|combo|combo package|haircut\s*(?:&|and|\+)\s*beard|haircut\s*\+\s*beard)\b/.test(t)) return 'combo';
  if (/\bbeard( trim|)\b/.test(t)) return 'beard trim';
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return 'haircut';
  return '';
}
function computeEndISO(startISO) {
  try { if (!startISO) return ''; const d = new Date(startISO);
    if (isNaN(d)) return ''; return new Date(d.getTime() + 30*60*1000).toISOString();
  } catch { return ''; }
}
function isReadyToCreate(slots) {
  return Boolean(slots.service && slots.startISO && (slots.endISO || computeEndISO(slots.startISO)) && slots.name && (slots.phone||'').trim());
}
function safeJSON(val, fallback = {}) { try { return JSON.parse(val); } catch { return fallback; } }
function debounceRepeat(convo, text, ms = 2000) {
  const now = Date.now(); if (!text) return false;
  if (text === convo.lastTTS && (now - convo.lastTTSAt) < ms) return true;
  convo.lastTTS = text; convo.lastTTSAt = now; return false;
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------- OpenAI (extract) ----------------
async function openAIExtract(utterance, convo, trace='') {
  const span = log.span(`${trace} OpenAI.extract`);
  const sys = [
`Return a strict JSON object with fields:
{"intent":"FAQ"|"CREATE"|"READ"|"CANCEL"|"RESCHEDULE"|"SMALLTALK"|"UNKNOWN","faq_topic":"HOURS"|"PRICES"|"SERVICES"|"LOCATION"|"","Event_Name":"","Start_Time":"","End_Time":"","Customer_Name":"","Customer_Phone":"","Customer_Email":"","window":{"start":"","end":""},"ask":"NONE"|"SERVICE"|"TIME"|"NAME"|"PHONE"|"CONFIRM","reply":""}
Rules:
- Map “how much / price / cost” → intent="FAQ", faq_topic="PRICES".
- If booking intent, set intent="CREATE". Do not ask NAME/PHONE until time is confirmed.
- Treat “both/combo/haircut + beard” as service="combo".
- Keep reply short, one question max.
- Respect forbidGreet=true.`,
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

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: `Caller: ${utterance}` }],
      response_format: { type: 'json_object' }
    }),
    timeout: 9000
  });
  const ok = resp.ok;
  const body = ok ? await resp.json() : await resp.text().catch(()=> '');
  span.end(ok, ok ? '' : `HTTP ${resp.status}`);
  if (!ok) throw new Error(`OpenAI extract ${resp.status}: ${body}`);
  const raw = body.choices?.[0]?.message?.content || '{}';
  const parsed = safeJSON(raw, { intent: 'UNKNOWN', ask: 'NONE', reply: '' });
  log.debug(`${trace} [extract JSON]`, parsed);
  return parsed;
}

function ensureReplyOrAsk(parsed, utterance, phase) {
  const svcU = normalizeService(utterance);
  if (svcU && !parsed.service && !parsed.Event_Name) { parsed.service = svcU; parsed.Event_Name = svcU; }
  if (parsed.reply && parsed.reply.trim()) return parsed;
  if ((parsed.intent === 'CREATE' || phase === 'collect_time')) {
    const svc = parsed.service || normalizeService(parsed.Event_Name) || svcU;
    if (svc && phase !== 'confirm_booking') { parsed.reply = `Got it—${svc}. What date and time work for you?`; parsed.ask = 'TIME'; return parsed; }
  }
  if (parsed.intent === 'FAQ' && parsed.faq_topic) { parsed.reply = 'Happy to help. Anything else I can answer?'; parsed.ask = 'NONE'; return parsed; }
  parsed.reply = 'Got it. How can I help further?'; parsed.ask = 'NONE'; return parsed;
}

// ---------------- NLG ----------------
async function openAINLG(convo, promptHints = '', trace='') {
  const span = log.span(`${trace} OpenAI.nlg`);
  const sys = `
You are a warm front-desk receptionist.
Write ONE short, conversational sentence next.
Use contractions and micro-acks. One question max.
No greetings if forbidGreet=true. < 22 words. Be specific.
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

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: sys },
        { role: 'system', content: ctx },
        { role: 'user', content: `Compose the next thing to say.${promptHints ? ' Hint: ' + promptHints : ''}` }
      ]
    }),
    timeout: 9000
  });
  const ok = resp.ok;
  const body = ok ? await resp.json() : await resp.text().catch(()=> '');
  span.end(ok, ok ? '' : `HTTP ${resp.status}`);
  if (!ok) throw new Error(`OpenAI nlg ${resp.status}: ${body}`);
  const text = (body.choices?.[0]?.message?.content || 'Okay.').trim();
  log.debug(`${trace} [nlg ->]`, text);
  return text;
}

// ---------------- TTS (ElevenLabs) -> Twilio media frames ----------------
async function ttsToTwilio(ws, text, trace='') {
  if (!text) return;
  const convo = ws.__convo || {};
  if (debounceRepeat(convo, text)) { log.debug(`${trace} [debounce]`, text); return; }

  const streamSid = ws.__streamSid;
  if (!streamSid) { log.warn(`${trace} [TTS] missing streamSid; cannot send audio`); return; }
  if (!ELEVEN_API_KEY) { log.warn(`${trace} [TTS] ELEVEN_API_KEY missing; skipping audio`); return; }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?optimize_streaming_latency=${ELEVEN_LATENCY}&output_format=ulaw_8000`;

  const span = log.span(`${trace} Eleven.stream`);
  const resp = await fetch(url, {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: { 'xi-api-key': ELEVEN_API_KEY, 'Accept': 'audio/wav', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.45, similarity_boost: 0.8 },
      generation_config: { chunk_length_schedule: [80, 120, 160] }
    }),
    timeout: 15000
  });
  if (!resp.ok) { span.end(false, `HTTP ${resp.status}`); log.warn(`${trace} [TTS] HTTP`, resp.status, await resp.text().catch(()=>'')); return; }

  const reader = resp.body.getReader();
  let total = 0, chunks = 0;
  log.info(`${trace} [TTS ->]`, text);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length; chunks++;
    const b64 = Buffer.from(value).toString('base64');
    safeSend(ws, JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
  }
  safeSend(ws, JSON.stringify({ event: 'mark', streamSid, mark: { name: 'eos' } }));
  span.end(true, `bytes=${total}, chunks=${chunks}`);
  convo.metrics.ttsBytes += total;
}

// ---------------- ASR final hook ----------------
function handleASRFinal(ws, text) {
  const convo = ws.__convo; if (!convo) return;
  const trace = ws.__trace || '';
  const m = convo.metrics;
  if (m.tFirstDGFinalMs == null) m.tFirstDGFinalMs = Date.now() - m.tStartMs;
  m.dgFinals++;
  log.info(`${trace} [ASR final]`, text);
  onUserUtterance(ws, text, trace).catch(err => log.error(`${trace} [onUserUtterance]`, err.message));
}

// ---------------- Twilio helpers ----------------
function safeSend(ws, data) { try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch (e) { /* ignore */ } }
function twilioSay(ws, text, trace='') { return ttsToTwilio(ws, text, trace); }

// ---------------- Flow Orchestration ----------------
async function onUserUtterance(ws, utterance, trace='') {
  const convo = ws.__convo; if (!convo) return;
  let parsed = {};
  try {
    parsed = await openAIExtract(utterance, convo, trace);
  } catch (e) {
    log.warn(`${trace} [OpenAI extract]`, e.message);
    parsed = { intent: 'UNKNOWN', ask: 'NONE', reply: '' };
  }
  parsed = ensureReplyOrAsk(parsed, utterance, convo.phase);

  if (parsed.service || parsed.Event_Name) {
    const svc = parsed.service || normalizeService(parsed.Event_Name);
    if (svc) convo.slots.service = svc;
  }
  if (parsed.Start_Time) convo.slots.startISO = parsed.Start_Time;
  if (!convo.slots.endISO && parsed.End_Time) convo.slots.endISO = parsed.End_Time;
  if (!convo.slots.endISO && convo.slots.startISO) convo.slots.endISO = computeEndISO(convo.slots.startISO);
  if (parsed.Customer_Name) convo.slots.name = parsed.Customer_Name;
  if (parsed.Customer_Phone) convo.slots.phone = parsed.Customer_Phone;
  if (parsed.Customer_Email) convo.slots.email = parsed.Customer_Email;

  const ask = parsed.ask || 'NONE';
  if (parsed.intent === 'FAQ')      convo.phase = 'faq';
  else if (parsed.intent === 'CREATE') {
    if      (!convo.slots.service)                                     convo.phase = 'collect_service';
    else if (!convo.slots.startISO)                                    convo.phase = 'collect_time';
    else if (!convo.slots.name || !(convo.slots.phone || convo.callerPhone)) convo.phase = 'collect_contact';
    else                                                                convo.phase = 'confirm_booking';
  }

  if (parsed.intent === 'FAQ' && MAKE_FAQ_URL) postToMakeFAQ(parsed.faq_topic).catch(()=>{});

  if (convo.phase === 'confirm_booking' && isReadyToCreate(convo.slots)) {
    await finalizeCreate(ws, convo, trace);
    return;
  }

  let line = (parsed.reply || '').trim();
  if (!convo.slots.phone && convo.callerPhone && (ask === 'PHONE' || convo.phase === 'collect_contact')) {
    line = await openAINLG({ ...convo, forbidGreet: true }, `Confirm this phone number is okay to use: ${convo.callerPhone}`, trace);
  } else if (!line) {
    line = await openAINLG({ ...convo, forbidGreet: true }, '', trace);
  }

  convo.turns += 1; convo.forbidGreet = true;
  await twilioSay(ws, line, trace);
}

async function finalizeCreate(ws, convo, trace='') {
  if (!convo.slots.endISO && convo.slots.startISO) convo.slots.endISO = computeEndISO(convo.slots.startISO);
  if (!convo.slots.phone && convo.callerPhone)     convo.slots.phone = convo.callerPhone;

  const payload = {
    Event_Name:     convo.slots.service || 'Appointment',
    Start_Time:     convo.slots.startISO || '',
    End_Time:       convo.slots.endISO || computeEndISO(convo.slots.startISO || ''),
    Customer_Name:  convo.slots.name || '',
    Customer_Phone: convo.slots.phone || '',
    Customer_Email: convo.slots.email || '',
    Notes:          `Booked by phone agent. CallSid=${convo.callSid || ''}`
  };

  if (MAKE_CREATE_URL) {
    const span = log.span(`${trace} Make.create`);
    try {
      const r = await fetch(MAKE_CREATE_URL, {
        method: 'POST',
        agent: keepAliveHttpsAgent,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 10000
      });
      const ok = r.ok;
      const body = ok ? '' : await r.text().catch(()=> '');
      span.end(ok, ok ? '' : `HTTP ${r.status}`);
      if (!ok) log.warn(`${trace} [Make CREATE] non-200`, r.status, body); else log.info(`${trace} [Make CREATE] ok`);
    } catch (e) {
      span.end(false, e.message); log.warn(`${trace} [Make CREATE]`, e.message);
    }
  }

  const confirmLine = await openAINLG(
    { ...convo, forbidGreet: true, phase: 'done' },
    `Confirm booking and say goodbye. Service=${convo.slots.service}, start=${convo.slots.startISO}`,
    trace
  );
  await twilioSay(ws, confirmLine, trace);
}

async function postToMakeFAQ(topic) {
  if (!MAKE_FAQ_URL) return;
  const span = log.span('Make.faq');
  try {
    const r = await fetch(MAKE_FAQ_URL, {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'FAQ', topic: topic || '' }),
      timeout: 4000
    });
    span.end(r.ok, r.ok ? '' : `HTTP ${r.status}`);
  } catch (e) {
    span.end(false, e.message);
  }
}

// ---------------- WS Handlers ----------------
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const biz = params.get('biz') || 'acme-001';
  const id = randomUUID();
  const trace = WITH_TRACE ? `[${id.slice(0,8)}]` : '';
  ws.__id = id; ws.__trace = trace;

  // Deepgram pipe state
  let dg = null, dgOpened = false, frameCount = 0;
  let pendingULaw = [];

  const l = mkLogger(trace);

  ws.on('error', (err) => l.error('WS error', err.message));
  ws.on('close', () => {
    try { dg?.close(); } catch {}
    const c = ws.__convo; if (c) {
      const m = c.metrics;
      l.info('WS closed | metrics', {
        framesRx: m.framesRx, batchesTx: m.batchesTx,
        ulawKB: (m.ulawBytes/1024).toFixed(1), pcmKB: (m.pcmBytes/1024).toFixed(1),
        dgPartials: m.dgPartials, dgFinals: m.dgFinals,
        tFirstPartialMs: m.tFirstDGPartialMs, tFirstFinalMs: m.tFirstDGFinalMs,
        ttsKB: (m.ttsBytes/1024).toFixed(1),
        durationMs: Date.now() - m.tStartMs
      });
    }
    convoMap.delete(ws.__id);
  });

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const evt = msg.event;

    if (evt === 'start') {
      const callSid   = msg?.start?.callSid || '';
      const from      = msg?.start?.customParameters?.from || msg?.start?.from || '';
      const streamSid = msg?.start?.streamSid || '';
      const convo = newConvo(callSid, biz);
      ws.__convo = convo; ws.__streamSid = streamSid; convo.callerPhone = from || '';
      convoMap.set(ws.__id, convo);
      l.info('WS CONNECTED | CallSid:', callSid, '| streamSid:', streamSid, '| biz:', biz);
      l.info('[agent] Using AGENT_PROMPT (first 120 chars):', (AGENT_PROMPT||'').slice(0,120), '…');

      if (DEEPGRAM_API_KEY) {
        dg = startDeepgramLinear16({
          onOpen: () => l.info('[ASR] Deepgram open'),
          onPartial: (t) => {
            const m = convo.metrics; m.dgPartials++; if (m.tFirstDGPartialMs == null) m.tFirstDGPartialMs = Date.now() - m.tStartMs;
            if (DEBUG_FRAMES) l.debug('[partial]', t);
            if (!dgOpened) { dgOpened = true; l.info('[ASR] ready'); }
          },
          onFinal:   (t) => { if (!dgOpened) { dgOpened = true; l.info('[ASR] ready'); } handleASRFinal(ws, t); },
          onError:   (e) => l.warn('[ASR] error', e?.message || e),
          onAnyMessage: (ev) => { if (ev.type && ev.type !== 'Results' && LOGNUM <= LEVELS.debug) l.debug('[ASR msg]', ev.type); }
        });
        setTimeout(() => { if (!dgOpened) l.warn('(!) Deepgram connected but no transcripts yet'); }, 4000);
      } else {
        l.warn('(!) No DEEPGRAM_API_KEY — ASR disabled');
      }

      // Greeting
      convo.turns = 0; convo.forbidGreet = false;
      twilioSay(ws, 'Hi, thanks for calling Old Line Barbershop. How can I help you today?', trace).catch(()=>{});
      return;
    }

    if (evt === 'media') {
      frameCount++; const m = ws.__convo?.metrics; if (m) m.framesRx++;
      const b64 = msg.media?.payload || '';
      if (!b64 || !dg) return;

      const ulaw = Buffer.from(b64, 'base64');
      if (m) m.ulawBytes += ulaw.length;
      pendingULaw.push(ulaw);

      if (DEBUG_FRAMES || frameCount % 25 === 1) l.debug('[media] frames:', frameCount, 'batchQLen:', pendingULaw.length, 'ulawB:', ulaw.length);

      if (pendingULaw.length >= BATCH_FRAMES) {
        const ulawChunk = Buffer.concat(pendingULaw); pendingULaw = [];
        const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
        if (m) { m.pcmBytes += pcm16le.length; m.batchesTx++; }
        try { dg.sendPCM16LE(pcm16le); }
        catch (e) { l.warn('[media→DG] send error:', e?.message || e); }

        if (AUDIO_DUMP && frameCount < 400) { // only dump a little
          try {
            const base = `/tmp/${ws.__convo?.callSid || ws.__id}`;
            fs.writeFileSync(`${base}.ulaw`, ulawChunk, { flag: 'a' });
            fs.writeFileSync(`${base}.pcm`, pcm16le,   { flag: 'a' });
          } catch {}
        }
      }
      return;
    }

    if (evt === 'mark') { l.debug('[mark]', msg?.mark?.name || ''); return; }

    if (evt === 'stop') {
      l.info('Twilio stream STOP');
      if (pendingULaw.length && dg) {
        try {
          const ulawChunk = Buffer.concat(pendingULaw);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          dg.sendPCM16LE(pcm16le);
          const m = ws.__convo?.metrics; if (m) { m.pcmBytes += pcm16le.length; m.ulawBytes += ulawChunk.length; }
        } catch {}
        pendingULaw = [];
      }
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    // optional synthetic ASR passthrough
    if (evt === 'asr') { const final = msg?.text || ''; if (final) handleASRFinal(ws, final); return; }
  });
});

// ---------------- Start server ----------------
server.listen(PORT, () => { log.info('Server running on', PORT); });
