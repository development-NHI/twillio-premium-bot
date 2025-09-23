// server.js — Old Line Barbershop AI Receptionist (Deepgram + GPT + ElevenLabs + Dashboard)

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

/* ===== ENV ===== */
const PORT = process.env.PORT || 5000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

/* Dashboard endpoints */
const DASH_CAL_READ_URL   = process.env.DASH_CAL_READ_URL   || "";
const DASH_CAL_CREATE_URL = process.env.DASH_CAL_CREATE_URL || "";
const DASH_CAL_CANCEL_URL = process.env.DASH_CAL_CANCEL_URL || "";
const DASH_LEAD_UPSERT_URL   = process.env.DASH_LEAD_UPSERT_URL   || "";
const DASH_CALL_LOG_URL      = process.env.DASH_CALL_LOG_URL      || "";
const DASH_CALL_SUMMARY_URL  = process.env.DASH_CALL_SUMMARY_URL  || "";
const DASH_BIZ    = process.env.DASH_BIZ    || "oldline";
const DASH_SOURCE = process.env.DASH_SOURCE || "voice";

/* Biz timezone and numbers */
const BIZ_TZ = process.env.BIZ_TZ || "America/New_York";
const BUSINESS_NUMBER = process.env.BUSINESS_NUMBER || "";
const OWNER_PHONE = process.env.OWNER_PHONE || "";
const DEST_NUMBER = BUSINESS_NUMBER || OWNER_PHONE || "";

/* Twilio transfer */
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_CALLER_ID   = process.env.TWILIO_CALLER_ID   || "";

if (!OPENAI_API_KEY) console.warn("(!) OPENAI_API_KEY missing");
if (!DEEPGRAM_API_KEY) console.warn("(!) DEEPGRAM_API_KEY missing");
if (!ELEVENLABS_API_KEY) console.warn("(!) ELEVENLABS_API_KEY missing");

/* ===== APP ===== */
const app = express();
app.use(bodyParser.json());

app.get("/", (_, res) => res.status(200).send("✅ Old Line Barbershop AI Receptionist running"));

app.post("/twiml", (req, res) => {
  res.set("Content-Type", "text/xml");
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
  const twiml = `
    <Response>
      <Connect>
        <Stream name="dg" url="wss://${host}">
          <Parameter name="from" value="{{From}}"/>
          <Parameter name="to" value="{{To}}"/>
          <Parameter name="callSid" value="{{CallSid}}"/>
        </Stream>
      </Connect>
    </Response>
  `.trim();
  res.send(twiml);
});

