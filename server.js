/* server.js — Prompt-driven, tool-called voice agent (brain-in-prompt edition)
   - All caller-facing text is model-generated from the prompt (no hardcoded bot lines)
   - Tools are generic; model decides when to call them
   - Deepgram μ-law passthrough + ElevenLabs TTS
   - Verbose per-request logging for debugging external calls
*/

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

/* ===== Env / Config ===== */
const PORT = process.env.PORT || 5000;

/* Keys */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

/* Twilio (transfer + hangup) */
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_CALLER_ID   = process.env.TWILIO_CALLER_ID   || ""; // optional outbound callerId
const OWNER_PHONE        = process.env.OWNER_PHONE        || ""; // human transfer target

/* Business / routing identifiers */
const DASH_BIZ    = process.env.DASH_BIZ || "";
const DASH_SOURCE = process.env.DASH_SOURCE || "voice";

/* Business timezone */
const BIZ_TZ = process.env.BIZ_TZ || "America/New_York";

/* Optional env-driven hours gate (code only checks; wording is prompt-driven) */
const BIZ_HOURS_START = process.env.BIZ_HOURS_START || ""; // "09:00"
const BIZ_HOURS_END   = process.env.BIZ_HOURS_END   || "17:00";

/* External endpoints (Replit-first, then DASH_* fallback) */
const URLS = {
  CAL_READ:     process.env.REPLIT_READ_URL     || process.env.DASH_CAL_READ_URL     || "",
  CAL_CREATE:   process.env.REPLIT_CREATE_URL   || process.env.DASH_CAL_CREATE_URL   || "",
  CAL_DELETE:   process.env.REPLIT_DELETE_URL   || process.env.DASH_CAL_CANCEL_URL   || "",
  LEAD_UPSERT:  process.env.REPLIT_LEAD_URL     || process.env.DASH_LEAD_UPSERT_URL  || "",
  FAQ_LOG:      process.env.REPLIT_FAQ_URL      || process.env.DASH_CALL_LOG_URL     || "",
  CALL_LOG:     process.env.DASH_CALL_LOG_URL   || "",
  CALL_SUMMARY: process.env.DASH_CALL_SUMMARY_URL || "",
  PROMPT_FETCH: process.env.PROMPT_FETCH_URL    || ""
};

/* ===== HTTP debug wrappers ===== */
const DEBUG_HTTP = (process.env.DEBUG_HTTP ?? "true") === "true";
function rid() { return Math.random().toString(36).slice(2, 8); }
function isWatched(url) {
  if (!url) return false;
  if (url.startsWith("https://api.twilio.com/2010-04-01/Accounts")) return true;
  for (const u of Object.values(URLS)) if (u && url.startsWith(u)) return true;
  return url.startsWith("https://api.openai.com/");
}
function preview(obj, max=320) {
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch { return ""; }
}
async function httpPost(url, data, { headers={}, timeout=12000, auth, tag, trace } = {}) {
  const t = Date.now(), id = rid(), watched = isWatched(url);
  if (DEBUG_HTTP && watched) {
    console.log(JSON.stringify({ evt:"HTTP_REQ", id, tag, method:"POST", url, timeout, trace,
      payload_len: Buffer.byteLength(preview(data, 1<<20), "utf8"), at: new Date().toISOString() }));
  }
  try {
    const resp = await axios.post(url, data, { headers, timeout, auth, responseType: headers.acceptStream ? "stream" : undefined });
    if (DEBUG_HTTP && watched) {
      console.log(JSON.stringify({ evt:"HTTP_RES", id, tag, method:"POST", url,
        status: resp.status, ms: Date.now()-t, resp_preview: headers.acceptStream ? "[stream]" : preview(resp.data),
        at: new Date().toISOString(), trace }));
    }
    return resp;
  } catch (e) {
    const status = e.response?.status || 0;
    const bodyPrev = e.response ? preview(e.response.data) : "";
    console.warn(JSON.stringify({ evt:"HTTP_ERR", id, tag, method:"POST", url, status, ms: Date.now()-t,
      message: e.message, resp_preview: bodyPrev, at: new Date().toISOString() }));
    throw e;
  }
}
async function httpGet(url, { headers={}, timeout=12000, params, auth, tag, trace } = {}) {
  const t = Date.now(), id = rid(), watched = isWatched(url);
  if (DEBUG_HTTP && watched) {
    console.log(JSON.stringify({ evt:"HTTP_REQ", id, tag, method:"GET", url, timeout, params, trace, at: new Date().toISOString() }));
  }
  try {
    const resp = await axios.get(url, { headers, timeout, params, auth });
    if (DEBUG_HTTP && watched) {
      console.log(JSON.stringify({ evt:"HTTP_RES", id, tag, method:"GET", url,
        status: resp.status, ms: Date.now()-t, resp_preview: preview(resp.data), at: new Date().toISOString() }));
    }
    return resp;
  } catch (e) {
    const status = e.response?.status || 0;
    const bodyPrev = e.response ? preview(e.response.data) : "";
    console.warn(JSON.stringify({ evt:"HTTP_ERR", id, tag, method:"GET", url, status, ms: Date.now()-t,
      message: e.message, resp_preview: bodyPrev, at: new Date().toISOString() }));
    throw e;
  }
}

