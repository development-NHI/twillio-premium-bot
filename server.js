// server.js — Tiny voice bot with GPT tools + ElevenLabs (Render-ready, CommonJS)
// Env needed in Render:
//  OPENAI_API_KEY
//  AGENT_PROMPT
//  ELEVEN_API_KEY
//  ELEVEN_VOICE_ID
//  MAKE_READ (optional)
//  MAKE_CREATE (optional)
//  MAKE_DELETE (optional)
//  MAKE_SECRET (optional)
//  MAKE_WEBHOOK (optional)
//  GREETING (optional)

'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.urlencoded({ extended: true })); // Twilio posts form-encoded
app.use(express.json());

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const AGENT_PROMPT = process.env.AGENT_PROMPT || 'You are a friendly receptionist. Keep replies under 22 words, one question max.';
const GREETING = process.env.GREETING || 'Hi, thanks for calling. How can I help you today?';

const ELEVEN_API_KEY  = process.env.ELEVEN_API_KEY  || process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Adam

const MAKE_READ   = process.env.MAKE_READ   || '';  // availability check
const MAKE_CREATE = process.env.MAKE_CREATE || '';  // create booking
const MAKE_DELETE = process.env.MAKE_DELETE || '';  // cancel booking (optional)
const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK || ''; // optional per-turn log
const MAKE_SECRET = process.env.MAKE_SECRET || '';   // optional bearer token

if (!OPENAI_API_KEY) console.warn('WARN: OPENAI_API_KEY missing');
if (!ELEVEN_API_KEY) console.warn('WARN: ELEVEN_API_KEY missing (fallback <Say> will be used)');

// ---------- simple audio store (for Eleven MP3s) ----------
const AUDIO_DIR = path.join(process.cwd(), 'audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use('/audio', express.static(AUDIO_DIR, { maxAge: 0 }));

// ---------- TwiML helpers ----------
function sayAndListen(text, actionUrl) {
  const xml = `
<Response>
  <Say>${xmlEscape(text)}</Say>
  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" language="en-US">
    <Pause length="1"/>
  </Gather>
</Response>`.trim();
  return xml;
}
function playAndListen(audioUrl, actionUrl) {
  const xml = `
<Response>
  <Play>${audioUrl}</Play>
  <Gather input="speech" speechTimeout="auto" action="${actionUrl}" language="en-US">
    <Pause length="1"/>
  </Gather>
</Response>`.trim();
  return xml;
}
function xmlEscape(s=''){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ---------- tool schema GPT sees ----------
const TOOLS = [
  {
    type: 'function',
    name: 'check_availability',
    description: 'Return if a time window is free',
    parameters: {
      type: 'object',
      properties: {
        startISO: { type: 'string', description: 'ISO 8601 start' },
        endISO:   { type: 'string', description: 'ISO 8601 end (optional)' }
      },
      required: ['startISO']
    }
  },
  {
    type: 'function',
    name: 'create_booking',
    description: 'Create an appointment',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'haircut | beard trim | combo' },
        startISO:{ type: 'string' },
        endISO:  { type: 'string' },
        name:    { type: 'string' },
        phone:   { type: 'string' },
        email:   { type: 'string' }
      },
      required: ['service','startISO','name','phone']
    }
  },
  {
    type: 'function',
    name: 'cancel_booking',
    description: 'Cancel an existing appointment',
    parameters: {
      type: 'object',
      properties: {
        id:      { type: 'string', description: 'booking id or reference' },
        phone:   { type: 'string' }
      },
      required: ['id']
    }
  }
];

// ---------- Make runner (executes tool calls) ----------
async function runTool(name, args, meta) {
  const headers = { 'Content-Type': 'application/json' };
  if (MAKE_SECRET) headers['Authorization'] = `Bearer ${MAKE_SECRET}`;

  if (name === 'check_availability' && MAKE_READ) {
    const r = await fetch(MAKE_READ, { method:'POST', headers, body: JSON.stringify({ intent:'READ', ...args, meta }) });
    return await safeJSON(r);
  }
  if (name === 'create_booking' && MAKE_CREATE) {
    const r = await fetch(MAKE_CREATE, { method:'POST', headers, body: JSON.stringify({ intent:'CREATE', ...args, meta }) });
    return await safeJSON(r);
  }
  if (name === 'cancel_booking' && MAKE_DELETE) {
    const r = await fetch(MAKE_DELETE, { method:'POST', headers, body: JSON.stringify({ intent:'DELETE', ...args, meta }) });
    return await safeJSON(r);
  }
  return { ok:false, reason:'unconfigured_or_unknown_tool', tool:name };
}
async function safeJSON(r){
  try{
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await r.json();
    return { ok:r.ok, status:r.status, text: await r.text().catch(()=> '') };
  }catch{
    return { ok:false };
  }
}