app.post("/xfer", (req, res) => {
  res.set("Content-Type", "text/xml");
  const callerAttr = TWILIO_CALLER_ID ? ` callerId="${TWILIO_CALLER_ID}"` : "";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stop><Stream name="dg"/></Stop>
  <Say>Connecting you to the owner now.</Say>
  <Dial${callerAttr}><Number>${OWNER_PHONE}</Number></Dial>
</Response>`;
  res.send(twiml);
});

const server = app.listen(PORT, () => console.log(`[INFO] Server running on ${PORT}`));
const wss = new WebSocketServer({ server });

/* ===== LOG HELPERS ===== */
function preview(val, max = 240) {
  try {
    const s = typeof val === "string" ? val : JSON.stringify(val);
    const red = s.replace(/(\+?1?\d{0,6})\d{2,6}(\d{2})/g, "$1…redacted…$2");
    return red.length > max ? red.slice(0, max) + "…" : red;
  } catch { return String(val).slice(0, max); }
}
async function httpLog(label, fn) {
  const t0 = Date.now();
  try {
    const resp = await fn();
    console.log(`[HTTP OK] ${label} ${Date.now() - t0}ms`);
    return resp;
  } catch (e) {
    console.error(
      `[HTTP ERR] ${label} ${Date.now() - t0}ms status=${e?.response?.status} body=${preview(e?.response?.data)} msg=${e?.message}`
    );
    throw e;
  }
}

/* ===== UTIL ===== */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTH_LOOKUP = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };

function formatISODateInTZ(d = new Date(), tz = BIZ_TZ) {
  return d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
}
function nowInTZ(tz = BIZ_TZ) { return formatISODateInTZ(new Date(), tz); }
function addDaysISO(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function dowOfISO(iso) { return new Date(iso + "T00:00:00Z").getUTCDay(); }
function weekdayToISO(weekday, tz = BIZ_TZ) {
  const map = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
  const key = (weekday || "").toLowerCase();
  if (!(key in map)) return "";
  const todayISO = nowInTZ(tz);
  const todayIdx = dowOfISO(todayISO);
  let target = map[key];
  let delta = target - todayIdx;
  if (delta <= 0) delta += 7;
  return addDaysISO(todayISO, delta);
}
function parseMonthDayToISO(txt) {
  if (!txt) return "";
  const t = txt.trim().toLowerCase();
  if (["tmr","tmrw","tmmrw"].includes(t)) return addDaysISO(nowInTZ(BIZ_TZ), 1);
  let m = /^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(t);
  if (m) {
    const mm = MONTH_LOOKUP[m[1].slice(0,3)];
    const dd = parseInt(m[2], 10);
    if (mm && dd >= 1 && dd <= 31) {
      const yyyy = new Date().getFullYear();
      return `${yyyy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
    }
  }
  m = /^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/.exec(t);
  if (m) {
    const mm = parseInt(m[1], 10);
    const dd = parseInt(m[2], 10);
    let yyyy = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
    if (yyyy < 100) yyyy += 2000;
    if (mm >=1 && mm <=12 && dd >=1 && dd <=31) {
      return `${yyyy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
    }
  }
  return "";
}
function coerceToThisYearIfLikely(isoMaybe) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoMaybe || "");
  if (!m) return isoMaybe;
  const yyyyNow = new Date().getFullYear();
  const yyyy = parseInt(m[1],10);
  if (yyyy !== yyyyNow) return `${yyyyNow}-${m[2]}-${m[3]}`;
  return isoMaybe;
}
function normalizeDate(d) {
  if (!d) return "";
  const t = d.toLowerCase().trim();
  if (t === "today") return nowInTZ(BIZ_TZ);
  if (["tomorrow","tmr","tmrw","tmmrw"].includes(t)) return addDaysISO(nowInTZ(BIZ_TZ), 1);
  const w = weekdayToISO(t, BIZ_TZ);
  if (w) return w;
  const natural = parseMonthDayToISO(t);
  if (natural) return natural;
  const pass = coerceToThisYearIfLikely(d);
  return pass;
}
function normalizeService(s) {
  if (!s) return "";
  const t = s.toLowerCase();
  if (/\b(combo|both|haircut\s*(?:\+|and|&)\s*beard|hair\s*and\s*beard)\b/.test(t)) return "combo";
  if (/\bbeard\b|line\s*up/.test(t)) return "beard trim";
  if (/\bhair\s*cut\b|\bhaircut\b|\bcut\b/.test(t)) return "haircut";
  return "";
}
function normalizePhone(num) {
  if (!num) return "";
  const d = num.replace(/\D/g, "");
  const ten = d.length >= 10 ? d.slice(-10) : "";
  return ten;
}
function ordinal(n) { const s = ["th","st","nd","rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function formatDateSpoken(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  return `${MONTHS[mm - 1]} ${ordinal(dd)}`;
}
function to12h(t) {
  if (!t) return "";
  if (/am|pm/i.test(t)) {
    const up = t.toUpperCase().replace(/\s+/g, " ").trim();
    return up.includes("AM") || up.includes("PM") ? up : up + " PM";
  }
  const m = /^(\d{1,2}):?(\d{2})$/.exec(t);
  if (!m) return t;
  let hh = Number(m[1]); const mm = m[2];
  const ampm = hh >= 12 ? "PM" : "AM"; if (hh === 0) hh = 12; if (hh > 12) hh -= 12;
  return `${hh}:${mm}`.replace(":00", "") + ` ${ampm}`;
}
function isWeekend(dateISO) { const d = new Date(dateISO + "T00:00:00Z"); const day = d.getUTCDay(); return day === 0 || day === 6; }
function isWithinHours(timeStr) {
  if (!timeStr) return false;
  let hh = 0, mm = 0;
  const ampm = /am|pm/i.test(timeStr);
  if (ampm) {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(timeStr.trim().toUpperCase());
    if (!m) return false;
    hh = parseInt(m[1] || "0", 10); mm = parseInt(m[2] || "0", 10); const isPM = m[3] === "PM";
    if (hh === 12) hh = isPM ? 12 : 0; else if (isPM) hh += 12;
  } else { const m = /^(\d{1,2}):?(\d{2})$/.exec(timeStr.trim()); if (!m) return false; hh = parseInt(m[1] || "0", 10); mm = parseInt(m[2] || "0", 10); }
  const minutes = hh * 60 + mm; const start = 9 * 60; const end = 17 * 60; return minutes >= start && minutes <= end;
}

/* === TZ helpers: convert local wall time in BIZ_TZ to UTC ISO === */
function parseShortOffset(off) {
  // "GMT-4", "UTC+01", "GMT+00"
  const m = /(GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?/i.exec(off || "");
  if (!m) return 0;
  const sign = m[2] === "-" ? -1 : 1;
  const hh = parseInt(m[3] || "0", 10);
  const mm = parseInt(m[4] || "0", 10);
  return sign * (hh * 60 + mm);
}
function tzOffsetMinutesAt(tz, approxUtcMs) {
  // Use timeZoneName 'shortOffset' to read the numeric GMT offset at that instant.
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" });
  const parts = dtf.formatToParts(new Date(approxUtcMs));
  const off = (parts.find(p => p.type === "timeZoneName") || {}).value || "GMT+00";
  return parseShortOffset(off);
}
function wallTimeToUtcMs({ Y, M, D, h, m }, tz) {
  // Start from UTC guess, then adjust by the offset at that instant.
  const utcGuess = Date.UTC(Y, M - 1, D, h, m, 0);
  const offMin = tzOffsetMinutesAt(tz, utcGuess);
  // If local = wall, then UTC = local time - offset
  return utcGuess - offMin * 60 * 1000;
}
function buildStartEndISO(dateISO, timeStr, service) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO || "");
  const hhmm = to24h(timeStr);
  if (!m || !hhmm) return { startISO: "", endISO: "" };
  const [Y, M, D] = [parseInt(m[1],10), parseInt(m[2],10), parseInt(m[3],10)];
  const [h, mm] = hhmm.split(":").map(Number);
  const startMs = wallTimeToUtcMs({ Y, M, D, h, m: mm }, BIZ_TZ);
  const mins = durationMinutesForService(service);
  const endMs = startMs + mins * 60000;
  return { startISO: new Date(startMs).toISOString(), endISO: new Date(endMs).toISOString() };
}
function durationMinutesForService(service) {
  const s = (service || "").toLowerCase();
  if (s === "haircut") return 30;
  if (s === "beard trim") return 15;
  if (s === "combo") return 45;
  return 30;
}
function dayBoundsISO(dateISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO || "");
  if (!m) return { startISO: "", endISO: "" };
  const [Y, M, D] = [parseInt(m[1],10), parseInt(m[2],10), parseInt(m[3],10)];
  const startMs = wallTimeToUtcMs({ Y, M, D, h: 0, m: 0 }, BIZ_TZ);
  const endMs   = wallTimeToUtcMs({ Y, M, D, h: 23, m: 59 }, BIZ_TZ);
  return { startISO: new Date(startMs).toISOString(), endISO: new Date(endMs).toISOString() };
}
function humanWhen(dateISO, timeStr) { const dSpoken = formatDateSpoken(dateISO); const tSpoken = to12h(timeStr); return tSpoken ? `${dSpoken} at ${tSpoken}` : dSpoken; }

/* Follow-ups */
function extractServiceFromSummary(summary) { const m = /^([^(]+)\s*\(/.exec(String(summary || "")); return m ? m[1].trim().toLowerCase() : ""; }
function isAskingTime(text) { return /\b(what time|at what time|what's the time|what time is (it|that)|when is (it|that))\b/i.test(text || ""); }
function isAskingDate(text) { return /\b(what (?:date|day)|which (?:date|day))\b/i.test(text || ""); }

/* ===== Dashboard POST fallback (JSON then form) ===== */
async function postJsonOrForm(url, obj, label) {
  return httpLog(label, async () => {
    try {
      return await axios.post(url, obj, { timeout: 10000 });
    } catch (e) {
      const form = new URLSearchParams();
      for (const [k,v] of Object.entries(obj)) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      return await axios.post(url, form, { timeout: 10000, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    }
  });
}

/* ===== DASHBOARD API ===== */
async function dashReadWindow(startISO, endISO) {
  if (!DASH_CAL_READ_URL) return { ok: false, events: [], reason: "no_url" };
  try {
    const payload = { biz: DASH_BIZ, source: DASH_SOURCE, window: { start: startISO, end: endISO } };
    console.log("[CAL READ->]", DASH_CAL_READ_URL, preview(payload));
    const { data } = await httpLog("CAL_READ", () =>
      axios.post(DASH_CAL_READ_URL, payload, { timeout: 12000 })
    );
    console.log("[CAL READ<-]", preview(data));
    let raw = data?.events ?? data?.event ?? null;
    let events = [];
    if (Array.isArray(raw)) events = raw;
    else if (raw && typeof raw === "object") { if (Array.isArray(raw.array)) events = raw.array; else events = [raw]; }
    const ok = (data && (data.ok === true || data.ok === "true")) || events.length >= 0;
    return { ok, events };
  } catch (e) {
    console.error("[DASH READ ERROR]", e.message);
    return { ok: false, events: [], reason: "exception" };
  }
}

/* create: try several shapes with time-key synonyms */
async function dashCreateEvent({ name, phone, email, notes, startISO, endISO, service }) {
  if (!DASH_CAL_CREATE_URL) { console.error("[CAL CREATE] no URL"); return { ok: false, event: null }; }

  const e164 = phone && phone.length === 10 ? `+1${phone}` : phone || "";
  const base = {
    biz: DASH_BIZ,
    source: DASH_SOURCE,
    timezone: BIZ_TZ,
    service: service || "appointment",
    duration_min: durationMinutesForService(service),
    customer: { name: name || "Guest", phone: e164, email: email || "" },
    notes: notes || service || ""
  };

  const addTimes = (obj) => {
    const out = { ...obj };
    out.start      = startISO;
    out.end        = endISO;
    out.start_time = startISO;
    out.end_time   = endISO;
    out.startISO   = startISO;
    out.endISO     = endISO;
    return out;
  };

  const payloadA = {
    ...base,
    event: addTimes({
      summary: `${service || "Appointment"} (${name || "Guest"})`,
      type: service || "appointment",
      timezone: BIZ_TZ,
      customer: base.customer,
      notes: base.notes
    })
  };
  const payloadB = {
    ...base,
    appointment: addTimes({
      title: `${service || "Appointment"} (${name || "Guest"})`,
      type: service || "appointment",
      timezone: BIZ_TZ,
      customer: base.customer,
      notes: base.notes
    })
  };
  const payloadC = {
    ...base,
    title: `${service || "Appointment"} (${name || "Guest"})`,
    ...addTimes({}),
    customer_name: base.customer.name,
    customer_phone: base.customer.phone,
    service: base.service
  };

  const tryPost = async (label, payload) => {
    console.log("[CAL CREATE->]", label, DASH_CAL_CREATE_URL, preview(payload));
    const { data } = await postJsonOrForm(DASH_CAL_CREATE_URL, payload, `CAL_CREATE_${label}`);
    console.log("[CAL CREATE<-]", label, preview(data));
    return data;
  };

  try {
    try { return { ok: true, event: await tryPost("A", payloadA) }; }
    catch (e1) {
      if (e1?.response?.status !== 400) throw e1;
      try { return { ok: true, event: await tryPost("B", payloadB) }; }
      catch (e2) {
        if (![400,500].includes(e2?.response?.status)) throw e2;
        return { ok: true, event: await tryPost("C", payloadC) };
      }
    }
  } catch (e) {
    console.error("[DASH CREATE ERROR]", e.message, "status=", e?.response?.status, "data=", preview(e?.response?.data));
    return { ok: false, event: null };
  }
}

async function dashDeleteEvent(event_id) {
  if (!DASH_CAL_CANCEL_URL) return { ok: false };
  try {
    const payload = { biz: DASH_BIZ, source: DASH_SOURCE, event_id };
    console.log("[CAL CANCEL->]", DASH_CAL_CANCEL_URL, preview(payload));
    const resp = await httpLog("CAL_CANCEL", () =>
      axios.post(DASH_CAL_CANCEL_URL, payload, { timeout: 10000 })
    );
    const { status, data } = resp;
    console.log("[CAL CANCEL<-]", status, preview(data));
    let ok =
      (status >= 200 && status < 300) ||
      data?.ok === true || data?.ok === "true" ||
      data?.success === true || data?.status === "ok" ||
      data?.deleted === true || data?.result === "deleted" ||
      (typeof data === "string" && /^(ok|success|deleted)$/i.test(String(data).trim()));
    return { ok: !!ok };
  } catch (e) {
    console.error("[DASH CANCEL ERROR]", e.message);
    return { ok: false };
  }
}

function eventsOverlap(aStart, aEnd, bStart, bEnd) {
  const A1 = new Date(aStart).getTime();
  const A2 = new Date(aEnd).getTime();
  const B1 = new Date(bStart).getTime();
  const B2 = new Date(bEnd).getTime();
  return A1 < B2 && B1 < A2;
}

/* ===== DEEPGRAM ===== */
function startDeepgram({ onFinal }) {
  const url =
    "wss://api.deepgram.com/v1/listen"
    + "?encoding=linear16"
    + "&sample_rate=8000"
    + "&channels=1"
    + "&model=nova-2-phonecall"
    + "&interim_results=true"
    + "&smart_format=true"
    + "&language=en-US"
    + "&endpointing=250";

  const dg = new WebSocket(url, {
    headers: { Authorization: `token ${DEEPGRAM_API_KEY}` },
    perMessageDeflate: false
  });

  dg.on("open", () => console.log("[Deepgram] ws open"));
  dg.on("message", (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    if (ev.type !== "Results") return;
    const alt = ev.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || "").trim();
    if (!text) return;
    if (ev.is_final || ev.speech_final) {
      console.log(JSON.stringify({ event: "ASR_FINAL", transcript: text }));
      onFinal?.(text);
    }
  });
  dg.on("error", (e) => console.error("[Deepgram error]", e.message));
  dg.on("close", () => console.log("[Deepgram closed]"));

  return {
    sendPCM16LE(buf) { try { dg.send(buf); } catch {} },
    close() { try { dg.close(); } catch {} }
  };
}

/* μ-law */
function ulawByteToPcm16(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << (exponent + 2)) - 0x84 * 4;
  if (sign) sample = -sample;
  return Math.max(-32768, Math.min(32767, sample));
}
function ulawBufferToPCM16LEBuffer(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    const s = ulawByteToPcm16(ulawBuf[i]);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

/* ===== GPT ===== */
async function askGPT(systemPrompt, userPrompt, response_format = "text") {
  try {
    console.log("[GPT->] model=gpt-4o-mini format=", response_format);
    const resp = await httpLog("GPT", () =>
      axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          ...(response_format === "json" ? { response_format: { type: "json_object" } } : {}),
        },
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
      )
    );
    const out = resp.data.choices[0].message.content.trim();
    console.log("[GPT<-] len=", out.length);
    return out;
  } catch (e) {
    console.error("[GPT ERROR]", e.message);
    return "";
  }
}

/* ===== TTS ===== */
async function say(ws, text) {
  if (!text) return;
  try { (ws.__lines ||= []).push({ role: "assistant", at: Date.now(), text }); } catch {}

  const streamSid = ws.__streamSid;
  if (!streamSid) return;

  console.log(JSON.stringify({ event: "BOT_SAY", reply: text }));

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn('{"ts":"'+new Date().toISOString()+'","level":"WARN","msg":"No ElevenLabs credentials, skipping TTS"}');
    return;
  }

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=4&output_format=ulaw_8000`;
    console.log("[TTS->]", url);
    const resp = await httpLog("TTS_STREAM", () =>
      axios.post(
        url,
        { text, voice_settings: { stability: 0.4, similarity_boost: 0.8 } },
        { headers: { "xi-api-key": ELEVENLABS_API_KEY }, responseType: "stream" }
      )
    );

    await new Promise((resolve) => {
      resp.data.on("data", (chunk) => {
        try {
          const b64 = Buffer.from(chunk).toString("base64");
          ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: b64 } }));
        } catch (_) {}
      });
      resp.data.on("end", () => {
        try { ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "eos" } })); } catch (_) {}
        setTimeout(resolve, 150);
      });
      resp.data.on("error", () => resolve());
      resp.data.on("close", () => resolve());
    });
  } catch (e) {
    console.error("[TTS ERROR]", e.message);
  }
}