/* ===== Brain prompt (single source of truth) ===== */
const RENDER_PROMPT = process.env.RENDER_PROMPT || `
You are an AI phone receptionist for **The Victory Team (VictoryTeamSells.com)** — Maryland real estate.

Brand/Tone & Basics:
- Friendly, concise, confident, local. Hours Mon–Fri 9–5 (America/New_York).
- Office: 1316 E Churchville Rd, Bel Air, MD 21014. Main phone if asked: 833-888-1754.
- Services: buyer consults & tours, seller/listing consults (mention 1.75% model if asked), investors, general Q&A.
- Positioning (only if relevant): 600+ homes sold; $220M+ closed; Top 1%; 5★ reviews.

Interview style (anti-repeat):
- Ask one question at a time. Keep answers <15 words unless reading back.
- Maintain a scratchpad: Name, Phone, Role, Service, Property/MLS, Date, Time, Meeting Type, Notes.
- Before asking, check the scratchpad. If you have it, do not ask again.
- If the caller gives partial data (e.g., “443…”), ask only for the missing part.
- If the caller talks while you’re speaking, accept it—don’t re-ask.

Data to collect before booking:
- Full name, phone, role, service type, property/MLS (if showing), preferred date/time, meeting type, notes.

Scheduling policy:
- Use tools for read/hold/confirm. Resolve “today/tomorrow/next Tue” in America/New_York.
- Read back **once** then book. If slot taken, offer 2–3 nearby options.
- If a slot shows “canceled,” you may offer it.

Cancel/Reschedule identity (name + phone only):
- Require **full name + phone** on the booking. If caller says “this number,” use caller ID.
- Never call cancel blindly. Do this flow:
  1) READ with contact_name + contact_phone (and exact start time if provided) to find appointment(s).
  2) If exactly one future match, capture its `event_id`.
  3) For **cancel**: cancel by `event_id`.
  4) For **reschedule**: cancel by `event_id`, then propose 2–3 nearby times and book the chosen one.
  5) If none or multiple matches: ask only for the missing disambiguator (e.g., “what date/time was it?”). If still unclear, offer transfer.
- Only cancel/reschedule for the person on the booking (same name + phone).
- **Important**: When the caller gives a specific time (e.g., “tomorrow at 3 PM”), prefer a targeted read using `startISO`/`endISO` for that hour, not an all-day window. If the targeted read fails, *then* broaden (±1 day) and disambiguate briefly.

Tool rules:
- Always use tools for availability, booking, cancel/reschedule (via READ→CANCEL→BOOK), transfer, and logging.
- Do not invent tool outcomes. If a tool fails, say so briefly and offer next steps.

Outside hours:
- Capture name, number, service, best time to reach; promise a callback during business hours.

Operational guardrails (do not skip speaking):
- After ANY tool call, ALWAYS say something to the caller: either confirm the result, ask a single disambiguation question, or explain the next step. Never go silent after tools.

Identity & phone handling:
- If the caller gives partial digits (e.g., “443642” or “0617”), combine with known context:
  - Use caller ID as the base if they’ve said “this number.”
  - If a 6–7 digit fragment is given, interpret it as mid/last digits; prefer last-4 for confirmation.
  - Once you have a plausible full match from tools (name + phone), proceed without re-asking for digits.

Cancel flow (candidate handling):
- When cancel_appointment returns multiple candidates, read back SHORT options: “I found A) Wed 3–4 PM, B) Fri 11–12. Which should I cancel?”
- When exactly one future match returns, cancel it without reading the event_id; then confirm plainly: “All set—your Wed 3 PM is canceled.”

Error/empty results:
- If tools return empty or fail, say so briefly and propose one next step (try another date, transfer, or callback).

Brevity:
- Ask one question at a time. Avoid repeating requests for the same digits once you have enough to match.

End call (fast):
- When done: one short goodbye, then call `end_call`, then remain silent.

Greeting example (from prompt, not code):
- “Thanks for calling The Victory Team in Bel Air—how can I help today?”

Output:
- Short, natural voice responses.
`;

/* ===== HTTP + TwiML ===== */
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", (_, res) => res.status(200).send("OK: AI Voice Agent up"));

app.post("/twiml", (req, res) => {
  const from = req.body?.From || "";
  const callSid = req.body?.CallSid || "";
  console.log("[HTTP] /twiml", { from, callSid });

  res.set("Content-Type", "text/xml");
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${host}" track="inbound_track">
          <Parameter name="from" value="${from}"/>
          <Parameter name="CallSid" value="${callSid}"/>
          <Parameter name="callSid" value="${callSid}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim());
  console.log("[HTTP] TwiML served with host", host);
});

/* TwiML handoff target used during live transfer (no hardcoded speech) */
app.post("/handoff", (_req, res) => {
  const from = TWILIO_CALLER_ID || "";
  res.type("text/xml").send(`
    <Response>
      <Dial callerId="${from}">
        <Number>${OWNER_PHONE}</Number>
      </Dial>
    </Response>
  `.trim());
});

const server = app.listen(PORT, () => {
  console.log(`[INIT] listening on ${PORT}`);
  console.log("[INIT] URLS", URLS);
  console.log("[INIT] TENANT", { DASH_BIZ, DASH_SOURCE, BIZ_TZ });
});
const wss = new WebSocketServer({ server });