// ---------- OpenAI: reply + (optional) tool calls ----------
async function aiReplyWithTools(userText, callMeta={}) {
  // Step 1: let model decide whether to call a tool
  const first = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', Authorization:`Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      tools: TOOLS,
      tool_choice: 'auto',
      messages: [
        { role:'system', content:
          AGENT_PROMPT +
          ' Ask for service → time → name → phone; then call tools to check availability and create the booking. ' +
          'Keep answers under 22 words; one question max. Use check_availability before offering a time. Only call create_booking after explicit confirmation.' },
        { role:'user', content: `Caller: ${userText}` }
      ]
    })
  }).then(r => r.json()).catch(()=>null);

  const msg = first?.choices?.[0]?.message;
  if (!msg) return 'Okay. What else can I help you with?';

  // If GPT called tools, run them and send results back
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    const toolResults = [];
    for (const tc of msg.tool_calls.slice(0,3)) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      const result = await runTool(name, args, callMeta);
      toolResults.push({ role:'tool', tool_call_id: tc.id, name, content: JSON.stringify(result) });
    }

    const second = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization:`Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role:'system', content: AGENT_PROMPT },
          { role:'user', content: `Caller: ${userText}` },
          msg,
          ...toolResults
        ]
      })
    }).then(r=>r.json()).catch(()=>null);

    const finalText = second?.choices?.[0]?.message?.content?.trim();
    return finalText || 'All set. Anything else?';
  }

  // No tools: just return assistant text
  return (msg.content || 'Okay. What else can I help with?').trim();
}

// ---------- ElevenLabs: synthesize MP3 ----------
async function elevenSayToFile(text) {
  const id = randomUUID();
  const file = path.join(AUDIO_DIR, `${id}.mp3`);
  if (!ELEVEN_API_KEY) { return null; }

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVEN_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.8 }
    })
  });

  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  return `/audio/${path.basename(file)}`;
}

// ---------- optional: log each turn to Make_WEBHOOK ----------
async function logTurn(payload) {
  if (!MAKE_WEBHOOK) return;
  try {
    const headers = { 'Content-Type':'application/json' };
    if (MAKE_SECRET) headers['Authorization'] = `Bearer ${MAKE_SECRET}`;
    await fetch(MAKE_WEBHOOK, { method:'POST', headers, body: JSON.stringify(payload) });
  } catch {}
}

// ---------- Routes ----------
app.get('/', (_, res) => res.status(200).send('OK'));

// First turn: greet with <Say>, then listen
app.all('/voice', (req, res) => {
  const actionUrl = `/handle${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  res.type('text/xml').send(sayAndListen(GREETING, actionUrl));
});

// Each turn: transcript -> GPT(+tools) -> Eleven MP3 -> <Play> -> Gather again
app.post('/handle', async (req, res) => {
  const speech = (req.body.SpeechResult || '').trim();
  const from = req.body.From || '';
  const callSid = req.body.CallSid || '';
  const actionUrl = req.originalUrl; // preserve any ?client_id=...

  if (!speech) {
    return res.type('text/xml').send(sayAndListen('Sorry, I didn’t catch that. Could you repeat?', actionUrl));
  }

  await logTurn({ type:'heard', text: speech, from, callSid });

  const reply = await aiReplyWithTools(speech, { from, callSid });
  let xml;

  try {
    const audioUrl = await elevenSayToFile(reply);
    if (audioUrl) xml = playAndListen(audioUrl, actionUrl);
  } catch {}

  if (!xml) xml = sayAndListen(reply, actionUrl); // fallback to <Say>
  await logTurn({ type:'reply', text: reply, from, callSid });

  res.type('text/xml').send(xml);
});

// clean old audio every minute
setInterval(() => {
  const now = Date.now();
  for (const f of fs.readdirSync(AUDIO_DIR)) {
    const full = path.join(AUDIO_DIR, f);
    try {
      const age = now - fs.statSync(full).mtimeMs;
      if (age > 5 * 60 * 1000) fs.unlinkSync(full);
    } catch {}
  }
}, 60 * 1000);

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