/* ===== SILENCE ===== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clearQuestionTimers(ws) {
  if (ws.__qTimer1) { clearTimeout(ws.__qTimer1); ws.__qTimer1 = null; }
  if (ws.__qTimer2) { clearTimeout(ws.__qTimer2); ws.__qTimer2 = null; }
  ws.__lastQuestion = "";
}
async function askWithReaskAndGoodbye(ws, questionText) {
  clearQuestionTimers(ws);
  ws.__lastQuestion = questionText;
  await say(ws, questionText);
  ws.__qTimer1 = setTimeout(async () => {
    await say(ws, `Sorry, I didn’t hear that. ${questionText}`);
    ws.__qTimer2 = setTimeout(async () => {
      await say(ws, "Thanks for calling Old Line Barbershop, have a great day!");
      await sleep(8000);
      try { ws.close(); } catch {}
    }, 8000);
  }, 20000);
}

/* ===== STATE ===== */
function newState() {
  return {
    phase: "idle",
    slots: { service: "", date: "", time: "", name: "", phone: "" },
    lastConfirmSnapshot: "",
    clarify: { service:0, date:0, time:0, name:0, phone:0 },
    bookingLock: false,
    lastAskKey: "",
    lastAskAt: 0
  };
}
function mergeSlots(state, parsed) {
  const before = { ...state.slots };
  let changed = false;
  const changedKeys = [];

  if (parsed.service) {
    const svc = normalizeService(parsed.service);
    if (svc && svc !== state.slots.service) { state.slots.service = svc; changed = true; changedKeys.push("service"); }
  }
  if (parsed.date) {
    const nd = normalizeDate(parsed.date);
    if (nd && nd !== state.slots.date) { state.slots.date = nd; changed = true; changedKeys.push("date"); }
  }
  if (parsed.time) {
    const t = parsed.time.trim();
    if (t && t !== state.slots.time) { state.slots.time = t; changed = true; changedKeys.push("time"); }
  }
  if (parsed.name) {
    if (parsed.name !== state.slots.name) { state.slots.name = parsed.name; changed = true; changedKeys.push("name"); }
  }
  if (parsed.phone) {
    const ph = normalizePhone(parsed.phone);
    if (ph && ph !== state.slots.phone) { state.slots.phone = ph; changed = true; changedKeys.push("phone"); }
  }

  if (changed) console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots }));
  return { changed, changedKeys };
}
function nextMissing(state) {
  const s = state.slots;
  if (!s.service) return "service";
  if (!s.date && !s.time) return "datetime";
  if (!s.date) return "date";
  if (!s.time) return "time";
  if (!s.name) return "name";
  if (!s.phone) return "phone";
  return "done";
}