/* ===== Utilities ===== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- Time helpers ---- */
function toLocalParts(iso, tz) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12:false
  });
  const p = f.formatToParts(d).reduce((a,x)=> (a[x.type]=x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function asUTC(iso) { return new Date(iso).toISOString(); }
function dayWindowLocal(dateISO, tz) {
  const start_local = `${dateISO} 00:00`;
  const end_local   = `${dateISO} 23:59`;
  const start_utc = new Date(`${dateISO}T00:00:00`).toISOString();
  const end_utc   = new Date(`${dateISO}T23:59:00`).toISOString();
  return { start_local, end_local, start_utc, end_utc, timezone: tz };
}
function addDaysISO(dateISO, days) {
  const d = new Date(`${dateISO}T00:00:00`);
  d.setDate(d.getDate() + days);
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year:"numeric", month:"2-digit", day:"2-digit" });
  const p = f.formatToParts(d).reduce((a,x)=> (a[x.type]=x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function rangeWindowLocal(startDateISO, days, tz) {
  const start = dayWindowLocal(startDateISO, tz);
  const endDateISO = addDaysISO(startDateISO, Math.max(0, days - 1));
  const end = dayWindowLocal(endDateISO, tz);
  return {
    start_local: start.start_local,
    end_local:   end.end_local,
    start_utc:   start.start_utc,
    end_utc:     end.end_utc,
    timezone: tz
  };
}
function todayISOInTZ(tz){
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = f.formatToParts(new Date()).reduce((a,x)=> (a[x.type]=x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function withinBizHours(iso, tz){
  if (!BIZ_HOURS_START || !BIZ_HOURS_END) return true;
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false })
    .formatToParts(d).reduce((a,x)=> (a[x.type]=x.value, a), {});
  const h = +parts.hour, m = +parts.minute;
  const nowMin = h*60+m;
  const [sh,sm]=BIZ_HOURS_START.split(":").map(Number);
  const [eh,em]=BIZ_HOURS_END.split(":").map(Number);
  const startMin = sh*60+sm, endMin = eh*60+em;
  return nowMin >= startMin && nowMin < endMin;
}

/* ===== Natural-time intent guard ===== */
let LAST_UTTERANCE = "";
function parseUserTime(text=""){
  const rx = /(\b\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/ig;
  let m, last=null;
  while ((m = rx.exec(text))) last = m;
  if (!last) return null;
  let [_, h, mm, ap] = last;
  let hour = parseInt(h,10);
  const min = parseInt(mm||"0",10);
  const pm = /^p/i.test(ap);
  if (hour === 12) hour = pm ? 12 : 0;
  else if (pm) hour += 12;
  return { hour24: hour, min };
}
function localHourFromISO(iso, tz){
  const lp = toLocalParts(iso, tz);
  return parseInt(lp.slice(11,13),10);
}
function shiftISOByHours(iso, deltaHours){
  const d = new Date(iso);
  d.setHours(d.getHours()+deltaHours);
  return d.toISOString();
}
function adjustWindowToIntent({ startISO, endISO }, tz, lastText){
  const intent = parseUserTime(lastText||"");
  if (!intent) return {
    start_local: toLocalParts(startISO, tz),
    end_local:   toLocalParts(endISO, tz),
    start_utc:   asUTC(startISO),
    end_utc:     asUTC(endISO)
  };
  const providedLocalHour = localHourFromISO(startISO, tz);
  const delta = intent.hour24 - providedLocalHour;
  const startUTCAdj = shiftISOByHours(startISO, delta);
  const endUTCAdj   = shiftISOByHours(endISO,   delta);
  return {
    start_local: toLocalParts(startUTCAdj, tz),
    end_local:   toLocalParts(endUTCAdj, tz),
    start_utc:   startUTCAdj,
    end_utc:     endUTCAdj
  };
}

/* === Deepgram ASR (μ-law passthrough) === */
function startDeepgram({ onFinal }) {
  const url =
    "wss://api.deepgram.com/v1/listen"
    + "?encoding=mulaw"
    + "&sample_rate=8000"
    + "&channels=1"
    + "&model=nova-2-phonecall"
    + "&interim_results=true"
    + "&smart_format=true"
    + "&endpointing=1200";
  console.log("[Deepgram] connecting", url);
  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });
  dg.on("open", () => console.log("[Deepgram] open"));

  let lastInterimLog = 0;
  dg.on("message", (data) => {
    let ev; try { ev = JSON.parse(data.toString()); } catch { return; }
    const alt = ev.channel?.alternatives?.[0];
    const text = (alt?.transcript || "").trim();
    if (!text) return;
    if (ev.is_final || ev.speech_final) {
      console.log(`[ASR FINAL] ${text}`);
      onFinal?.(text);
    } else {
      const now = Date.now();
      if (now - lastInterimLog > 1500) {
        console.log(`[ASR interim] ${text}`);
        lastInterimLog = now;
      }
    }
  });
  dg.on("error", e => console.error("[Deepgram error]", e.message));
  dg.on("close", () => console.log("[Deepgram] closed"));
  return {
    sendULaw(buf){
      try { dg.send(buf); } catch(e){ console.error("[Deepgram send error]", e.message); }
    },
    close(){ try { dg.close(); } catch {} }
  };
}

/* === ElevenLabs TTS === */
function cleanTTS(s=""){
  return String(s)
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/^-+\s*/gm, "")
    .replace(/^\d+\.\s*/gm, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, ", ")
    .trim();
}
function formatPhoneForSpeech(s=""){
  const d = (s||"").replace(/\D+/g,"");
  if (d.length >= 10) {
    const ds = d.slice(-10);
    return `(${ds.slice(0,3)}) ${ds.slice(3,6)}-${ds.slice(6)}`;
  }
  return s;
}
function compressReadback(text=""){
  const pairs = [...text.matchAll(/(?:^|[\s,.-])(Name|Phone|Role|Service|Property|Address|MLS|Date\/Time|Date|Time|Meeting Type)\s*:\s*([^.;\n]+?)(?=(?:\s{2,}|[,.;]|$))/gi)];
  if (pairs.length >= 3) {
    const mapped = pairs.map(([,k,v]) => [k.toLowerCase(), v.trim()]);
    const get = key => (mapped.find(([k]) => k===key)?.[1] || "");
    const name = get("name");
    const phone = formatPhoneForSpeech(get("phone"));
    const role  = get("role");
    const svc   = get("service");
    const prop  = get("property") || get("address") || get("mls");
    const when  = get("date/time") || `${get("date")} ${get("time")}`.trim();
    const meet  = get("meeting type");
    const bits = [
      name && `${name}`, phone && `${phone}`,
      role && role, svc && svc, prop && prop, when && when, meet && meet
    ].filter(Boolean);
    if (bits.length) {
      const base = `Confirming: ${bits.join(", ")}. Shall I book it?`;
      return base;
    }
  }
  return text;
}
function shouldSpeak(ws, normalized=""){
  const now = Date.now();
  if (ws.__pendingHangupUntil && now < ws.__pendingHangupUntil) return false;
  return !(ws.__lastBotText === normalized && now - (ws.__lastBotAt || 0) < 4000);
}
async function say(ws, text) {
  if (!text || !ws.__streamSid) return;
  if (ws.readyState !== WebSocket.OPEN) { console.warn("[TTS] WS not open; drop speak"); return; }
  let polished = compressReadback(text).replace(/\bPhone:\s*([^\s].*?)\b/i, (_,p)=>formatPhoneForSpeech(p));
  const speak = cleanTTS(polished);
  if (!shouldSpeak(ws, speak)) return;

  ws.__lastBotText = speak;
  ws.__lastBotAt = Date.now();
  console.log(JSON.stringify({ event:"BOT_SAY", reply:speak }));
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn("[TTS] missing ElevenLabs credentials]");
    return;
  }
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;
    const resp = await httpPost(url, { text: speak, voice_settings:{ stability:0.4, similarity_boost:0.8 } },
      { headers:{ "xi-api-key":ELEVENLABS_API_KEY, acceptStream: true }, timeout: 20000, tag:"TTS_STREAM", trace:{ streamSid: ws.__streamSid } });
    resp.data.on("data", chunk => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const b64 = Buffer.from(chunk).toString("base64");
      ws.send(JSON.stringify({ event:"media", streamSid:ws.__streamSid, media:{ payload:b64 } }));
    });
    resp.data.on("end", () => console.log("[TTS] stream end"));
  } catch(e){ console.error("[TTS ERROR]", e.message); }
}

