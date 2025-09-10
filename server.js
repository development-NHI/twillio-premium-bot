/**
 * server.js — Old Line Barbershop voice agent (Twilio <-> Deepgram <-> OpenAI <-> ElevenLabs)
 * Ultra-logged build for demo hardening.
 *
 * Env:
 *  PORT
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVEN_API_KEY
 *  ELEVEN_VOICE_ID            (optional; default below)
 *  MAKE_CREATE                (Create webhook)
 *  MAKE_READ                  (FAQ log webhook)
 *  AGENT_PROMPT               (optional)
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const https = require('https');
const fetch = require('node-fetch'); // node-fetch@2, CommonJS compatible

// ---------- Config / Globals ----------
const PORT              = process.env.PORT || 10000;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || '';
const DEEPGRAM_API_KEY  = process.env.DEEPGRAM_API_KEY || '';
const ELEVEN_API_KEY    = process.env.ELEVEN_API_KEY || '';
const ELEVEN_VOICE_ID   = process.env.ELEVEN_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
const MAKE_CREATE_URL   = process.env.MAKE_CREATE || '';
const MAKE_FAQ_URL      = process.env.MAKE_READ   || '';

const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 15000 });
const log = (lvl, msg, meta={}) => {
  const sMeta = Object.keys(meta).length ? ' | ' + JSON.stringify(meta) : '';
  console.log(`${new Date().toISOString()} - [${lvl}] - ${msg}${sMeta}`);
};

// quick env sanity
if (!OPENAI_API_KEY)   log('WARN', 'OPENAI_API_KEY missing');
if (!DEEPGRAM_API_KEY) log('WARN', 'DEEPGRAM_API_KEY missing (no ASR)');
if (!ELEVEN_API_KEY)   log('WARN', 'ELEVEN_API_KEY missing (no TTS)');

// ---------- HTTP (health) ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------- WS ----------
const wss = new WebSocket.Server({ server });
const convoMap = new Map();

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
`.trim();
const AGENT_PROMPT = process.env.AGENT_PROMPT || DEFAULT_AGENT_PROMPT;

// ---------- Utilities / Slots ----------
const REQUIRED_ORDER = ['service', 'startISO', 'name', 'phone'];
function normalizeService(text='') {
  const t = text.toLowerCase();
  if (/\b(both|combo|haircut\s*(?:&|and|\+)\s*beard|haircut\s*\+\s*beard)\b/.test(t)) return 'combo';
  if (/\bbeard( trim|)\b/.test(t)) return 'beard trim';
  if (/\bhair\s*cut|\bhaircut\b/.test(t)) return 'haircut';
  return '';
}
function computeEndISO(startISO) {
  try { if (!startISO) return ''; const d = new Date(startISO); if (isNaN(d)) return ''; return new Date(d.getTime()+30*60*1000).toISOString(); }
  catch { return ''; }
}
function nextMissing(slots) { for (const k of REQUIRED_ORDER) if (!slots[k]) return k; return ''; }
function safeJSON(v, fb={}) { try { return JSON.parse(v); } catch { return fb; } }
function digitsOnly(s=''){ return s.replace(/[^\d]/g,''); }

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
  for (let i = 0; i < ulawBuf.length; i++) out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]), i*2);
  return out;
}

// ---------- Deepgram realtime (URL-config) ----------
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  const url = 'wss://api.deepgram.com/v1/listen'
    + '?encoding=linear16&sample_rate=8000&channels=1'
    + '&model=nova-2-phonecall&interim_results=true&smart_format=true&language=en-US&endpointing=250';
  const dg = new WebSocket(url, { headers: { Authorization: `token ${DEEPGRAM_API_KEY}` }, perMessageDeflate: false });
  let open = false; const q = [];
  dg.on('open', () => { open = true; log('INFO','[ASR] Deepgram open'); onOpen?.(); while (q.length) dg.send(q.shift()); });
  dg.on('message', (data)=>{
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    if (onAnyMessage) onAnyMessage(ev);
    if (ev.type !== 'Results') return;
    const alt = ev.channel?.alternatives?.[0];
    const text = (alt?.transcript || '').trim();
    if (!text) return;
    if (ev.is_final === true || ev.speech_final === true) onFinal?.(text); else onPartial?.(text);
  });
  dg.on('error', (e)=> { log('ERROR','[ASR] Deepgram error', { msg: e?.message || e }); onError?.(e); });
  dg.on('close', (c,r)=> log('INFO','[ASR] Deepgram closed', { code:c, reason:(r||'').toString?.()||'' }));
  return {
    sendPCM16LE(buf){ if (open) dg.send(buf); else q.push(buf); },
    close(){ try { dg.close(); } catch {} }
  };
}

// ---------- OpenAI ----------
async function openAIExtract(utterance, convo) {
  const sys = [
`Return a strict JSON object with fields:
{"intent":"FAQ"|"CREATE"|"READ"|"CANCEL"|"RESCHEDULE"|"SMALLTALK"|"UNKNOWN","faq_topic":"HOURS"|"PRICES"|"SERVICES"|"LOCATION"|"" ,"Event_Name":"","Start_Time":"","End_Time":"","Customer_Name":"","Customer_Phone":"","Customer_Email":"","window":{"start":"","end":""},"ask":"NONE"|"SERVICE"|"TIME"|"NAME"|"PHONE"|"CONFIRM","reply":""}
Rules:
- If booking intent, don't ask NAME/PHONE until after time is provided.
- Map "both/combo/haircut + beard" to service="combo".
- One concise sentence in reply; one question max; no greeting if forbidGreet=true.`,
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

  log('DEBUG','[OpenAI extract ->]', { sysFirst120: sys.slice(0,120) + '…', utterance });
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    agent: keepAliveHttpsAgent,
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.15,
      messages: [{ role:'system', content: sys }, { role:'user', content:`Caller: ${utterance}` }],
      response_format: { type:'json_object' }
    })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(()=> '');
    log('ERROR','[OpenAI extract HTTP]', { status: resp.status, body: t });
    return { intent:'UNKNOWN', ask:'NONE', reply:'' };
  }
  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  const parsed = safeJSON(raw, { intent:'UNKNOWN', ask:'NONE', reply:'' });
  log('DEBUG','[OpenAI extract <-]', parsed);
  return parsed;
}

async function openAINLG(convo, hint='') {
  const sys = `Warm receptionist. One short sentence. One question max. No greeting if forbidGreet=true. <22 words.`;
  const ctx = `
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
        { role:'system', content: sys },
        { role:'system', content: ctx },
        { role:'user', content: `Compose the next sentence. ${hint?('Hint: '+hint):''}` }
      ]
    })
  });
  if (!resp.ok) {
    const t = await resp.text().catch(()=> '');
    log('ERROR','[OpenAI NLG HTTP]', { status: resp.status, body: t });
    return 'Okay.';
  }
  const data = await resp.json();
  const text = (data.choices?.[0]?.message?.content || 'Okay.').trim();
  log('DEBUG','[OpenAI NLG <-]', { text });
  return text;
}

// ---------- TTS (ElevenLabs -> Twilio) ----------
async function ttsToTwilio(ws, text, voiceId = ELEVEN_VOICE_ID) {
  if (!text) return;
  const convo = ws.__convo || {};
  const streamSid = ws.__streamSid;
  if (!ELEVEN_API_KEY || !streamSid) {
    log('WARN','[TTS] missing ELEVEN_API_KEY or streamSid', { hasKey: !!ELEVEN_API_KEY, streamSid });
    return;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  log('INFO','[TTS ->]', { text });
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      agent: keepAliveHttpsAgent,
      headers: { 'xi-api-key': ELEVEN_API_KEY, 'Accept': 'audio/wav', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        generation_config: { chunk_length_schedule: [120,160,200,240] }
      })
    });
  } catch (e) {
    log('ERROR','[TTS fetch]', { error: e.message });
    return;
  }

  if (!resp.ok) {
    const t = await resp.text().catch(()=> '');
    log('ERROR','[TTS HTTP]', { status: resp.status, body: t });
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
  log('INFO','[TTS end]', { bytes: total });
}

function safeSend(ws, data) { try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch (e) { log('ERROR','[WS send]', { error: e.message }); } }

// ---------- Orchestration ----------
function ensureReplyOrAsk(parsed, utterance, phase) {
  if (parsed.reply && parsed.reply.trim()) return parsed;
  const svcU = normalizeService(utterance);
  if ((parsed.intent === 'CREATE' || phase === 'collect_time')) {
    const svc = parsed.service || normalizeService(parsed.Event_Name) || svcU;
    if (svc && phase !== 'confirm_booking') { parsed.reply = `Got it — ${svc}. What date and time work for you?`; parsed.ask='TIME'; return parsed; }
  }
  if (parsed.intent === 'FAQ' && parsed.faq_topic) { parsed.reply = 'Anything else I can help with?'; parsed.ask='NONE'; return parsed; }
  parsed.reply = 'Got it. How can I help further?'; parsed.ask='NONE'; return parsed;
}

function setSlot(convo, k, v) {
  if (!v) return false;
  if (!convo.slots[k]) { convo.slots[k] = v; log('INFO','[slot set]', { k, v }); return true; }
  if (convo.slots[k] !== v) { const old = convo.slots[k]; convo.slots[k] = v; log('INFO','[slot update]', { k, old, v }); return true; }
  return false;
}

async function onUserUtterance(ws, utterance) {
  const convo = ws.__convo; if (!convo) return;
  const raw = utterance.trim(); if (!raw) return;
  log('INFO','[USER]', { text: raw });

  let parsed = {};
  try { parsed = await openAIExtract(raw, convo); }
  catch (e) { log('ERROR','[extract]', { error: e.message }); parsed = { intent:'UNKNOWN', ask:'NONE', reply:'' }; }

  parsed = ensureReplyOrAsk(parsed, raw, convo.phase);

  // merge slots
  const svc = parsed.service || normalizeService(parsed.Event_Name) || normalizeService(raw);
  if (svc) setSlot(convo, 'service', svc);

  if (parsed.Start_Time) setSlot(convo, 'startISO', parsed.Start_Time);
  if (!convo.slots.endISO && parsed.End_Time) setSlot(convo, 'endISO', parsed.End_Time);
  if (convo.slots.startISO && !convo.slots.endISO) setSlot(convo, 'endISO', computeEndISO(convo.slots.startISO));

  if (parsed.Customer_Name) setSlot(convo, 'name', parsed.Customer_Name);

  // phone: digits or “this number”
  if (parsed.Customer_Phone) setSlot(convo, 'phone', digitsOnly(parsed.Customer_Phone));
  if (!convo.slots.phone && /\b(this number|same number|use my number)\b/i.test(raw) && convo.callerPhone) {
    setSlot(convo, 'phone', digitsOnly(convo.callerPhone).slice(-10));
  }

  if (parsed.Customer_Email) setSlot(convo, 'email', parsed.Customer_Email);

  // phase advancement
  const missing = nextMissing(convo.slots);
  if (parsed.intent === 'FAQ') {
    convo.phase = 'faq';
  } else {
    if (missing === 'service')       convo.phase = 'collect_service';
    else if (missing === 'startISO') convo.phase = 'collect_time';
    else if (missing === 'name')     convo.phase = 'collect_contact';
    else if (missing === 'phone')    convo.phase = 'collect_contact';
    else                             convo.phase = 'confirm_booking';
  }
  log('DEBUG','[phase]', { phase: convo.phase, missing });

  // finalize?
  if (convo.phase === 'confirm_booking' && convo.slots.service && convo.slots.startISO && (convo.slots.name) && (convo.slots.phone)) {
    await finalizeCreate(ws, convo);
    return;
  }

  // craft next line
  let line = (parsed.reply || '').trim();
  if (!line) {
    if (missing === 'service')       line = 'What service would you like — a haircut, beard trim, or the combo?';
    else if (missing === 'startISO') line = `What date and time work for your ${convo.slots.service || 'appointment'}?`;
    else if (missing === 'name')     line = 'What name should I put on the booking?';
    else if (missing === 'phone')    line = convo.callerPhone ? `Can I use ${convo.callerPhone} for confirmations?` : 'What phone number should I use for confirmations?';
    else                              line = await openAINLG({ ...convo, forbidGreet:true }).catch(()=> 'Okay.');
  }

  convo.turns += 1;
  convo.forbidGreet = true;
  await ttsToTwilio(ws, line);
}

async function finalizeCreate(ws, convo) {
  if (!convo.slots.endISO && convo.slots.startISO) convo.slots.endISO = computeEndISO(convo.slots.startISO);
  if (!convo.slots.phone && convo.callerPhone) convo.slots.phone = digitsOnly(convo.callerPhone).slice(-10);

  const payload = {
    Event_Name:     convo.slots.service || 'Appointment',
    Start_Time:     convo.slots.startISO || '',
    End_Time:       convo.slots.endISO || computeEndISO(convo.slots.startISO || ''),
    Customer_Name:  convo.slots.name || '',
    Customer_Phone: convo.slots.phone || '',
    Customer_Email: convo.slots.email || '',
    Notes: `Booked by phone agent. CallSid=${convo.callSid || ''}`
  };
  log('INFO','[CREATE payload]', payload);

  if (MAKE_CREATE_URL) {
    try {
      const r = await fetch(MAKE_CREATE_URL, {
        method: 'POST', agent: keepAliveHttpsAgent,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) log('WARN','[Make CREATE]', { status:r.status, body: await r.text().catch(()=> '') });
      else log('INFO','[Make CREATE] ok');
    } catch (e) { log('ERROR','[Make CREATE]', { error: e.message }); }
  } else {
    log('WARN','[Make CREATE] URL not set; skipping');
  }

  const confirm = `You’re set for a ${payload.Event_Name} on ${payload.Start_Time}. Thanks for calling Old Line Barbershop.`;
  await ttsToTwilio(ws, confirm);
  convo.phase = 'done';
}

// ---------- WS Handlers ----------
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  const biz = params.get('biz') || 'acme-001';
  const id = randomUUID();
  ws.__id = id;

  let dg = null, dgOpened = false;
  let frameCount = 0;
  const BATCH_FRAMES = 5; // ~100ms (5*20ms)
  let pendingULaw = [];

  ws.on('error', (e) => log('ERROR','WS error', { err: e.message }));
  ws.on('close', () => { try { dg?.close(); } catch{}; convoMap.delete(ws.__id); log('INFO','WS closed'); });

  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { log('WARN','[WS] non-JSON', { raw: String(raw).slice(0,120) }); return; }
    const evt = msg.event;

    if (evt === 'start') {
      const callSid   = msg?.start?.callSid || '';
      const from      = msg?.start?.customParameters?.from || msg?.start?.from || '';
      const streamSid = msg?.start?.streamSid || '';
      const convo = {
        id, callSid, biz,
        phase: 'idle',
        forbidGreet: false,
        callerPhone: from || '',
        slots: { service:'', startISO:'', endISO:'', name:'', phone:'', email:'' }
      };
      ws.__convo = convo;
      ws.__streamSid = streamSid;
      convoMap.set(ws.__id, convo);

      log('INFO','WS CONNECTED', { path, callSid, streamSid, biz });
      log('INFO','[agent prompt 120]', { text: (AGENT_PROMPT||'').slice(0,120) + '…' });

      if (DEEPGRAM_API_KEY) {
        dg = startDeepgramLinear16({
          onOpen: () => { dgOpened = true; },
          onPartial: (t) => { if (!t) return; log('DEBUG','[ASR partial]', { t }); },
          onFinal: (t) => { log('INFO','[ASR final]', { t }); onUserUtterance(ws, t).catch(e=>log('ERROR','[onUserUtterance]',{error:e.message})); },
          onError: (e) => log('ERROR','[ASR]', { error: e?.message || e }),
          onAnyMessage: (ev) => { if (ev.type && ev.type !== 'Results') log('DEBUG','[ASR msg]', { type: ev.type }); }
        });
        setTimeout(()=> { if (!dgOpened) log('WARN','(!) Deepgram connected but no transcripts yet'); }, 5000);
      } else {
        log('WARN','No DEEPGRAM_API_KEY — ASR disabled');
      }

      // Greet
      if (ELEVEN_API_KEY) {
        await ttsToTwilio(ws, 'Hi, thanks for calling Old Line Barbershop. How can I help you today?');
      } else {
        log('WARN','[TTS] ELEVEN_API_KEY missing; cannot greet');
      }
      return;
    }

    if (evt === 'media') {
      frameCount++; if (frameCount % 50 === 1) log('DEBUG','[media] frames', { frameCount });
      const b64 = msg.media?.payload || '';
      if (!b64) return;
      if (dg) {
        const ulaw = Buffer.from(b64, 'base64');
        pendingULaw.push(ulaw);
        if (pendingULaw.length >= BATCH_FRAMES) {
          const ulawChunk = Buffer.concat(pendingULaw);
          const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
          try { dg.sendPCM16LE(pcm16le); } catch (e) { log('ERROR','[media→DG]', { error: e?.message || e }); }
          pendingULaw = [];
        }
      }
      return;
    }

    if (evt === 'mark') { log('DEBUG','[mark]', msg.mark || {}); return; }

    if (evt === 'stop') {
      log('INFO','Twilio stream STOP');
      if (pendingULaw.length && dg) {
        try { dg.sendPCM16LE(ulawBufferToPCM16LEBuffer(Buffer.concat(pendingULaw))); } catch {}
        pendingULaw = [];
      }
      try { dg?.close(); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    // Optional: if your infra forwards ASR as synthetic messages
    if (evt === 'asr') {
      const t = msg?.text || '';
      if (t) { log('INFO','[ASR final*]', { t }); onUserUtterance(ws, t).catch(e=>log('ERROR','[onUserUtterance*]',{error:e.message})); }
      return;
    }

    log('DEBUG','[WS event ignored]', { evt });
  });
});

// ---------- Start ----------
server.listen(PORT, () => log('INFO', 'Server running', { PORT }));