/* ===== GOODBYE ===== */
function clearGoodbyeTimers(ws) {
  if (ws.__goodbyeSilenceTimer) { clearTimeout(ws.__goodbyeSilenceTimer); ws.__goodbyeSilenceTimer = null; }
  if (ws.__hangTimer) { clearTimeout(ws.__hangTimer); ws.__hangTimer = null; }
}
function armGoodbyeSilence(ws) {
  clearGoodbyeTimers(ws);
  ws.__goodbyeSilenceTimer = setTimeout(async () => {
    await say(ws, "Thanks for calling Old Line Barbershop, have a great day!");
    ws.__hangTimer = setTimeout(() => { try { ws.close(); } catch {} }, 8000);
  }, 7000);
}

/* ===== BOOK ===== */
async function createViaDashIfFree(ws, state) {
  const s = state.slots;
  const { startISO, endISO } = buildStartEndISO(s.date, s.time, s.service);
  if (!startISO || !endISO) return { ok: false, reason: "bad_time" };

  console.log("[BOOK] computed window", { startISO, endISO, service: s.service });

  const read = await dashReadWindow(startISO, endISO);
  if (!read.ok) {
    console.log(JSON.stringify({ event: "CAL_READ_FAILED" }));
    return { ok: false, reason: "unverified" };
  }

  const conflict = read.events?.some(ev => {
    const evStart = ev.Start_Time || ev.start || ev.start_time || ev.startISO;
    const evEnd   = ev.End_Time   || ev.end   || ev.end_time   || ev.endISO || evStart;
    return evStart && evEnd && eventsOverlap(startISO, endISO, evStart, evEnd);
  });
  console.log("[BOOK] conflict", conflict, "events", read.events?.length || 0);
  if (conflict) return { ok: false, reason: "conflict" };

  const created = await dashCreateEvent({
    name: s.name, phone: s.phone, email: "", notes: s.service,
    startISO, endISO, service: s.service
  });
  console.log("[BOOK] create result ok?", created.ok);
  if (!created.ok) return { ok: false, reason: "create_failed" };

  const eventId = created.event?.event_id || created.event?.id || created.event?.eventId || null;
  if (eventId) state.__lastEventId = eventId;
  return { ok: true, startISO, endISO, eventId };
}

