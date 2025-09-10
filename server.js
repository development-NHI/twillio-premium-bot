/**
 * server.js — Old Line Barbershop voice agent (CONFIRM-FIRST, v3)
 *
 * Env:
 *  PORT
 *  OPENAI_API_KEY
 *  DEEPGRAM_API_KEY
 *  ELEVEN_API_KEY | ELEVENLABS_API_KEY
 *  ELEVEN_VOICE_ID | ELEVENLABS_VOICE_ID (optional; defaults Adam)
 *  MAKE_CREATE | MAKE_CREATE_URL
 *  MAKE_READ   | MAKE_READ_URL
 *  BUSINESS_TZ (optional; default America/New_York)
 *  AGENT_PROMPT (optional)
 */

'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEEPGRAM_API_KEY = process.env.DEEPPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVEN_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Adam
const MAKE_CREATE_URL = process.env.MAKE_CREATE || process.env.MAKE_CREATE_URL || '';
const MAKE_READ_URL   = process.env.MAKE_READ   || process.env.MAKE_READ_URL   || '';
const BUSINESS_TZ     = process.env.BUSINESS_TZ || 'America/New_York';

const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });
const fetchFN = (...args) => globalThis.fetch(...args);

// ---------------------- Logger ----------------------
function log(level, msg, meta = undefined) {
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
  tz: BUSINESS_TZ
});

if (!OPENAI_API_KEY) log('WARN', 'OPENAI_API_KEY missing');
if (!DEEPGRAM_API_KEY) log('WARN', 'DEEPGRAM_API_KEY missing (ASR disabled)');
if (!ELEVENLABS_API_KEY) log('WARN', 'ELEVEN_API_KEY/ELEVENLABS_API_KEY missing (no audio)');
if (!MAKE_CREATE_URL) log('WARN', 'MAKE_CREATE_URL missing (no CREATE)');
if (!MAKE_READ_URL) log('WARN', 'MAKE_READ_URL missing (no availability checks)');

// ---------------------- Express ----------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/', (_, res) => res.status(200).send('OK'));
const server = http.createServer(app);

// ---------------------- WS ----------------------
const wss = new WebSocket.Server({ server });

// ---------------------- Prompt ----------------------
const DEFAULT_AGENT_PROMPT = `
You are a friendly, human-sounding AI receptionist for Old Line Barbershop.

Core Responsibilities
- Greet warmly and say the business name.
- Answer FAQs (hours, pricing, services, location).
- Handle booking/rescheduling/cancellation.

Booking Order (strict):
1) Service (haircut, beard trim, combo = haircut + beard trim)
2) Preferred date/time
3) Confirm availability (30-min slots, Mon–Fri 9–5) BEFORE asking for name/phone
4) Then ask for first name and phone (confirm caller ID if present)
5) Read back details and get a yes/no
6) On yes, finalize; on no, ask what to change

Rules
- Only book Mon–Fri, 9–5; suggest nearest slot if outside hours.
- Never double-book; if already created, don’t rebook.
- Short, natural sentences (<22 words). One question at a time.
- Vary phrasing; use contractions; micro-acknowledge.
- Give prices in one concise sentence.
- Don’t re-ask things already given.
- Keep caller informed (“Let me check…”, “That’s open…”, “All set.”)
- Say goodbye and hang up when done.

Vocabulary: “both / combo / haircut + beard / haircut and beard” => service=combo.

System Controls
- If forbidGreet=true, don’t greet again.
- If suggestedPhone exists and phone missing, confirm that number.
- Never output JSON to the caller.
`.trim();

const AGENT_PROMPT = (process.env.AGENT_PROMPT || DEFAULT_AGENT_PROMPT);

// ---------------------- State ----------------------
function newConvo(callSid, biz) {
  return {
    id: randomUUID(),
    callSid, biz,
    turns: 0,
    lastTTS: '', lastTTSAt: 0,
    forbidGreet: false,
    phase: 'idle', // idle|faq|collect_service|collect_time|collect_contact|confirm_booking|wrapup|done
    callerPhone: '',
    asrText: '',
    awaitingAsk: 'NONE', // SERVICE|TIME|NAME|PHONE|CONFIRM|WRAPUP|NONE
    created: false, createInFlight: false,
    lastAskAt: {},
    lastAvailabilityCheckAt: 0,
    temp: { pendingDate: null, pendingTime: null },
    slots: { service: '', startISO: '', endISO: '', name: '', phone: '', email: '' }
  };
}

// ---------------------- Audio utils ----------------------
function ulawByteToPcm16(u){u=~u&0xff;const s=u&0x80,e=(u>>4)&7,m=u&0x0f;let x=(((m<<3)+0x84)<<(e+2))-0x84*4;if(s)x=-x;return Math.max(-32768,Math.min(32767,x))}
function ulawBufferToPCM16LEBuffer(ulawBuf){const out=Buffer.alloc(ulawBuf.length*2);for(let i=0;i<ulawBuf.length;i++){out.writeInt16LE(ulawByteToPcm16(ulawBuf[i]),i*2)}return out}