/* ===== Minimal Memory ===== */
function newMemory() {
  return {
    transcript: [],
    entities: { name:"", phone:"", service:"", date:"", time:"" },
    summary: ""
  };
}
function remember(mem, from, text){ mem.transcript.push({from, text}); if(mem.transcript.length>200) mem.transcript.shift(); }

/* ===== Track live websockets by call ===== */
const CALLS = new Map(); // callSid => ws

/* ===== Tool Registry (prompt-driven usage) ===== */
const Tools = {
  async read_availability({ dateISO, startISO, endISO, name, phone }) {
    console.log("[TOOL] read_availability", { dateISO, startISO, endISO, name: !!name, phone: !!phone });
    if (!URLS.CAL_READ) return { text:"" };
    try {
      // Use caller ID if model passed "this number" (prompt handles wording)
      const normalizedPhone = (phone && phone.trim()) || CURRENT_FROM || "";

      let windowObj;
      if (startISO && endISO) {
        const win = adjustWindowToIntent({ startISO, endISO }, BIZ_TZ, LAST_UTTERANCE);
        windowObj = { ...win };
      } else if (dateISO) {
        const w = dayWindowLocal(dateISO, BIZ_TZ);
        windowObj = { start_local: w.start_local, end_local: w.end_local, start_utc: w.start_utc, end_utc: w.end_utc };
      } else {
        const today = todayISOInTZ(BIZ_TZ);
        const w = dayWindowLocal(today, BIZ_TZ);
        windowObj = { start_local: w.start_local, end_local: w.end_local, start_utc: w.start_utc, end_utc: w.end_utc };
      }

      const payload = {
        intent:"READ",
        biz: DASH_BIZ,
        source: DASH_SOURCE,
        timezone: BIZ_TZ,
        window: windowObj,
        // Optional contact filters for lookup (used by model during cancel/reschedule identity check)
        contact_name: name || undefined,
        contact_phone: normalizedPhone || undefined
      };
      const { data } = await httpPost(URLS.CAL_READ, payload, {
        timeout:12000, tag:"CAL_READ",
        trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid }
      });
      return { data };
    } catch(e){ return { text:"" }; }
  },

  async book_appointment({ name, phone, service, startISO, endISO, notes }) {
    console.log("[TOOL] book_appointment", { hasName: !!name, service, startISO, endISO });
    if (!URLS.CAL_CREATE) return { text:"" };
    try {
      const normalizedPhone = (phone && phone.trim()) || CURRENT_FROM || "";

      if (!withinBizHours(startISO, BIZ_TZ)) {
        // The model will phrase any constraint; we just proceed or let the backend refuse.
      }

      const win = adjustWindowToIntent({ startISO, endISO }, BIZ_TZ, LAST_UTTERANCE);
      const payload = {
        biz: DASH_BIZ,
        source: DASH_SOURCE,
        Event_Name: `${service||"Appointment"} (${name||"Guest"})`,
        Timezone: BIZ_TZ,
        Start_Time_Local: win.start_local,
        End_Time_Local:   win.end_local,
        Start_Time_UTC:   win.start_utc,
        End_Time_UTC:     win.end_utc,
        Customer_Name: name||"",
        Customer_Phone: normalizedPhone,
        Customer_Email: "",
        Notes: notes||service||""
      };
      const { data } = await httpPost(URLS.CAL_CREATE, payload, {
        timeout:12000, tag:"CAL_CREATE",
        trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid }
      });
      return { data, ok:true };
    } catch(e){ return { text:"", ok:false }; }
  },

  // **** UPDATED: lookup first, then cancel by event_id; broaden search if date not supplied
  async cancel_appointment({ event_id, name, phone, dateISO }) {
    console.log("[TOOL] cancel_appointment", { event_id_present: !!event_id, hasName: !!name });
    if (!URLS.CAL_DELETE || !URLS.CAL_READ) return { text:"", ok:false };

    const normalizedPhone = (phone && phone.trim()) || CURRENT_FROM || "";

    try {
      let id = event_id;

      // If no event_id, look it up by name+phone (optionally narrow by date)
      if (!id) {
        // If the model didn't pass a date, search a 3-day window starting today to catch “tomorrow” cases.
        const baseDate = todayISOInTZ(BIZ_TZ);
        const windowObj = dateISO
          ? dayWindowLocal(dateISO, BIZ_TZ)
          : rangeWindowLocal(baseDate, 3, BIZ_TZ);

        const readPayload = {
          intent: "READ",
          biz: DASH_BIZ,
          source: DASH_SOURCE,
          timezone: BIZ_TZ,
          window: {
            start_local: windowObj.start_local,
            end_local:   windowObj.end_local,
            start_utc:   windowObj.start_utc,
            end_utc:     windowObj.end_utc
          },
          contact_name: name || undefined,
          contact_phone: normalizedPhone || undefined
        };

        const { data: readData } = await httpPost(URLS.CAL_READ, readPayload,
          { timeout:12000, tag:"CAL_READ", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });

        const future = (readData?.events || []).filter(e => e.status !== "canceled");
        if (future.length === 1) {
          id = future[0].event_id;
        } else {
          return { ok:false, candidates: future.map(e => ({
            event_id: e.event_id,
            start_local: e.start_local,
            event_name: e.event_name
          })) };
        }
      }

      // cancel by event_id
      const { data, status } = await httpPost(URLS.CAL_DELETE, {
        intent: "DELETE",
        biz: DASH_BIZ,
        source: DASH_SOURCE,
        event_id: id
      }, { timeout:12000, tag:"CAL_DELETE", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });

      const ok = (status>=200&&status<300) || data?.ok === true || data?.deleted === true;
      return { ok, data };
    } catch(e) {
      return { text:"", ok:false };
    }
  },

  async lead_upsert({ name, phone, intent, notes }) {
    console.log("[TOOL] lead_upsert]", { name, intent });
    if (!URLS.LEAD_UPSERT) return { text:"" };
    try {
      const { data } = await httpPost(URLS.LEAD_UPSERT,
        { biz:DASH_BIZ, source:DASH_SOURCE, name, phone, intent, notes },
        { timeout: 8000, tag:"LEAD_UPSERT", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
      return { data };
    } catch { return { text:"" }; }
  },

  async faq({ topic, service }) {
    console.log("[TOOL] faq", { topic, service });
    try {
      if (URLS.FAQ_LOG) {
        await httpPost(URLS.FAQ_LOG, { biz:DASH_BIZ, source:DASH_SOURCE, topic, service },
          { timeout:8000, tag:"FAQ_LOG", trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } });
      }
    } catch {}
    return { data:{ topic, service } };
  },

  async transfer({ reason, callSid }) {
    console.log("[TOOL] transfer", { reason, callSid, owner: OWNER_PHONE });
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OWNER_PHONE || !callSid) {
      return { text:"" };
    }
    try {
      const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
      const handoffUrl = `https://${host}/handoff`;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
      const params = new URLSearchParams({ Url: handoffUrl, Method: "POST" });
      const auth = { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN };
      await httpPost(url, params, {
        auth, timeout: 10000, tag:"TWILIO_REDIRECT",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        trace:{ callSid, convoId: currentTrace.convoId }
      });
      return { text:"" };
    } catch { return { text:"" }; }
  },

  // **** UPDATED: fast hangup that also mutes any further TTS
  async end_call({ callSid, reason }) {
    console.log("[TOOL] end_call", { callSid, reason });

    // Immediately prevent any further speech on this call
    const w = CALLS.get(callSid);
    if (w) w.__pendingHangupUntil = Date.now() + 999999;

    // Hang up ASAP via Twilio
    try {
      if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && callSid) {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(callSid)}.json`;
        const params = new URLSearchParams({ Status: "completed" });
        await httpPost(url, params, {
          auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
          timeout: 8000,
          tag: "TWILIO_HANGUP",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          trace: { callSid, reason: "model end_call", convoId: currentTrace.convoId }
        });
      }
    } catch (e) {
      console.warn("[end_call] hangup error", e.message);
    }
    return { text:"" };
  }
};

/* Tool schema advertised to the model (prompt drives what to ask; schema only enables actions) */
const toolSchema = [
  { type:"function", function:{
      name:"read_availability",
      description:"Read calendar availability in a given window. Optionally filter by contact (name+phone) to verify identity or find existing bookings.",
      parameters:{ type:"object", properties:{
        dateISO:{type:"string", description:"YYYY-MM-DD in business timezone"},
        startISO:{type:"string", description:"ISO start"},
        endISO:{type:"string", description:"ISO end"},
        name:{type:"string"},
        phone:{type:"string"}
      }, required:[] }
  }},
  { type:"function", function:{
      name:"book_appointment",
      description:"Create a calendar event.",
      parameters:{ type:"object", properties:{
        name:{type:"string"}, phone:{type:"string"}, service:{type:"string"},
        startISO:{type:"string"}, endISO:{type:"string"}, notes:{type:"string"}
      }, required:["service","startISO","endISO"] }
  }},
  { type:"function", function:{
      name:"cancel_appointment",
      description:"Cancel a calendar event by event_id, or by (name+phone) when the id is unknown.",
      parameters:{ type:"object", properties:{
        event_id:{type:"string"},
        name:{type:"string"},
        phone:{type:"string"},
        dateISO:{type:"string", description:"Optional YYYY-MM-DD to narrow lookup in business timezone"}
      }, required:[] }
  }},
  { type:"function", function:{
      name:"lead_upsert",
      description:"Create or update a lead/contact for this caller",
      parameters:{ type:"object", properties:{
        name:{type:"string"}, phone:{type:"string"}, intent:{type:"string"}, notes:{type:"string"}
      }, required:["name","phone"] }
  }},
  { type:"function", function:{
      name:"faq",
      description:"Log or answer FAQs like hours, prices, services, location",
      parameters:{ type:"object", properties:{ topic:{type:"string"}, service:{type:"string"} }, required:[] }
  }},
  { type:"function", function:{
      name:"transfer",
      description:"Transfer the caller to a human",
      parameters:{ type:"object", properties:{ reason:{type:"string"}, callSid:{type:"string"} }, required:[] }
  }},
  { type:"function", function:{
      name:"end_call",
      description:"Politely end the call immediately after your own spoken goodbye",
      parameters:{ type:"object", properties:{ callSid:{type:"string"}, reason:{type:"string"} }, required:[] }
  }}
];

/* ===== LLM ===== */
async function openaiChat(messages, options={}){
  const headers = { Authorization:`Bearer ${OPENAI_API_KEY}` };
  const body = {
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages,
    tools: toolSchema,
    tool_choice: "auto",
    response_format: { type: "text" },
    ...options
  };
  const { data } = await httpPost("https://api.openai.com/v1/chat/completions", body, {
    headers, timeout: 30000, tag:"OPENAI_CHAT", trace: { convoId: currentTrace.convoId, callSid: currentTrace.callSid }
  });
  return data.choices?.[0];
}

/* Build system prompt with runtime facts; model handles all phrasing */
function buildSystemPrompt(mem, tenantPrompt) {
  const todayISO = todayISOInTZ(BIZ_TZ);
  const p = (tenantPrompt || RENDER_PROMPT);
  return [
    { role:"system", content: `Today is ${todayISO}. Business timezone: ${BIZ_TZ}. Resolve relative dates in this timezone.` },
    { role:"system", content: p },
    { role:"system", content:
      `Hard constraints:
       - Use tools for availability, booking, canceling, transfer, FAQ logging, lead capture, and hangup.
       - Do not fabricate tool outcomes. If a tool fails, explain briefly and offer next steps.
       - Keep replies concise and natural. All caller-facing words are your choice.
       - One goodbye line only. When you decide the call should end, call end_call.` },
    { role:"system", content: `<memory_summary>${mem.summary}</memory_summary>` }
  ];
}

/* Turn user/bot text into chat messages */
function buildMessages(mem, userText, tenantPrompt) {
  const sys = buildSystemPrompt(mem, tenantPrompt);
  const history = mem.transcript.slice(-12).map(m =>
    ({ role: m.from === "user" ? "user" : "assistant", content: m.text })
  );
  return [...sys, ...history, { role:"user", content:userText }];
}

/* ===== WS wiring ===== */
let currentTrace = { convoId:"", callSid:"" };
let CURRENT_FROM = "";

wss.on("connection", (ws) => {
  console.log("[WS] connection from Twilio]");
  let dg = null;
  let pendingULaw = [];
  const BATCH = 10; // ~200ms @ 8kHz
  let tailTimer = null;
  let lastMediaLog = 0;

  // Per-call state
  ws.__handling = false;
  ws.__queuedTurn = null;
  ws.__lastUserText = "";
  ws.__lastUserAt = 0;
  ws.__pendingFinal = "";
  ws.__finalTimer = null;

  // Closing state
  ws.__closing = false;
  ws.__saidFarewell = false;

  // Dedup speech
  ws.__lastBotText = "";
  ws.__lastBotAt = 0;

  // Logging
  ws.__postedLog = false;

  // Graceful hangup window
  ws.__hangTimer = null;
  ws.__pendingHangupUntil = 0;

  // Heartbeat
  const hb = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) { try { ws.ping(); } catch {} }
  }, 15000);

  function clearHangTimer() {
    if (ws.__hangTimer) { clearTimeout(ws.__hangTimer); ws.__hangTimer = null; }
    ws.__pendingHangupUntil = 0;
  }
  function scheduleHangup(ms = 2500) {
    clearHangTimer();
    ws.__pendingHangupUntil = Date.now() + ms;
    ws.__hangTimer = setTimeout(async () => {
      try {
        if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && ws.__callSid) {
          const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(ws.__callSid)}.json`;
          const params = new URLSearchParams({ Status: "completed" });
          const auth = { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN };
          await httpPost(url, params, {
            auth, timeout: 10000, tag:"TWILIO_HANGUP",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            trace:{ callSid: ws.__callSid, reason: "model end_call", convoId: currentTrace.convoId }
          });
        }
      } catch(e) { console.warn("[HANGUP] error", e.message); }
      try { ws.close(); } catch {}
      setTimeout(() => { try { ws.terminate?.(); } catch {} }, 1500);
    }, ms);
  }
  function flushULaw() {
    if (!pendingULaw.length || !dg) return;
    const chunk = Buffer.concat(pendingULaw);
    pendingULaw = [];
    const now = Date.now();
    if (now - lastMediaLog > 2000) {
      console.log("[MEDIA] flush", { frames: Math.round(chunk.length / 160), bytes: chunk.length });
      lastMediaLog = now;
    }
    dg.sendULaw(chunk);
  }

  async function postCallLogOnce(ws, reason) {
    if (ws.__postedLog) return;
    ws.__postedLog = true;

    const trace = { convoId: ws.__convoId || "", callSid: ws.__callSid || "", from: ws.__from || "" };

    const transcriptArr = ws.__mem?.transcript || [];
    const transcriptText = transcriptArr.map(t => `${t.from}: ${t.text}`).join("\n");

    const payload = {
      biz: DASH_BIZ,
      source: DASH_SOURCE,
      convoId: trace.convoId,
      callSid: trace.callSid,
      from: trace.from,
      summary: ws.__mem?.summary || "",
      transcript: transcriptText,
      ended_reason: reason || ""
    };

    try {
      if (URLS.CALL_LOG) {
        await httpPost(URLS.CALL_LOG, payload, { timeout: 10000, tag:"CALL_LOG", trace });
      } else {
        console.warn("[CALL_LOG] URL missing");
      }
    } catch {}

    try {
      if (URLS.CALL_SUMMARY) {
        await httpPost(URLS.CALL_SUMMARY, payload, {
          timeout: 8000, tag:"CALL_SUMMARY", trace
        });
      } else {
        console.warn("[CALL_SUMMARY] URL missing");
      }
    } catch {}
  }

  ws.__mem = newMemory();

  // === Tool-call resolver (NEW) ===
  async function resolveToolChain(baseMessages) {
    let messages = baseMessages.slice();
    for (let hops = 0; hops < 8; hops++) {
      const choice = await openaiChat(messages);
      const msg = choice?.message || {};
      if (!msg.tool_calls?.length) return msg.content?.trim() || "";

      for (const tc of msg.tool_calls) {
        const name = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        if ((name === "transfer" || name === "end_call") && !args.callSid) args.callSid = ws.__callSid || "";

        console.log("[TOOL] call ->", name, args);
        const impl = Tools[name];
        let toolResult = { text:"" };
        try { toolResult = await (impl ? impl(args) : { text:"" }); }
        catch(e){ console.error("[TOOL] error", name, e.message); toolResult = { text:"" }; }

        // Append tool result and keep looping; the model may chain tools
        messages = [...messages, msg, { role:"tool", tool_call_id: tc.id, content: JSON.stringify(toolResult) }];

        if (name === "end_call") {
          ws.__saidFarewell = true;
          ws.__closing = true;
          scheduleHangup(2500);
        }
      }
    }
    return ""; // safety fallback
  }

  ws.on("message", async raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      ws.__convoId = uuidv4();
      const cp = msg.start?.customParameters || {};
      ws.__from = cp.from || "";
      CURRENT_FROM = ws.__from || "";
      ws.__callSid = cp.CallSid || cp.callSid || "";
      currentTrace = { convoId: ws.__convoId, callSid: ws.__callSid };
      console.log("[CALL_START]", { convoId: ws.__convoId, streamSid: ws.__streamSid, from: ws.__from, callSid: ws.__callSid });

      // track socket by callSid (for fast hangup mute)
      if (ws.__callSid) {
        CALLS.set(ws.__callSid, ws);
        ws.on("close", () => { if (ws.__callSid) CALLS.delete(ws.__callSid); });
      }

      // Fetch tenant-specific prompt if present
      ws.__tenantPrompt = "";
      if (URLS.PROMPT_FETCH) {
        try {
          const { data } = await httpGet(
            `${URLS.PROMPT_FETCH}?biz=${encodeURIComponent(DASH_BIZ)}`,
            { timeout: 10000, tag:"PROMPT_FETCH", trace:{ convoId: ws.__convoId, callSid: ws.__callSid } }
          );
          if (data?.prompt) ws.__tenantPrompt = data.prompt;
          console.log("[PROMPT_FETCH] ok", { hasPrompt: !!data?.prompt });
        } catch(e){
          console.warn("[PROMPT_FETCH] error", e.message);
        }
      }

      dg = startDeepgram({
        onFinal: async (text) => {
          const now = Date.now();
          // de-dupe
          if (text === ws.__lastUserText && (now - ws.__lastUserAt) < 1500) {
            console.log("[TURN] dropped duplicate final");
            return;
          }
          ws.__lastUserText = text;
          ws.__lastUserAt = now;

          LAST_UTTERANCE = text;

          // "this number" → capture caller ID (prompt decides when to say it)
          if (/^\s*this\s+number\b/i.test(text) && ws.__from) {
            ws.__mem.entities.phone = ws.__from;
          }

          // Debounce obviously incomplete finals to avoid back-to-back questions
          const looksPartial = (() => {
            const s = text.trim().toLowerCase();
            if (!s) return false;
            if (/\b(let's do|do|set|make|schedule|tomorrow|today|on|for|at|around|before|after)$/.test(s)) return true;
            if (/\b(tomorrow at|today at|next (mon|tue|wed|thu|fri|sat|sun) at)$/.test(s)) return true;
            return false;
          })();
          if (looksPartial) {
            clearTimeout(ws.__finalTimer);
            ws.__pendingFinal = text;
            ws.__finalTimer = setTimeout(async () => {
              if (ws.__handling) { ws.__queuedTurn = ws.__pendingFinal; ws.__pendingFinal = ""; return; }
              ws.__handling = true;
              remember(ws.__mem, "user", ws.__pendingFinal);
              await handleTurn(ws, ws.__pendingFinal);
              ws.__pendingFinal = "";
              ws.__handling = false;

              if (ws.__queuedTurn) {
                const next = ws.__queuedTurn; ws.__queuedTurn = null;
                ws.__handling = true; remember(ws.__mem, "user", next);
                await handleTurn(ws, next); ws.__handling = false;
              }
            }, 900);
            return;
          }

          if (ws.__handling) {
            ws.__queuedTurn = text;
            return;
          }
          ws.__handling = true;
          remember(ws.__mem, "user", text);
          await handleTurn(ws, text);
          ws.__handling = false;

          if (ws.__queuedTurn) {
            const next = ws.__queuedTurn;
            ws.__queuedTurn = null;
            ws.__handling = true;
            remember(ws.__mem, "user", next);
            await handleTurn(ws, next);
            ws.__handling = false;
          }
        }
      });

      // Prompt-driven greeting
      ws.__handling = true;
      await handleTurn(ws, "<CALL_START>");
      ws.__handling = false;

      return;
    }

    if (msg.event === "media") {
      if (!dg) return;
      const ulaw = Buffer.from(msg.media?.payload || "", "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= BATCH) flushULaw();
      clearTimeout(tailTimer);
      tailTimer = setTimeout(flushULaw, 120);
      return;
    }

    if (msg.event === "stop") {
      console.log("[CALL_STOP]", { convoId: ws.__convoId });
      ws.__closing = true;
      ws.__stopSeenAt = Date.now();
      try { flushULaw(); } catch {}
      try { dg?.close(); } catch {}
      await postCallLogOnce(ws, "twilio stop");
      try { ws.close(); } catch {}
      return;
    }
  });

  ws.on("close", async () => {
    try { dg?.close(); } catch {}
    clearHangTimer();
    clearInterval(hb);
    await postCallLogOnce(ws, "socket close");
    console.log("[WS] closed", { convoId: ws.__convoId });
  });

  /* ===== Turn handler ===== */
  async function handleTurn(ws, userText) {
    if (ws.__closing || ws.readyState !== WebSocket.OPEN) return;
    console.log("[TURN] user >", userText);

    const messages = buildMessages(ws.__mem, userText, ws.__tenantPrompt);

    // NEW: Resolve tool chains until the model returns plain text
    const finalText = await resolveToolChain(messages);

    if (finalText) {
      await say(ws, finalText);
      remember(ws.__mem, "bot", finalText);
    }

    if (ws.__closing && !ws.__saidFarewell) {
      ws.__saidFarewell = true;
      scheduleHangup(2500);
    }

    await updateSummary(ws.__mem);
  }
});