async function triggerConfirm(ws, state, { updated=false } = {}) {
  const s = state.slots;
  const when = humanWhen(s.date, s.time);
  console.log(JSON.stringify({ event: "CONFIRM_READY", slots: s, whenSpoken: when }));

  const snap = JSON.stringify(s);
  if (snap === state.lastConfirmSnapshot && state.phase === "confirmed") return;

  const calRes = await createViaDashIfFree(ws, state);
  console.log("[CONFIRM] createViaDashIfFree ->", calRes);
  if (!calRes.ok) {
    if (calRes.reason === "conflict") {
      await say(ws, "That time just became unavailable. What other time that day works?");
      state.slots.time = ""; state.phase = "booking";
      return await askForMissing(ws, state);
    }
    await say(ws, "I couldn’t lock that time just now. What other time works?");
    state.slots.time = ""; state.phase = "booking";
    return await askForMissing(ws, state);
  }

  state.phase = "confirmed";
  state.lastConfirmSnapshot = snap;

  try {
    if (DASH_LEAD_UPSERT_URL) {
      const lead = {
        biz: DASH_BIZ, source: DASH_SOURCE,
        phone: s.phone || ws.__callerFrom || "",
        name: s.name || "",
        intent: "book",
        service: s.service || "",
        last_convo_id: ws.__convoId
      };
      console.log("[LEAD UPSERT->]", DASH_LEAD_UPSERT_URL, preview(lead));
      await httpLog("LEAD_UPSERT", () => axios.post(DASH_LEAD_UPSERT_URL, lead, { timeout: 6000 }));
    }
  } catch (e) { console.error("[LEAD UPSERT ERROR]", e.message); }

  const last4 = s.phone ? s.phone.slice(-4) : "";
  const numLine = last4 ? ` I have your number ending in ${last4}.` : "";
  const line = updated
    ? `Updated — I’ve got a ${s.service} for ${s.name} on ${when}.${numLine} You’re all set. Anything else I can help with?`
    : `Great — I’ve got a ${s.service} for ${s.name} on ${when}.${numLine} You’re all set. Anything else I can help with?`;
  await askWithReaskAndGoodbye(ws, line);
}