// ---------------------- Deepgram realtime ----------------------
function startDeepgramLinear16({ onOpen, onPartial, onFinal, onError, onAnyMessage }) {
  if (!DEEPGRAM_API_KEY) return null;
  const url =
    'wss://api.deepgram.com/v1/listen'
    + '?encoding=linear16&sample_rate=8000&channels=1'
    + '&model=nova-2-phonecall'
    + '&interim_results=true&smart_format=true'
    + '&language=en-US'
    + '&endpointing=200'; // snappier end

  const dg = new WebSocket(url, { headers: { Authorization: `token ${DEEPGRAM_API_KEY}` }, perMessageDeflate: false });
  let open=false; const q=[];
  dg.on('open', () => { open=true; log('INFO','[ASR] Deepgram open'); onOpen?.(); while(q.length) dg.send(q.shift()); });
  dg.on('message', (data) => {
    let ev; try{ev=JSON.parse(data.toString())}catch{return}
    onAnyMessage?.(ev);
    if (ev.type!=='Results') return;
    const alt = ev.channel?.alternatives?.[0]; if (!alt) return;
    const text = (alt.transcript||'').trim(); if (!text) return;
    const isFinal = ev.is_final===true || ev.speech_final===true;
    if (isFinal) onFinal?.(text); else onPartial?.(text);
  });
  dg.on('error',(e)=>{log('ERROR','[ASR] error',{error:e?.message||String(e)}); onError?.(e)});
  dg.on('close',(c,r)=>log('INFO','[ASR] Deepgram closed',{code:c,reason:(r||'').toString?.()||''}));
  return { sendPCM16LE(buf){ if(open) dg.send(buf); else q.push(buf) }, close(){ try{dg.close()}catch{} } };
}

// ---------------------- Utilities ----------------------
function normalizeService(text){
  if(!text) return ''; const t=text.toLowerCase();
  if(/\b(both|combo|haircut\s*(?:&|and|\+)\s*beard|haircut\s*\+\s*beard)\b/.test(t)) return 'combo';
  if(/\bbeard( trim|)\b/.test(t)) return 'beard trim';
  if(/\bhair\s*cut|\bhaircut\b/.test(t)) return 'haircut';
  return '';
}
function computeEndISO(startISO){ try{ if(!startISO) return ''; const d=new Date(startISO); if(isNaN(+d)) return ''; return new Date(d.getTime()+30*60*1000).toISOString() }catch{ return '' } }
function isReadyToCreate(s){ return Boolean(s.service && s.startISO && (s.endISO || computeEndISO(s.startISO)) && s.name && (s.phone||'').trim()) }
function safeJSON(v,f={}){ try{return JSON.parse(v)}catch{return f} }
function debounceRepeat(convo,text,ms=2500){ const now=Date.now(); if(!text) return false; if(text===convo.lastTTS && (now-convo.lastTTSAt)<ms) return true; convo.lastTTS=text; convo.lastTTSAt=now; return false }
function throttleAsk(convo, key, minMs=2750){ const now=Date.now(); const last=convo.lastAskAt[key]||0; if(now-last<minMs) return true; convo.lastAskAt[key]=now; return false }