/* ===== Rolling summary ===== */
async function updateSummary(mem) {
  const last = mem.transcript.slice(-16).map(m => `${m.from}: ${m.text}`).join("\n");
  try {
    const { data } = await httpPost(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          { role:"system", content:`Summarize the dialog in 2 lines. Include name, phone, service, date/time if known. TZ=${BIZ_TZ}.` },
          { role:"user", content: last }
        ]
      },
      { headers:{ Authorization:`Bearer ${OPENAI_API_KEY}` }, timeout: 20000, tag:"OPENAI_SUMMARY",
        trace:{ convoId: currentTrace.convoId, callSid: currentTrace.callSid } }
    );
    mem.summary = data.choices?.[0]?.message?.content?.trim()?.slice(0, 500) || "";
    console.log("[SUMMARY] len", mem.summary.length);
  } catch(e){
    console.warn("[SUMMARY] error", e.message);
  }
}

/* ===== Notes =====
- All caller-facing text is model-generated from the prompt.
- No hardcoded greeting, confirmations, transfer lines, or goodbye.
- end_call is model-triggered; server only executes the hangup after TTS.
- Time-intent guard aligns model-supplied ISO with user-spoken times.
- Tool-call resolver ensures chained tools (READ → CANCEL → BOOK) speak a final result.
*/