/* ===== CANCEL ===== */
function isoToLocalParts(iso, tz = BIZ_TZ) {
  try {
    const d = new Date(String(iso));
    if (isNaN(d)) return { dateISO: "", timeHHMM: "" };
    const dateISO = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(d);
    const timeHHMM = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit"
    }).format(d);
    return { dateISO, timeHHMM };
  } catch { return { dateISO: "", timeHHMM: "" }; }
}
function isoToDateTimeSpeech(iso) {
  const { dateISO, timeHHMM } = isoToLocalParts(iso);
  if (!dateISO || !timeHHMM) return "";
  return `${formatDateSpoken(dateISO)} at ${to12h(timeHHMM)}`;
}
function describeEventForSpeech(ev) {
  const start = ev.Start_Time || ev.start || ev.start_time || ev.startISO || "";
  const summary = ev.summary || ev.Event_Name || ev.name || "";
  const who = ev.Customer_Name || "";
  const when = isoToDateTimeSpeech(start);
  if (summary) return `${summary} on ${when}`;
  if (who) return `${who}'s appointment on ${when}`;
  return `an appointment on ${when}`;
}
function parseYesNo(text) {
  const t = (text || "").toLowerCase();
  if (/\b(yes|yeah|yep|yup|correct|that(?:'| i)s (?:it|right)|please do|go ahead|cancel it)\b/.test(t)) return "yes";
  if (/\b(no|nope|not that|wrong|different|don'?t|do not|hold on)\b/.test(t)) return "no";
  return null;
}
function saysDone(text) {
  const t = String(text || "").toLowerCase();
  return /\b(that'?s (?:it|all)|that(?:'| i)ll be it|i'?m (?:good|all set)|no(?: thanks)?|nope|nah|we(?:'| a)re good|nothing else|i think i'?m good)\b/i.test(t);
}
async function gracefulGoodbye(ws) {
  await say(ws, "Thanks for calling Old Line Barbershop, have a great day!");
  await sleep(2500);
  try { ws.close(); } catch {}
}

/* ===== TRANSFER ===== */
async function transferToOwner(ws) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !OWNER_PHONE || !ws.__callSid) {
    await say(ws, "I’ll share your question with the owner to call you back.");
    return false;
  }
  try {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${PORT}`;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${ws.__callSid}.json`;
    const form = new URLSearchParams();
    form.append("Url", `https://${host}/xfer`);
    form.append("Method", "POST");
    await httpLog("TWILIO_TRANSFER", () =>
      axios.post(url, form, {
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      })
    );
    return true;
  } catch (e) {
    console.error("[TWILIO TRANSFER ERROR]", e.message);
    await say(ws, "I couldn’t transfer right now. I’ll have the owner call you back.");
    return false;
  }
}

/* ===== CALL ARTIFACTS (with to_number) ===== */
async function pushCallArtifacts(ws) {
  const call_id = ws.__callSid || ws.__convoId || "";
  const to_number = ws.__calledTo || DEST_NUMBER || "";

  const flat = {
    biz: DASH_BIZ,
    source: DASH_SOURCE,
    call_id,
    convo_id: ws.__convoId || "",
    call_sid: ws.__callSid || "",
    from: ws.__callerFrom || "",
    to_number,
    started_at: ws.__startedAt || 0,
    ended_at: Date.now(),
    slots: ws.__state?.slots || {},
    phase: ws.__state?.phase || "",
    transcript: ws.__lines || []
  };
  const nested = {
    biz: DASH_BIZ,
    source: DASH_SOURCE,
    call: {
      id: call_id,
      convo_id: ws.__convoId || "",
      call_sid: ws.__callSid || "",
      from: ws.__callerFrom || "",
      to_number,
      started_at: ws.__startedAt || 0,
      ended_at: flat.ended_at,
      slots: flat.slots,
      phase: flat.phase,
      transcript: flat.transcript
    }
  };

  try {
    if (DASH_CALL_LOG_URL) {
      console.log("[CALL LOG->]", DASH_CALL_LOG_URL, preview(nested, 400));
      try {
        await httpLog("CALL_LOG_NESTED", () => axios.post(DASH_CALL_LOG_URL, nested, { timeout: 8000 }));
      } catch {
        console.log("[CALL LOG-> fallback]", DASH_CALL_LOG_URL, preview(flat, 400));
        try {
          await httpLog("CALL_LOG_FLAT", () => axios.post(DASH_CALL_LOG_URL, flat, { timeout: 8000 }));
        } catch {
          const alt = {
            biz: DASH_BIZ, source: DASH_SOURCE,
            id: call_id, callId: call_id, convoId: ws.__convoId || "",
            callSid: ws.__callSid || "", from: ws.__callerFrom || "",
            toNumber: to_number,
            startedAt: ws.__startedAt || 0, endedAt: flat.ended_at,
            slots: flat.slots, phase: flat.phase, transcript: flat.transcript
          };
          await postJsonOrForm(DASH_CALL_LOG_URL, alt, "CALL_LOG_ALT");
        }
      }
    }
  } catch (e) { console.error("[CALL LOG ERROR]", e.message); }

  try {
    if (DASH_CALL_SUMMARY_URL) {
      const sum1 = { biz: DASH_BIZ, source: DASH_SOURCE, call_id };
      console.log("[CALL SUMMARY->]", DASH_CALL_SUMMARY_URL, preview(sum1));
      await httpLog("CALL_SUMMARY_CALLID", () => axios.post(DASH_CALL_SUMMARY_URL, sum1, { timeout: 8000 }));
    }
  } catch (e) { console.error("[CALL SUMMARY ERROR]", e.message); }
}

/* ===== DIALOG ===== */

/* capture phone numbers directly */
function extractPhoneFromText(text) {
  if (!text) return "";
  const digits = text.replace(/[^\d]/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return "";
}

async function askForMissing(ws, state) {
  const s = state.slots;
  const missing = nextMissing(state);
  console.log(JSON.stringify({ event: "SLOTS", slots: s, missing }));

  const key = `ask:${missing}:${s.service}:${s.date}:${s.time}:${s.name}:${s.phone}`;
  const now = Date.now();
  if (state.lastAskKey === key && (now - state.lastAskAt) < 1200) return;
  state.lastAskKey = key; state.lastAskAt = now;

  if (missing === "service") return askWithReaskAndGoodbye(ws, "Which service would you like — haircut, beard trim, or combo?");
  if (missing === "datetime") {
    if (s.date && !s.time) return askWithReaskAndGoodbye(ws, `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`);
    if (!s.date && s.time) return askWithReaskAndGoodbye(ws, `What day works for your ${s.service} at ${to12h(s.time)}?`);
    return askWithReaskAndGoodbye(ws, `What date and time would you like for your ${s.service || "appointment"}?`);
  }
  if (missing === "date") return askWithReaskAndGoodbye(ws, `What date works for your ${s.service}${s.time ? ` at ${to12h(s.time)}` : ""}?`);
  if (missing === "time") return askWithReaskAndGoodbye(ws, `What time on ${formatDateSpoken(s.date)} works for your ${s.service}?`);
  if (missing === "name") return askWithReaskAndGoodbye(ws, "Can I get your first name?");
  if (missing === "phone") return askWithReaskAndGoodbye(ws, "What phone number should I use for confirmations?");
  if (missing === "done") {
    const check = enforceBusinessWindow(state);
    if (!check.ok) {
      if (check.reason === "weekend") return askWithReaskAndGoodbye(ws, "We’re closed on weekends. We’re open Monday to Friday, 9 AM to 5 PM. What weekday works?");
      if (check.reason === "hours") return askWithReaskAndGoodbye(ws, "We’re open 9 AM to 5 PM. What time that day works within business hours?");
      return askForMissing(ws, state);
    }
    return triggerConfirm(ws, state);
  }
}

async function classifyAndHandle(ws, state, transcript) {
  clearQuestionTimers(ws);

  if (ws.__awaitingAnythingElse) {
    if (saysDone(transcript)) { ws.__awaitingAnythingElse = false; return gracefulGoodbye(ws); }
    ws.__awaitingAnythingElse = false;
  }

  try { (ws.__lines ||= []).push({ role: "user", at: Date.now(), text: transcript }); } catch {}

  ws.__calledTo = ws.__calledTo || (ws.__twilioTo || "");

  const lower = String(transcript || "").toLowerCase();

  // reschedule keyword -> treat as booking update
  if (/\breschedul(e|ing|e\s+it)\b/.test(lower)) {
    state.phase = "booking";
    await say(ws, "Sure — what new date and time would you like?");
    return;
  }

  // Hard service/date shortcuts
  if (!state.slots.service) {
    const svcHard = normalizeService(lower);
    if (svcHard) { state.slots.service = svcHard; state.phase = state.phase || "booking"; await say(ws, `Got it: ${state.slots.service}.`); return askForMissing(ws, state); }
  }
  if (!state.slots.date) {
    if (/\b(?:tmr|tmrw|tmmrw|tomorrow)\b/.test(lower)) { state.slots.date = addDaysISO(nowInTZ(BIZ_TZ), 1); state.phase = state.phase || "booking"; await say(ws, `Okay: ${formatDateSpoken(state.slots.date)}.`); return askForMissing(ws, state); }
    if (/\b(?:today)\b/.test(lower)) { state.slots.date = nowInTZ(BIZ_TZ); state.phase = state.phase || "booking"; await say(ws, `Okay: ${formatDateSpoken(state.slots.date)}.`); return askForMissing(ws, state); }
  }

  // When waiting for phone, parse it directly
  const needPhone = nextMissing(state) === "phone";
  if (needPhone) {
    const ph = extractPhoneFromText(transcript);
    if (ph) {
      const before = { ...state.slots };
      state.slots.phone = ph;
      console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots, via: "regex_phone" }));
      await say(ws, "Thanks. I’ve saved your number.");
      return askForMissing(ws, state);
    }
  }

  // Cancel flow Q&A
  if (ws.__pendingCancel && transcript) {
    const askingTime = isAskingTime(transcript);
    const askingDate = isAskingDate(transcript);
    if (askingTime || askingDate) {
      const pc = ws.__pendingCancel;
      const dateSpoken = pc?.dateISO ? formatDateSpoken(pc.dateISO) : "";
      const timeSpoken = pc?.timeHHMM ? to12h(pc.timeHHMM) : "";
      let answer = "";
      if (askingTime && timeSpoken) answer = `It’s at ${timeSpoken}.`;
      if (askingDate && dateSpoken) answer = `It’s on ${dateSpoken}.`;
      if (!answer && (pc?.spoken || "")) answer = pc.spoken + ".";
      await askWithReaskAndGoodbye(ws, `${answer} Should I cancel it?`);
      return;
    }
  }
  if (state.phase === "booking" && transcript) {
    const askingTime = isAskingTime(transcript);
    const askingDate = isAskingDate(transcript);
    if (askingTime || askingDate) {
      const s = state.slots;
      const bits = [];
      if (askingTime) bits.push(s.time ? `We’re looking at ${to12h(s.time)}` : `We haven’t picked a time yet`);
      if (askingDate) bits.push(s.date ? `on ${formatDateSpoken(s.date)}` : `and we still need a date`);
      await say(ws, bits.join(" ") + ".");
      return askForMissing(ws, state);
    }
  }

  if (ws.__pendingCancel && transcript) {
    const yn = parseYesNo(transcript);
    if (yn === "yes") {
      const eventId = ws.__pendingCancel.eventId;
      ws.__pendingCancel = null;
      const del = await dashDeleteEvent(eventId);
      if (del.ok) { await say(ws, "All set — your appointment has been canceled. Anything else I can help with?"); ws.__awaitingAnythingElse = true; }
      else { await say(ws, "I couldn’t cancel that just now. Would you like me to try again or cancel a different time?"); }
      return;
    } else if (yn === "no") {
      ws.__pendingCancel = null;
      const cf = ws.__cancelFlow && typeof ws.__cancelFlow === "object" ? ws.__cancelFlow : { dateISO: "", timeStr: "" };
      ws.__cancelFlow = { ...cf, active: true };
      await askWithReaskAndGoodbye(ws, "Okay — which date and time should I cancel?");
      return;
    }
  }

  if (!state.slots.phone && ws.__callerFrom && /\b(this|my)\s+(number|phone)\b/i.test(transcript)) {
    const filled = normalizePhone(ws.__callerFrom);
    if (filled) {
      const before = { ...state.slots };
      state.slots.phone = filled;
      console.log(JSON.stringify({ event: "SLOTS_MERGE", before, after: state.slots, via: "callerFrom" }));
      await say(ws, "Got it. I’ll use this number.");
      return askForMissing(ws, state);
    }
  }

  const systemPrompt = `
Return STRICT JSON:{
 "intent":"FAQ"|"BOOK"|"CANCEL"|"DECLINE_BOOK"|"TRANSFER"|"END"|"SMALLTALK"|"UNKNOWN",
 "faq_topic":"HOURS"|"PRICES"|"SERVICES"|"LOCATION"|"",
 "service":"","date":"","time":"","name":"","phone":""}
Rules:
- BOOK if they schedule OR reschedule and give date/time.
- CANCEL if they ask to cancel; include any date/time/name/phone.
- If user says "this number", leave phone empty.
- Leave blanks if unsure. Do not invent names.`.trim();

  let parsed = {};
  try {
    const res = await askGPT(systemPrompt, transcript, "json");
    parsed = JSON.parse(res || "{}");
  } catch {}
  console.log(JSON.stringify({ event: "GPT_CLASSIFY", transcript, parsed }));

  if (state.phase === "confirmed") clearGoodbyeTimers(ws);

  // explicit cancel intent entry-point
  if (parsed.intent === "CANCEL") {
    const d0 = normalizeDate(parsed.date) || "";
    const t0 = parsed.time || "";
    ws.__cancelFlow = { active: true, dateISO: d0, timeStr: t0 };
    if (!d0 && !t0) await askWithReaskAndGoodbye(ws, "Sure — what’s the date and time of the appointment to cancel?");
    else await askWithReaskAndGoodbye(ws, "Got it — what’s the exact date and time to cancel?");
    return;
  }

  // cancel flow resolver
  if (ws.__cancelFlow?.active) {
    const cf = ws.__cancelFlow || { active: true, dateISO: "", timeStr: "" };
    const newDate = normalizeDate(parsed.date) || "";
    const newTime = parsed.time || "";
    if (newDate) cf.dateISO = newDate;
    if (newTime) cf.timeStr = newTime;

    const dateISO = cf.dateISO || "";
    const timeStr = cf.timeStr || "";

    if (!dateISO && !timeStr) { await askWithReaskAndGoodbye(ws, "Which date and time should I cancel?"); return; }

    let startISO = "", endISO = "";
    if (dateISO && timeStr) ({ startISO, endISO } = buildStartEndISO(dateISO, timeStr, "haircut"));
    else if (dateISO)       ({ startISO, endISO } = dayBoundsISO(dateISO));
    else { await askWithReaskAndGoodbye(ws, "Got it — what date is that appointment on?"); return; }

    ws.__cancelFlow = cf;

    const read = await dashReadWindow(startISO, endISO);
    if (!read.ok) { await askWithReaskAndGoodbye(ws, "I couldn’t reach the calendar just now. What date and time should I cancel?"); return; }
    if (!Array.isArray(read.events) || read.events.length === 0) { await askWithReaskAndGoodbye(ws, "I couldn’t find that appointment. What date and time should I cancel?"); return; }

    const phone = state.slots.phone || "";
    let target = null;
    for (const ev of read.events) {
      const evStart = ev.Start_Time || ev.start || ev.start_time || ev.startISO;
      const evEnd   = ev.End_Time   || ev.end   || ev.end_time   || ev.endISO || evStart;
      const evPhone = normalizePhone(ev.Customer_Phone || ev.phone || "");
      const timeMatch = evStart && evEnd && eventsOverlap(startISO, endISO, evStart, evEnd);
      const phoneMatch = phone && evPhone ? evPhone.endsWith(phone.slice(-4)) : true;
      if (timeMatch && phoneMatch) { target = ev; break; }
    }
    if (!target) target = read.events[0];

    const eventId = target.event_id || target.id || target.eventId;
    if (!eventId) { await askWithReaskAndGoodbye(ws, "I found an appointment but couldn’t identify its ID. What’s the exact time?"); return; }

    const spoken = describeEventForSpeech(target);
    const startStr = target.Start_Time || target.start || target.start_time || target.startISO || "";
    const { dateISO: apptDateISO, timeHHMM: apptTimeHHMM } = isoToLocalParts(startStr);
    const summary = target.summary || target.Event_Name || target.name || "";
    const service = extractServiceFromSummary(summary);
    const who = target.Customer_Name || "";

    ws.__pendingCancel = { eventId, spoken, dateISO: apptDateISO, timeHHMM: apptTimeHHMM, service, name: who };
    ws.__cancelFlow = { ...cf, active: false };
    await askWithReaskAndGoodbye(ws, `I found ${spoken}. Should I cancel it?`);
    return;
  }

  const { changed, changedKeys } = mergeSlots(state, parsed);
  if (parsed.intent === "END") return gracefulGoodbye(ws);
  if (parsed.intent === "DECLINE_BOOK") { state.phase = "idle"; return say(ws, "No problem. How else can I help?"); }

  if (parsed.intent === "FAQ") {
    const priceTable = { "haircut": "thirty dollars", "beard trim": "fifteen dollars", "combo": "forty dollars" };
    let answer = "";
    if (parsed.faq_topic === "HOURS") answer = "We’re open Monday to Friday, nine A M to five P M. Closed weekends.";
    else if (parsed.faq_topic === "PRICES") {
      const svc = normalizeService(parsed.service || state.slots.service);
      answer = (svc && priceTable[svc]) ? `${svc} is ${priceTable[svc]}.` : "Haircut is thirty dollars, beard trim is fifteen, and the combo is forty.";
    } else if (parsed.faq_topic === "SERVICES") answer = "We offer haircuts, beard trims, and the combo.";
    else if (parsed.faq_topic === "LOCATION") answer = "We’re at one two three Blueberry Lane.";
    else answer = "Happy to help. What else can I answer?";
    if (state.phase === "booking") { await say(ws, answer); return askForMissing(ws, state); }
    if (state.phase === "confirmed") return say(ws, "Happy to help.");
    return say(ws, `${answer} Would you like to book an appointment or do you have another question?`);
  }

  if (parsed.intent === "TRANSFER") { const ok = await transferToOwner(ws); if (!ok) { try { ws.close(); } catch {} } return; }

  if (parsed.intent === "BOOK" || state.phase === "booking") {
    if (state.phase !== "booking") state.phase = "booking";
    const missing = nextMissing(state);
    if (missing === "done") {
      const check = enforceBusinessWindow(state);
      if (!check.ok) {
        if (check.reason === "weekend") return askWithReaskAndGoodbye(ws, "We’re closed on weekends. We’re open Monday to Friday, 9 AM to 5 PM. What weekday works?");
        if (check.reason === "hours") return askWithReaskAndGoodbye(ws, "We’re open 9 AM to 5 PM. What time that day works within business hours?");
      }
      return triggerConfirm(ws, state, { updated: /reschedul/i.test(ws.__lines?.slice(-1)[0]?.text || "") });
    }
    if (changed && changedKeys.length === 1 && changedKeys[0] === missing) return askForMissing(ws, state);

    const targetAsk = {
      "service": "Which service would you like — haircut, beard trim, or combo?",
      "datetime": `What date and time would you like for your ${state.slots.service || "appointment"}?`,
      "date": `What date works for your ${state.slots.service}${state.slots.time ? ` at ${to12h(state.slots.time)}` : ""}?`,
      "time": `What time on ${formatDateSpoken(state.slots.date)} works for your ${state.slots.service}?`,
      "name": "Can I get your first name?",
      "phone": "What phone number should I use for confirmations?"
    }[missing];
    await say(ws, "Sure.");
    return askWithReaskAndGoodbye(ws, targetAsk);
  }

  if (parsed.intent === "SMALLTALK" || parsed.intent === "UNKNOWN") {
    if (state.phase === "idle") return say(ws, `All good. Would you like to book or ask a question?`);
    if (state.phase === "confirmed") return say(ws, "Happy to help.");
    return say(ws, "Okay.");
  }
}