function makeQuestionForAsk(ask, convo){
  if(ask==='SERVICE') return 'What service can I get you—haircut, beard trim, or the combo?';
  if(ask==='TIME')    return `What date and time would you like for your ${convo.slots.service||'appointment'}?`;
  if(ask==='NAME')    return 'What’s your first name?';
  if(ask==='PHONE')   return 'What phone number should I use for confirmations?';
  if(ask==='CONFIRM') return readbackLine(convo)+' Is everything correct?';
  if(ask==='WRAPUP')  return 'Do you need anything else before I hang up?';
  return 'How can I help further?';
}
function normalizeFutureStart(iso){
  if(!iso) return ''; const dt=new Date(iso); if(isNaN(+dt)) return iso;
  const now=new Date(); if(dt.getTime()<now.getTime()){ const bumped=new Date(now); bumped.setDate(bumped.getDate()+7); bumped.setHours(dt.getHours(),dt.getMinutes(),0,0); log('WARN','[time guardrail] bumped parsed Start_Time to future',{from:iso,to:bumped.toISOString()}); return bumped.toISOString() }
  return dt.toISOString();
}
function ensureEndMatchesStart(convo){ if(convo.slots.startISO && !convo.slots.endISO) convo.slots.endISO=computeEndISO(convo.slots.startISO) }
function setSlot(convo,k,v){ if(typeof v==='string') v=v.trim(); if(!v) return; convo.slots[k]=v; log('INFO','[slot set]',{k,v}); if(k==='service' && convo.awaitingAsk==='SERVICE') convo.awaitingAsk='TIME'; if(k==='startISO' && convo.awaitingAsk==='TIME') convo.awaitingAsk='NAME'; if(k==='name' && convo.awaitingAsk==='NAME') convo.awaitingAsk='PHONE'; if(k==='phone' && convo.awaitingAsk==='PHONE') convo.awaitingAsk='NONE'; ensureEndMatchesStart(convo) }
function yesish(s){ return /\b(yes|yep|yeah|sure|correct|right|sounds good|that'?s (fine|right|correct)|confirm|book it|go ahead|please do|yup)\b/i.test(s) }
function noish(s){ return /\b(no|nope|nah|not (quite|correct|right)|change|wrong|different|actually|don'?t|stop|hold off|not now)\b/i.test(s) }

function fmtTime(dtISO){ try{ const d=new Date(dtISO); return d.toLocaleString('en-US',{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}) }catch{ return dtISO } }
function formatPhoneHuman(s10){ if(!s10) return ''; const d=s10.replace(/\D+/g,'').slice(-10); if(d.length!==10) return s10; return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` }
function readbackLine(convo){
  const s=convo.slots, when=s.startISO?fmtTime(s.startISO):'', phone=formatPhoneHuman(s.phone||convo.callerPhone||'');
  const bits=[ s.service?`${s.service}`:'', when?`on ${when}`:'', s.name?`for ${s.name}`:'', phone?`at ${phone}`:'' ].filter(Boolean).join(', ');
  return bits?`Here are the details: ${bits}.`:'Let me confirm the details.';
}

// ---- Name / Phone helpers (stopwords to avoid loops) ----
const NAME_STOP = new Set(['no','nah','nope','yeah','yes','ok','okay','thanks','thank','sure','uh','um','hmm','mm']);
const TWO_LETTER_OK = new Set(['ed','bo','al','ty','jo','li','an','aj','dj','ry']);
function titleCaseName(s){ return s.toLowerCase().replace(/\b([a-z])/g,(m,c)=>c.toUpperCase()) }
function maybeExtractName(u){
  if(!u) return ''; let t=String(u).trim();
  t=t.replace(/\b(my name is|this is|it'?s|i'?m|name's)\b\s*/i,'');
  t=t.replace(/[?.!,]+$/g,'').trim();
  t=t.replace(/[^a-zA-Z'\-\s]/g,' ').replace(/\s+/g,' ').trim();
  if(!t) return '';
  const token=t.split(' ')[0].toLowerCase();
  if (NAME_STOP.has(token)) return '';
  if (token.length===2 && !TWO_LETTER_OK.has(token)) return '';
  if (!/^[a-z][a-z'\-]{1,19}$/.test(token)) return '';
  return titleCaseName(token);
}
function maybeExtractPhone(u){ if(!u) return ''; const d=u.replace(/\D+/g,''); if(d.length===11 && d.startsWith('1')) return d.slice(1); if(d.length>=10) return d.slice(-10); return '' }

// ---- Date/Time parsing (supports “Friday”, split parts) ----
const WD=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
function parseWeekdayFromUtterance(u, now=new Date()){
  if(!u) return null;
  const m=u.toLowerCase().match(/\b(next|this)?\s*(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/);
  if(!m) return null; const kw=(m[1]||'').toLowerCase(); const wdStr=m[2];
  let idx=WD.findIndex(d=>wdStr.startsWith(d.substr(0,3))); if(idx<0) return null;
  const d0=new Date(now), today=d0.getDay(); let delta=(idx-today+7)%7; if(kw==='next') delta = delta===0?7:delta;
  return { y:d0.getFullYear(), m:d0.getMonth()+1, d:d0.getDate()+delta, weekdayIndex:idx, kw:kw||'bare' };
}
function parseDateFromUtterance(u, now=new Date()){
  if(!u) return null;
  const wd=parseWeekdayFromUtterance(u, now); if(wd) return wd;

  const t=u.toLowerCase();
  if(/\btomorrow\b/.test(t)){ const d=new Date(now.getTime()+24*3600*1000); return { y:d.getFullYear(), m:d.getMonth()+1, d:d.getDate() } }
  if(/\btoday\b/.test(t)){ const d=new Date(now); return { y:d.getFullYear(), m:d.getMonth()+1, d:d.getDate() } }

  const m=u.match(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/);
  if(m){ let [_,mm,dd,yy]=m; mm=parseInt(mm,10); dd=parseInt(dd,10); yy=parseInt(yy,10); if(yy<100) yy+=2000; if(mm>=1&&mm<=12&&dd>=1&&dd<=31) return { y:yy,m:mm,d:dd } }

  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const m2=u.toLowerCase().match(new RegExp(`\\b(${months.join('|')})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\b`));
  if(m2){ const mm=months.indexOf(m2[1])+1; const dd=parseInt(m2[2],10); const yy=m2[3]?parseInt(m2[3],10):(new Date()).getFullYear(); return { y:yy,m:mm,d:dd } }
  return null;
}
function parseTimeFromUtterance(u){
  if(!u) return null; const m=u.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if(m){ let hh=parseInt(m[1],10); let mi=m[2]?parseInt(m[2],10):0; const ap=m[3]?m[3].toLowerCase():null; if(ap==='pm'&&hh<12) hh+=12; if(ap==='am'&&hh===12) hh=0; if(!ap&&hh<=7) hh+=12; return { hh,mi } }
  if(/\b(noon|midday)\b/i.test(u)) return { hh:12, mi:0 };
  if(/\b(midnight)\b/i.test(u)) return { hh:0, mi:0 };
  return null;
}
function buildISOFromParts(datePart,timePart,now=new Date()){
  if(!datePart||!timePart) return '';
  const base=new Date(now); base.setFullYear(datePart.y); base.setMonth(datePart.m-1); base.setDate(datePart.d); base.setHours(timePart.hh,timePart.mi||0,0,0);
  const dt=new Date(base);
  if(datePart.weekdayIndex!=null && dt.getTime()<=now.getTime()) dt.setDate(dt.getDate()+7);
  return dt.toISOString();
}
function tryParseAndSetTime(convo, utterance){
  const now=new Date(); const dp=parseDateFromUtterance(utterance, now); const tp=parseTimeFromUtterance(utterance);
  if(dp&&tp){ const iso=normalizeFutureStart(buildISOFromParts(dp,tp,now)); if(iso){ setSlot(convo,'startISO',iso); return { status:'SET' } } }
  if(dp&&!tp){ convo.temp.pendingDate=dp; return { status:'NEED_TIME', dp } }
  if(tp&&!dp){ convo.temp.pendingTime=tp; return { status:'NEED_DATE', tp } }
  if(convo.temp.pendingDate&&convo.temp.pendingTime){
    const iso=normalizeFutureStart(buildISOFromParts(convo.temp.pendingDate,convo.temp.pendingTime,now));
    if(iso){ setSlot(convo,'startISO',iso); convo.temp.pendingDate=null; convo.temp.pendingTime=null; return { status:'SET' } }
  }
  return { status:'NOSET' };
}

// ---------------------- Make.com ----------------------
function withTimeout(ms){ const controller=new AbortController(); const t=setTimeout(()=>controller.abort(),ms); return { signal:controller.signal, cancel:()=>clearTimeout(t) } }

function truthyAvailabilityShape(data){
  if (data == null) return { known:false, available:true };
  const availCandidates = [
    data.available, data.isAvailable, data.free, data.open,
    data.status && String(data.status).toLowerCase()==='open' ? true : undefined,
    Array.isArray(data.events) ? (data.events.length===0) : undefined,
    Array.isArray(data.busy)   ? (data.busy.length===0)   : undefined,
    data.conflicts===false, data.busy===false, data.hasConflict===false
  ].filter(v => v!==undefined);

  if (availCandidates.includes(true)) return { known:true, available:true };
  if (availCandidates.includes(false)) return { known:true, available:false };

  return { known:false, available:true }; // unknown shapes => assume available
}

function toLocalPieces(iso){
  const d = new Date(iso);
  // Provide local components too (some Make scenarios want this)
  return {
    startISO: iso,
    endISO: computeEndISO(iso),
    year: d.getFullYear(),
    month: d.getMonth()+1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    tz: BUSINESS_TZ
  };
}

async function makeCheckAvailability(startISO, endISO){
  if (!MAKE_READ_URL || !startISO) return { ok:false, available:true };
  const local = toLocalPieces(startISO);
  const payload = {
    intent:'READ',
    window:{ start:startISO, end:endISO||computeEndISO(startISO) },
    local, BUSINESS_TZ
  };
  try{
    const { signal, cancel } = withTimeout(2500);
    const r = await fetchFN(MAKE_READ_URL, { method:'POST', agent:keepAliveHttpsAgent, headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal });
    cancel();
    if(!r.ok){ const body=await r.text().catch(()=> ''); log('WARN','[Make READ] non-200',{status:r.status,body}); return { ok:false, available:true } }
    const data = await r.json().catch(()=> ({}));
    const interp = truthyAvailabilityShape(data);
    log('INFO','[Make READ] result',{ raw:data, interpreted:interp });
    if (interp.known && interp.available===false) {
      if (Array.isArray(data.events) && data.events.length===0) return { ok:true, available:true };
      if (Array.isArray(data.busy)   && data.busy.length===0)   return { ok:true, available:true };
    }
    return { ok:true, available: interp.available, nextOpenISO: data.nextOpenISO || data.next || data.suggested || '' };
  }catch(e){
    log('ERROR','[Make READ]',{error:e.message});
    return { ok:false, available:true };
  }
}
async function makeCreateBooking(convo){
  const payload = {
    Event_Name: convo.slots.service || 'Appointment',
    Start_Time: convo.slots.startISO || '',
    End_Time:   convo.slots.endISO   || computeEndISO(convo.slots.startISO || ''),
    Customer_Name:  convo.slots.name || '',
    Customer_Phone: convo.slots.phone|| '',
    Customer_Email: convo.slots.email|| '',
    BUSINESS_TZ,
    Notes: `Booked by phone agent. CallSid=${convo.callSid||''}`
  };
  if(!MAKE_CREATE_URL){ log('WARN','[Make CREATE] skipped; MAKE_CREATE_URL missing',payload); return { ok:false } }
  try{
    const { signal, cancel } = withTimeout(3000);
    const r = await fetchFN(MAKE_CREATE_URL, { method:'POST', agent:keepAliveHttpsAgent, headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal });
    cancel();
    if(!r.ok){ const body=await r.text().catch(()=> ''); log('WARN','[Make CREATE] non-200',{status:r.status,body}); return { ok:false } }
    log('INFO','[Make CREATE] ok');
    return { ok:true };
  }catch(e){ log('ERROR','[Make CREATE]',{error:e.message}); return { ok:false } }
}

// Best-effort next open if READ doesn’t provide one
async function findNextOpenSlot(seedISO){
  let probe = new Date(seedISO ? seedISO : Date.now());
  function clamp(d){
    const h=d.getHours();
    if(h<9) d.setHours(9,0,0,0);
    if(h>=17){ d.setDate(d.getDate()+1); d.setHours(9,0,0,0); }
    while(d.getDay()===0 || d.getDay()===6){ d.setDate(d.getDate()+1); d.setHours(9,0,0,0); }
  }
  clamp(probe);
  for(let i=0;i<40;i++){
    const start=probe.toISOString(); const end=computeEndISO(start);
    const chk=await makeCheckAvailability(start,end);
    if(chk.available) return start;
    probe = new Date(probe.getTime()+30*60*1000); clamp(probe);
  }
  return '';
}

// ---------------------- OpenAI (extract/NLG) ----------------------
async function openAIExtract(utterance, convo){
  const sys = [
`Return JSON:
{"intent":"FAQ"|"CREATE"|"READ"|"CANCEL"|"RESCHEDULE"|"SMALLTALK"|"UNKNOWN",
 "faq_topic":"HOURS"|"PRICES"|"SERVICES"|"LOCATION"|"" ,
 "Event_Name":"","Start_Time":"","End_Time":"",
 "Customer_Name":"","Customer_Phone":"","Customer_Email":"",
 "window":{"start":"","end":""},"ask":"NONE"|"SERVICE"|"TIME"|"NAME"|"PHONE"|"CONFIRM","reply":""}
Rules:
- For pricing, reply in one short sentence: "Haircut is $30, beard trim $15, combo $40."
- If they ask to book or about availability, prefer intent="CREATE" unless clearly only checking.
- Recognize “combo/both/haircut + beard”.
- If day/time provided, fill Start_Time (ISO if obvious).
- Keep reply short; one question; no greeting if forbidGreet=true.`,
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
  try{
    const resp = await fetchFN('https://api.openai.com/v1/chat/completions',{
      method:'POST', agent:keepAliveHttpsAgent,
      headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({ model:'gpt-4o-mini', temperature:0.2, messages:[ {role:'system',content:sys},{role:'user',content:user} ], response_format:{type:'json_object'} })
    });
    if(!resp.ok){ const txt=await resp.text().catch(()=> ''); throw new Error(`${resp.status} ${txt}`) }
    const data=await resp.json(); const raw=data.choices?.[0]?.message?.content||'{}';
    return safeJSON(raw,{ intent:'UNKNOWN', faq_topic:'', ask:'NONE', reply:'' });
  }catch(e){ log('ERROR','[extract]',{error:e.message}); return { intent:'UNKNOWN', faq_topic:'', ask:'NONE', reply:'' } }
}

async function openAINLG(convo,hint=''){
  const sys = `You are a warm front-desk receptionist. One short conversational sentence (<22 words). One question max. No greeting if forbidGreet=true. Vary phrasing.`;
  const ctx = `State:
phase=${convo.phase}
forbidGreet=${convo.forbidGreet}
service=${convo.slots.service}
startISO=${convo.slots.startISO}
endISO=${convo.slots.endISO}
name=${convo.slots.name}
phone=${convo.slots.phone}
callerPhone=${convo.callerPhone}
AGENT PROMPT:
${AGENT_PROMPT}`;
  const user = `Compose the next thing to say to the caller.${hint?'\nHint: '+hint:''}`;
  try{
    const resp=await fetchFN('https://api.openai.com/v1/chat/completions',{ method:'POST', agent:keepAliveHttpsAgent, headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'}, body:JSON.stringify({ model:'gpt-4o-mini', temperature:0.3, messages:[ {role:'system',content:sys},{role:'system',content:ctx},{role:'user',content:user} ] }) });
    if(!resp.ok){ const t=await resp.text().catch(()=> ''); throw new Error(`${resp.status} ${t}`) }
    const data=await resp.json(); return (data.choices?.[0]?.message?.content||'').trim() || 'Okay.';
  }catch(e){ log('ERROR','[nlg]',{error:e.message}); return 'Okay.' }
}

// ---------------------- Reply helpers ----------------------
async function askOnce(ws, convo, askKey, line){
  if (throttleAsk(convo, askKey, 2750)) { log('DEBUG','[ask throttle]',{ask:askKey}); return; }
  await twilioSay(ws, line || makeQuestionForAsk(askKey, convo));
}

async function handleAvailabilityAnswer(ws, convo){
  await twilioSay(ws, 'One moment while I check the schedule.');
  const info = await makeCheckAvailability(convo.slots.startISO, convo.slots.endISO);
  convo.lastAvailabilityCheckAt = Date.now();

  if (info.available) {
    const when = fmtTime(convo.slots.startISO);
    if (!convo.slots.service) { convo.phase='collect_service'; convo.awaitingAsk='SERVICE'; await twilioSay(ws, `Good news—${when} is open. Do you want a haircut, beard trim, or the combo?`); }
    else { convo.phase='collect_contact'; convo.awaitingAsk='NAME'; await twilioSay(ws, `Good news—${when} is open. What’s your first name?`); }
  } else {
    const altISO = info.nextOpenISO || await findNextOpenSlot(convo.slots.startISO);
    if (altISO) {
      convo.slots.startISO = altISO; convo.slots.endISO = computeEndISO(altISO);
      convo.phase='confirm_booking'; convo.awaitingAsk='CONFIRM';
      await twilioSay(ws, `${fmtTime(altISO)} is available. Should I book that?`);
    } else {
      convo.phase='collect_time'; convo.awaitingAsk='TIME';
      await twilioSay(ws, 'That time’s taken. Morning or afternoon work better?');
    }
  }
}

function ensureReplyOrAsk(parsed, utterance, convo){
  const inBooking = ['collect_service','collect_time','collect_contact','confirm_booking'].includes(convo.phase);
  const canCollect = parsed.intent==='CREATE' || inBooking;

  const inferredService = parsed.service || normalizeService(parsed.Event_Name) || normalizeService(utterance);
  if (!convo.slots.service && inferredService) setSlot(convo,'service',inferredService);

  const have = { service:convo.slots.service, startISO:convo.slots.startISO, name:convo.slots.name||parsed.Customer_Name, phone:convo.slots.phone||parsed.Customer_Phone||convo.callerPhone };
  if(have.name && !convo.slots.name) setSlot(convo,'name',have.name);
  if(have.phone && !convo.slots.phone) setSlot(convo,'phone',have.phone);

  if (canCollect && isReadyToCreate(convo.slots)) { convo.phase='confirm_booking'; parsed.ask='CONFIRM'; parsed.reply=makeQuestionForAsk('CONFIRM',convo); return parsed; }

  if (canCollect) {
    const askNeeded = (!have.service && 'SERVICE') || (!have.startISO && 'TIME') || (!convo.slots.name && 'NAME') || (!convo.slots.phone && 'PHONE') || 'NONE';
    if (askNeeded!=='NONE') { parsed.ask=askNeeded; parsed.reply=makeQuestionForAsk(askNeeded,convo); return parsed; }
  }

  parsed.ask='NONE'; parsed.reply=parsed.reply||'Got it. How can I help further?';
  return parsed;
}

// ---------------------- TTS -> Twilio ----------------------
async function ttsToTwilio(ws, text, voiceId=ELEVENLABS_VOICE_ID){
  if(!text) return;
  const convo=ws.__convo;
  if (debounceRepeat(convo, text)) { log('DEBUG','[debounce] suppress repeat',{text}); return; }
  const streamSid=ws.__streamSid;
  if(!streamSid){ log('WARN','[TTS] missing streamSid'); return; }
  if(!ELEVENLABS_API_KEY){ log('WARN','[TTS] ELEVEN_API_KEY missing'); return; }

  const url=`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
  try{
    log('INFO','[TTS ->]',{text});
    const resp = await fetchFN(url,{ method:'POST', agent:keepAliveHttpsAgent, headers:{ 'xi-api-key':ELEVENLABS_API_KEY,'Accept':'audio/wav','Content-Type':'application/json' }, body:JSON.stringify({ text, voice_settings:{stability:0.5, similarity_boost:0.8}, generation_config:{ chunk_length_schedule:[100,140,180,220] } }) });
    if(!resp.ok){ const t=await resp.text().catch(()=> ''); log('ERROR','[TTS fetch]',{error:`${resp.status} ${t}`}); return; }
    const reader=resp.body.getReader();
    while(true){ const {value,done}=await reader.read(); if(done) break; const b64=Buffer.from(value).toString('base64'); const frame={event:'media',streamSid,media:{payload:b64}}; safeSend(ws,JSON.stringify(frame)); }
    safeSend(ws, JSON.stringify({ event:'mark', streamSid, mark:{ name:'eos' } }));
  }catch(e){ log('ERROR','[TTS fetch]',{error:e.message}); }
}
function safeSend(ws,data){ try{ if(ws.readyState===WebSocket.OPEN) ws.send(data) }catch{} }
function twilioSay(ws,text){ return ttsToTwilio(ws,text) }

// ---------------------- Flow pieces ----------------------
async function finalizeCreate(ws, convo){
  if (convo.created || convo.createInFlight){ log('INFO','[CREATE] already done/in-flight'); await twilioSay(ws,'Your appointment is confirmed. Anything else I can help with?'); convo.awaitingAsk='WRAPUP'; convo.phase='wrapup'; return; }
  convo.createInFlight=true;

  if(!convo.slots.endISO && convo.slots.startISO) convo.slots.endISO=computeEndISO(convo.slots.startISO);
  if(!convo.slots.phone && convo.callerPhone) convo.slots.phone=convo.callerPhone;

  // Skip recheck if we just checked within 10 seconds
  const now = Date.now();
  if (now - (convo.lastAvailabilityCheckAt||0) > 10000) {
    const recheck=await makeCheckAvailability(convo.slots.startISO, convo.slots.endISO);
    convo.lastAvailabilityCheckAt = now;
    if(!recheck.available){
      convo.createInFlight=false;
      const alt = recheck.nextOpenISO || await findNextOpenSlot(convo.slots.startISO);
      if (alt){ convo.slots.startISO=alt; convo.slots.endISO=computeEndISO(alt); convo.phase='confirm_booking'; convo.awaitingAsk='CONFIRM'; await twilioSay(ws, `Shoot—someone just took that time. ${fmtTime(alt)} is open. Book that instead?`); return; }
      convo.phase='collect_time'; convo.awaitingAsk='TIME'; await twilioSay(ws,'Looks like that time just got booked. What other time works?'); return;
    }
  }

  const result=await makeCreateBooking(convo);
  convo.created=!!result.ok; convo.createInFlight=false;
  if(!result.ok){ convo.phase='collect_time'; convo.awaitingAsk='TIME'; await twilioSay(ws,'I couldn’t finalize that just now. Want me to try a different time?'); return; }

  convo.phase='wrapup'; convo.awaitingAsk='WRAPUP';
  await twilioSay(ws, `All set. ${readbackLine(convo)} Do you need anything else before I hang up?`);
}

async function askMissingFromPartial(ws, convo, status, dp, tp){
  if (status==='NEED_TIME' && dp){
    const dayStr = new Date(dp.y, dp.m-1, dp.d).toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'});
    await askOnce(ws, convo, 'TIME', `Got it—${dayStr}. What time works for you?`);
    return true;
  }
  if (status==='NEED_DATE' && tp){
    const hh12 = (tp.hh%12)||12, ampm = tp.hh>=12?'PM':'AM';
    const tStr = `${hh12}${tp.mi?':'+String(tp.mi).padStart(2,'0'):''} ${ampm}`;
    await askOnce(ws, convo, 'TIME', `Got it—${tStr}. Which day did you have in mind?`);
    return true;
  }
  return false;
}

// ---------------------- ASR final hook ----------------------
function handleASRFinal(ws, text){
  const convo=ws.__convo; if(!convo) return;
  convo.asrText=text;

  if (convo.awaitingAsk==='CONFIRM'){
    if (yesish(text)){ finalizeCreate(ws,convo).catch(e=>log('ERROR','[finalizeCreate]',{error:e.message})); return; }
    if (noish(text)){ convo.phase='collect_service'; convo.awaitingAsk='SERVICE'; twilioSay(ws,'No problem. What would you like to change—the service, the time, or your contact?'); return; }
  }
  if (convo.awaitingAsk==='WRAPUP'){
    if (noish(text)){ twilioSay(ws,'Thanks for calling Old Line Barbershop. Take care!').then(()=>{ try{ws.__dg?.close()}catch{} try{ws.close()}catch{} }); convo.phase='done'; return; }
    if (yesish(text)){ convo.phase='idle'; convo.awaitingAsk='NONE'; twilioSay(ws,'Sure—what else can I help you with?'); return; }
  }

  onUserUtterance(ws, text).catch(err=>log('ERROR','[onUserUtterance]',{error:err.message}));
}

// ---------------------- Main flow ----------------------
async function onUserUtterance(ws, utterance){
  const convo=ws.__convo; if(!convo || convo.phase==='done') return;
  log('INFO','[USER]',{text:utterance});

  // De-escalate insults (but keep flow moving)
  if (/\b(stupid|idiot|retard|retarded|dumb|moron)\b/i.test(utterance)) {
    await twilioSay(ws, 'Sorry about that. Let me try a different option.');
  }

  // After FAQ “Yes”, jump to booking
  if ((convo.phase==='faq' || convo.phase==='idle') && yesish(utterance)) {
    convo.phase='collect_service'; convo.awaitingAsk='SERVICE'; await askOnce(ws, convo, 'SERVICE'); return;
  }

  // Fast-path: NAME/PHONE capture to avoid loops
  if (convo.awaitingAsk==='NAME') {
    const nm=maybeExtractName(utterance);
    if(nm){ setSlot(convo,'name',nm); convo.phase=(convo.slots.phone||convo.callerPhone)?'confirm_booking':'collect_contact'; convo.awaitingAsk=(convo.slots.phone||convo.callerPhone)?'CONFIRM':'PHONE';
      if(convo.awaitingAsk==='PHONE') await twilioSay(ws,`Thanks, ${nm}. What’s the best phone for confirmations?`);
      else await twilioSay(ws, readbackLine(convo)+' Everything look right?');
      return;
    }
  }
  if (convo.awaitingAsk==='PHONE') {
    const ph=maybeExtractPhone(utterance);
    if(ph){ setSlot(convo,'phone',ph); convo.phase='confirm_booking'; convo.awaitingAsk='CONFIRM'; await twilioSay(ws, readbackLine(convo)+' Everything look right?'); return; }
  }

  // Time parsing (handles split)
  if (convo.awaitingAsk==='TIME' || /\b(tomorrow|today|mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|noon|midday)\b/i.test(utterance)) {
    const r = tryParseAndSetTime(convo, utterance);
    if (r.status==='SET'){ await handleAvailabilityAnswer(ws,convo); return; }
    const asked = await askMissingFromPartial(ws, convo, r.status, r.dp, r.tp);
    if (asked) return;
  }

  // 1) Extract
  let parsed = await openAIExtract(utterance, convo);

  // 2) Merge slots
  if (parsed.Event_Name){ const svc=normalizeService(parsed.Event_Name); if(svc) setSlot(convo,'service',svc); }
  const wantTime = (parsed.Start_Time && !convo.slots.startISO) || convo.awaitingAsk==='TIME';
  if (wantTime && parsed.Start_Time){ setSlot(convo,'startISO', normalizeFutureStart(parsed.Start_Time)); if(parsed.End_Time && !convo.slots.endISO) setSlot(convo,'endISO',parsed.End_Time) }
  if (parsed.Customer_Name) setSlot(convo,'name',parsed.Customer_Name);
  if (parsed.Customer_Phone) setSlot(convo,'phone',parsed.Customer_Phone);
  if (parsed.Customer_Email) setSlot(convo,'email',parsed.Customer_Email);
  ensureEndMatchesStart(convo);

  // 3) Phase
  if (parsed.intent==='FAQ') {
    convo.phase='faq';
    // Make FAQs concise and one-shot
    if (parsed.faq_topic==='PRICES') {
      await twilioSay(ws, 'Haircut is $30, beard trim $15, and the combo is $40. Want me to book one?');
      convo.forbidGreet = true;
      return;
    }
  } else if (parsed.intent==='READ') {
    if (convo.slots.startISO) { await handleAvailabilityAnswer(ws,convo); return; }
    convo.phase='collect_time'; convo.awaitingAsk='TIME'; await askOnce(ws,convo,'TIME'); return;
  } else if (parsed.intent==='CREATE' || ['collect_service','collect_time','collect_contact','confirm_booking'].includes(convo.phase)) {
    if (!convo.slots.service) convo.phase='collect_service';
    else if (!convo.slots.startISO) convo.phase='collect_time';
    else if (!convo.slots.name || !(convo.slots.phone||convo.callerPhone)) convo.phase='collect_contact';
    else convo.phase='confirm_booking';
  }

  // 4) Decide next
  parsed = ensureReplyOrAsk(parsed, utterance, convo);

  // Availability pre-check: have service+time but not contact yet
  if (convo.phase==='collect_contact' && convo.slots.startISO){
    const info=await makeCheckAvailability(convo.slots.startISO,convo.slots.endISO);
    convo.lastAvailabilityCheckAt = Date.now();
    if(!info.available){
      const alt=info.nextOpenISO || await findNextOpenSlot(convo.slots.startISO);
      if(alt){ convo.slots.startISO=alt; convo.slots.endISO=computeEndISO(alt); convo.awaitingAsk='CONFIRM'; convo.phase='confirm_booking'; await twilioSay(ws, `${fmtTime(alt)} is available. Book that one?`); return; }
      convo.phase='collect_time'; convo.awaitingAsk='TIME'; await twilioSay(ws,'That time’s taken. Morning or afternoon work better?'); return;
    }
  }

  if (parsed.ask && parsed.ask!=='NONE'){ convo.awaitingAsk=parsed.ask; await askOnce(ws,convo,parsed.ask,parsed.reply); convo.turns+=1; convo.forbidGreet=true; return; }
  const line=(parsed.reply||'').trim() || await openAINLG({ ...convo, forbidGreet:true });
  convo.turns+=1; convo.forbidGreet=true; await twilioSay(ws,line);
}

// ---------------------- WS Handlers ----------------------
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const biz = params.get('biz') || 'acme-001';
  ws.__id = randomUUID();

  ws.on('error', (err)=>log('ERROR','WS error',{error:err.message}));
  ws.on('close', ()=>{ try{ws.__dg?.close()}catch{} log('INFO','WS closed') });

  ws.on('message', async (raw)=>{
    let msg; try{ msg=JSON.parse(raw.toString()) }catch{ log('DEBUG','[WS event ignored]',{evt:'non-json'}); return; }
    const evt=msg.event; if(!evt){ log('DEBUG','[WS event ignored]',msg); return; }
    if (evt==='connected'){ log('DEBUG','[WS event ignored]',{evt}); return; }

    if (evt==='start'){
      const callSid = msg?.start?.callSid || '';
      const from    = msg?.start?.customParameters?.from || msg?.start?.from || '';
      const streamSid= msg?.start?.streamSid || '';
      const convo = newConvo(callSid, biz);
      ws.__convo = convo; ws.__streamSid=streamSid; convo.callerPhone=from||'';
      log('INFO','WS CONNECTED',{path:req.url, callSid, streamSid, biz});
      log('INFO','[agent prompt 120]',{text:AGENT_PROMPT.slice(0,120)});

      ws.__dg = startDeepgramLinear16({
        onOpen:()=>{}, onPartial:(t)=>log('DEBUG','[ASR partial]',{t}), onFinal:(t)=>{log('INFO','[ASR final]',{t}); handleASRFinal(ws,t)}, onError:()=>{}, onAnyMessage:(ev)=>{ if(ev.type && ev.type!=='Results') log('DEBUG','[ASR event]',{type:ev.type}) }
      });

      // Greet
      const greet = 'Hi, thanks for calling Old Line Barbershop. How can I help you today?';
      convo.awaitingAsk='NONE'; convo.turns=0; convo.forbidGreet=false; convo.lastTTS=''; convo.lastTTSAt=0;
      twilioSay(ws,greet).catch(()=>{});
      return;
    }

    if (evt==='media'){
      const b64=msg.media?.payload||''; if(!b64) return;
      if(!ws.__ulawBatch) ws.__ulawBatch=[]; ws.__ulawBatch.push(Buffer.from(b64,'base64'));
      if(!ws.__frameCount) ws.__frameCount=0; ws.__frameCount++;

      const BATCH_FRAMES=5; // ~100ms
      if (ws.__ulawBatch.length>=BATCH_FRAMES && ws.__dg){
        try{
          const ulawChunk=Buffer.concat(ws.__ulawBatch);
          const pcm16le=ulawBufferToPCM16LEBuffer(ulawChunk);
          ws.__dg.sendPCM16LE(pcm16le);
        }catch(e){ log('ERROR','[media→DG] send error',{error:e?.message||String(e)}) }
        ws.__ulawBatch=[];
      }
      return;
    }

    if (evt==='mark'){ log('DEBUG','[mark]',{name:msg?.mark?.name}); return; }

    if (evt==='stop'){
      log('INFO','Twilio stream STOP');
      if (ws.__ulawBatch?.length && ws.__dg){
        try{ const ulawChunk=Buffer.concat(ws.__ulawBatch); const pcm16le=ulawBufferToPCM16LEBuffer(ulawChunk); ws.__dg.sendPCM16LE(pcm16le); }catch{}
        ws.__ulawBatch=[];
      }
      try{ws.__dg?.close()}catch{}; try{ws.close()}catch{};
      return;
    }

    if (evt==='asr'){ const final=msg?.text||''; if(final) handleASRFinal(ws,final); return; }
    log('DEBUG','[WS event ignored]',msg);
  });
});

// ---------------------- Start server ----------------------
server.listen(PORT, () => { log('INFO','Server running',{PORT:String(PORT)}) });