/* ===== WS ===== */
wss.on("connection", (ws) => {
  let dg = null;
  let pendingULaw = [];
  const BATCH_FRAMES = 2;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      ws.__streamSid = msg.start.streamSid;
      ws.__convoId = uuidv4();
      ws.__state = newState();
      ws.__callerFrom = msg.start?.customParameters?.from || "{{From}}";
      ws.__twilioTo   = msg.start?.customParameters?.to || "";
      ws.__callSid = msg.start?.callSid || msg.start?.customParameters?.callSid || "";
      ws.__pendingCancel = null;
      ws.__cancelFlow = { active: false };
      ws.__awaitingAnythingElse = false;
      ws.__lines = [];
      ws.__startedAt = Date.now();
      clearGoodbyeTimers(ws);
      clearQuestionTimers(ws);
      console.log(JSON.stringify({ event: "CALL_START", streamSid: ws.__streamSid, convoId: ws.__convoId, callSid: ws.__callSid }));

      dg = startDeepgram({
        onFinal: async (text) => {
          try { await classifyAndHandle(ws, ws.__state, text); } catch (e) { console.error("[handle error]", e.message); }
        }
      });

      await say(ws, "Hi, thanks for calling Old Line Barbershop. How can I help you today?");
      return;
    }

    if (msg.event === "media") {
      const b64 = msg.media?.payload || "";
      if (!b64 || !dg) return;
      const ulaw = Buffer.from(b64, "base64");
      pendingULaw.push(ulaw);
      if (pendingULaw.length >= BATCH_FRAMES) {
        const ulawChunk = Buffer.concat(pendingULaw);
        const pcm16le = ulawBufferToPCM16LEBuffer(ulawChunk);
        dg.sendPCM16LE(pcm16le);
        pendingULaw = [];
      }
      return;
    }

    if (msg.event === "stop") {
      try { dg?.close(); } catch {}
      try { await pushCallArtifacts(ws); } catch {}
      try { ws.close(); } catch {}
    }
  });

  ws.on("close", () => {
    clearQuestionTimers(ws);
    clearGoodbyeTimers(ws);
    try { dg?.close(); } catch {}
    pushCallArtifacts(ws).catch(()=>{});
    console.log("[INFO] WS closed", { convoId: ws.__convoId });
  });
});
