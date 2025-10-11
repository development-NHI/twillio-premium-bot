// server.js — fixed tool_calls handling
// Node 22.x

import express from "express";
import axios from "axios";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// ---- Config ----
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const BIZ_TZ = process.env.BIZ_TZ || "America/New_York";

const URLS = {
  CAL_READ:
    process.env.CAL_READ ||
    "https://e557375f-7d2b-4cff-8d19-379215edaaa5-00-3cju776e8ezb0.janeway.replit.dev/api/calendar/read",
  CAL_CREATE:
    process.env.CAL_CREATE ||
    "https://e557375f-7d2b-4cff-8d19-379215edaaa5-00-3cju776e8ezb0.janeway.replit.dev/api/calendar/create",
  CAL_DELETE:
    process.env.CAL_DELETE ||
    "https://e557375f-7d2b-4cff-8d19-379215edaaa5-00-3cju776e8ezb0.janeway.replit.dev/api/calendar/cancel",
  LEAD_UPSERT:
    process.env.LEAD_UPSERT ||
    "https://e557375f-7d2b-4cff-8d19-379215edaaa5-00-3cju776e8ezb0.janeway.replit.dev/api/leads/upsert",
  FAQ_LOG: process.env.FAQ_LOG || "",
  CALL_LOG:
    process.env.CALL_LOG ||
    "https://e557375f-7d2b-4cff-8d19-379215edaaa5-00-3cju776e8ezb0.janeway.replit.dev/api/calls/log",
  CALL_SUMMARY:
    process.env.CALL_SUMMARY ||
    "https://e557375f-7d2b-4cff-8d19-379215edaaa5-00-3cju776e8ezb0.janeway.replit.dev/api/calls/summary",
  PROMPT_FETCH: process.env.PROMPT_FETCH || ""
};

// ---- App + WS ----
const app = express();
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- Utilities ----
async function httpPost(url, data, headers = {}, timeout = 12000) {
  const cfg = {
    method: "POST",
    url,
    data,
    timeout,
    headers: { "Content-Type": "application/json", ...headers },
    validateStatus: () => true
  };
  const res = await axios(cfg);
  if (res.status >= 200 && res.status < 300) return res.data;
  const preview = JSON.stringify(res.data)?.slice(0, 300);
  throw Object.assign(new Error(`Request failed with status code ${res.status}`), {
    status: res.status,
    resp_preview: preview
  });
}

async function openaiChat(messages) {
  const body = {
    model: MODEL,
    temperature: 0.3,
    messages,
    tools: [
      {
        type: "function",
        function: {
          name: "read_availability",
          description:
            "Read calendar availability within a window. If only dateISO is supplied, the whole local day is returned.",
          parameters: {
            type: "object",
            properties: {
              dateISO: { type: "string", description: "YYYY-MM-DD in business timezone" },
              startISO: { type: "string" },
              endISO: { type: "string" },
              name: { type: "string" },
              phone: { type: "string" }
            },
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "book_appointment",
          description: "Create a calendar event. The model must pass the exact startISO/endISO it wants.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              phone: { type: "string" },
              service: { type: "string" },
              startISO: { type: "string" },
              endISO: { type: "string" },
              notes: { type: "string" },
              meeting_type: { type: "string" },
              location: { type: "string" }
            },
            required: ["service", "startISO", "endISO"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "cancel_appointment",
          description: "Cancel a calendar event. Prefer event_id.",
          parameters: {
            type: "object",
            properties: {
              event_id: { type: "string" },
              name: { type: "string" },
              phone: { type: "string" },
              dateISO: { type: "string" }
            },
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "find_customer_events",
          description: "Find upcoming events for a contact over a horizon.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              phone: { type: "string" },
              days: { type: "number" }
            },
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "lead_upsert",
          description: "Create or update a lead/contact.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              phone: { type: "string" },
              intent: { type: "string" },
              notes: { type: "string" }
            },
            required: ["name", "phone"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "faq",
          description: "Answer common questions.",
          parameters: {
            type: "object",
            properties: {
              topic: { type: "string" },
              service: { type: "string" }
            },
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "transfer",
          description: "Warm transfer to a human",
          parameters: {
            type: "object",
            properties: { reason: { type: "string" }, callSid: { type: "string" } },
            required: []
          }
        }
      },
      {
        type: "function",
        function: {
          name: "end_call",
          description: "Politely end the call.",
          parameters: {
            type: "object",
            properties: { callSid: { type: "string" }, reason: { type: "string" } },
            required: []
          }
        }
      }
    ]
  };

  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}` };
  const res = await axios.post("https://api.openai.com/v1/chat/completions", body, {
    headers,
    timeout: 30000,
    validateStatus: () => true
  });

  if (res.status !== 200) {
    console.error(
      JSON.stringify({
        evt: "HTTP_ERR",
        tag: "OPENAI_CHAT",
        status: res.status,
        message: res.statusText,
        resp_preview: JSON.stringify(res.data)?.slice(0, 300)
      })
    );
    throw new Error(`OpenAI error ${res.status}`);
  }

  console.log(
    JSON.stringify({
      evt: "HTTP_RES",
      tag: "OPENAI_CHAT",
      status: 200,
      ms: res.headers["openai-processing-ms"] || null,
      resp_preview: JSON.stringify(res.data)?.slice(0, 120)
    })
  );

  const choice = res.data?.choices?.[0];
  return choice;
}

// ---- Tools implementation ----
const Tools = {
  async read_availability(args = {}) {
    const payload = {
      startISO: args.startISO || "",
      endISO: args.endISO || "",
      dateISO: args.dateISO || "",
      name: args.name || "",
      phone: args.phone || ""
    };
    console.log(JSON.stringify({ evt: "HTTP_REQ", tag: "CAL_READ", method: "POST", url: URLS.CAL_READ, payload_len: JSON.stringify(payload).length }));
    const data = await httpPost(URLS.CAL_READ, payload);
    console.log(JSON.stringify({ evt: "HTTP_RES", tag: "CAL_READ", status: 200, resp_preview: JSON.stringify(data).slice(0, 120) }));
    return { ok: true, data };
  },

  async book_appointment(args = {}) {
    const payload = {
      name: args.name || "",
      phone: args.phone || "",
      service: args.service || "",
      startISO: args.startISO || "",
      endISO: args.endISO || "",
      notes: args.notes || "",
      meeting_type: args.meeting_type || "",
      location: args.location || ""
    };
    console.log(JSON.stringify({ evt: "HTTP_REQ", tag: "CAL_CREATE", method: "POST", url: URLS.CAL_CREATE, payload_len: JSON.stringify(payload).length }));
    try {
      const data = await httpPost(URLS.CAL_CREATE, payload);
      console.log(JSON.stringify({ evt: "HTTP_RES", tag: "CAL_CREATE", status: 200, resp_preview: JSON.stringify(data).slice(0, 160) }));
      return { ok: true, data };
    } catch (e) {
      console.log(JSON.stringify({ evt: "HTTP_ERR", tag: "CAL_CREATE", status: e.status || 500, message: e.message, resp_preview: e.resp_preview || "" }));
      return { ok: false, error: e.resp_preview || e.message || "CREATE_FAILED" };
    }
  },

  async cancel_appointment(args = {}) {
    const payload = { event_id: args.event_id || "", name: args.name || "", phone: args.phone || "", dateISO: args.dateISO || "" };
    const data = await httpPost(URLS.CAL_DELETE, payload);
    return { ok: true, data };
  },

  async find_customer_events(args = {}) {
    const payload = { name: args.name || "", phone: args.phone || "", days: args.days || 30 };
    console.log(JSON.stringify({ evt: "HTTP_REQ", tag: "CAL_READ_FIND", method: "POST", url: URLS.CAL_READ, payload_len: JSON.stringify(payload).length }));
    const data = await httpPost(URLS.CAL_READ, payload);
    console.log(JSON.stringify({ evt: "HTTP_RES", tag: "CAL_READ_FIND", status: 200, resp_preview: JSON.stringify(data).slice(0, 160) }));
    return { ok: true, data };
  },

  async lead_upsert(args = {}) {
    const payload = { name: args.name || "", phone: args.phone || "", intent: args.intent || "", notes: args.notes || "" };
    if (!URLS.LEAD_UPSERT) return { ok: true };
    const data = await httpPost(URLS.LEAD_UPSERT, payload);
    return { ok: true, data };
  },

  async faq(args = {}) {
    return { ok: true, data: { answer: "See website for details." } };
  },

  async transfer() {
    return { ok: true };
  },

  async end_call() {
    return { ok: true };
  }
};

// ---- Speech helpers (stub logs; integrate with your stream if needed) ----
async function speakULaw(ws, text) {
  if (!text) return;
  console.log(JSON.stringify({ evt: "TTS_START", chars: text.length, preview: text.slice(0, 100) }));
  // send to your media stream here if needed
  console.log(JSON.stringify({ evt: "TTS_END", bytes: Math.max(6000, text.length * 350) }));
}

function statusLineForTool(name = "") {
  if (!name) return "One moment.";
  if (name === "read_availability") return "One sec, checking that time.";
  if (name === "book_appointment") return "Got it, booking now.";
  if (name === "find_customer_events") return "One moment.";
  if (name === "cancel_appointment") return "Canceling now.";
  return "One moment.";
}

// ---- Core runTools with FIX ----
async function runTools(ws, baseMessages) {
  if (ws.__llmBusy) {
    ws.__queued = baseMessages;
    console.log(JSON.stringify({ evt: "RUNTOOLS_QUEUE" }));
    return "";
  }
  ws.__llmBusy = true;

  try {
    let messages = baseMessages.slice();
    ws.__bookKeys = ws.__bookKeys || new Map();
    console.log(JSON.stringify({ evt: "RUNTOOLS_BEGIN", hops: 0, mem_len: ws.__mem?.length || 0 }));

    for (let hops = 0; hops < 8; hops++) {
      const choice = await openaiChat(messages);
      const msg = choice?.message || {};
      const outText = msg.content?.trim() || "";
      const calls = msg.tool_calls || [];

      if (!calls.length) {
        if (outText) {
          console.log(JSON.stringify({ evt: "RUNTOOLS_NO_TOOLS", has_text: true, text_preview: outText.slice(0, 100) }));
          await speakULaw(ws, outText);
          return outText;
        }
        console.log(JSON.stringify({ evt: "RUNTOOLS_NO_TOOLS", has_text: false }));
        return "";
      }

      // Speak a single status line before executing tools
      const firstName = calls[0]?.function?.name || "";
      await speakULaw(ws, statusLineForTool(firstName));
      console.log(JSON.stringify({ evt: "LLM_TOOL_CALLS", count: calls.length, names: calls.map(c => c.function?.name) }));

      // IMPORTANT: append the assistant-with-tool_calls ONCE
      messages = [...messages, msg];

      // Execute tools and append ONLY tool messages
      for (const tc of calls) {
        const name = tc.function?.name;
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          console.log(JSON.stringify({ evt: "TOOL_ARGS_PARSE_FAIL", name }));
        }

        if ((name === "transfer" || name === "end_call") && !args.callSid) {
          args.callSid = ws.__callSid || "";
        }

        // booking single-flight dedupe by start|end within 60s
        if (name === "book_appointment") {
          const k = `${args.startISO || ""}|${args.endISO || ""}`;
          const now = Date.now();
          const last = ws.__bookKeys.get(k) || 0;
          if (now - last < 60000) {
            console.log(JSON.stringify({ evt: "BOOK_DEDUP_SUPPRESS", key: k }));
            messages = [
              ...messages,
              { role: "tool", tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: "DUPLICATE_BOOKING_SUPPRESSED" }) }
            ];
            continue;
          }
          ws.__bookKeys.set(k, now);
        }

        const impl = Tools[name];
        console.log(JSON.stringify({ evt: "TOOL_START", name, args_keys: Object.keys(args) }));
        let result = {};
        try {
          result = await (impl ? impl(args) : { ok: false, error: "TOOL_NOT_FOUND" });
        } catch (e) {
          result = { ok: false, error: e?.message || "TOOL_ERR" };
        }
        console.log(JSON.stringify({ evt: "TOOL_DONE", name, ok: result?.ok !== false, err: result?.ok === false ? result?.error : null }));

        // Attach ONLY the tool result message
        messages = [...messages, { role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) }];

        // Pin window guidance after availability
        if (name === "read_availability") {
          const pinStart = args.startISO || "";
          const pinEnd = args.endISO || "";
          if (result?.ok === true && pinStart && pinEnd) {
            messages = [
              ...messages,
              {
                role: "system",
                content:
                  `You just verified availability for start=${pinStart} end=${pinEnd}. ` +
                  `If you intend to book, call book_appointment using the same startISO and endISO exactly.`
              }
            ];
          }
        }

        if (name === "book_appointment") {
          if (result?.ok) {
            messages = [
              ...messages,
              {
                role: "system",
                content:
                  "Booking succeeded. Confirm weekday, full date, time, meeting type, and location. Then ask if anything else."
              }
            ];
          } else {
            messages = [
              ...messages,
              {
                role: "system",
                content:
                  "Booking failed. Do NOT say it was booked. Say a short outcome using the error text if helpful, then offer 2–3 nearby in-hours options and ask one question."
              }
            ];
          }
        }
      }

      console.log(JSON.stringify({ evt: "NEXT_HOP", hop: hops + 1 }));
      // loop continues with appended tool messages
    }

    return "";
  } catch (e) {
    console.error(e);
    return "";
  } finally {
    ws.__llmBusy = false;
    if (ws.__queued) {
      const q = ws.__queued;
      ws.__queued = null;
      runTools(ws, q);
    }
  }
}

// ---- Prompt seed ----
function seedPrompt() {
  const system1 = {
    role: "system",
    content: `Today is ${new Date().toISOString().slice(0, 10)}. Business timezone: ${BIZ_TZ}. Resolve relative dates in this timezone.`
  };

  const system2 = {
    role: "system",
    content:
      `[Prompt-Version: 2025-10-12T02:20Z • confirm-before-book • include-meeting-type+location • same-turn end_call • status+tool pairing • single-flight • pinned-ISO • no-tool-speech]\n\n` +
      `You are the AI phone receptionist for The Victory Team (VictoryTeamSells.com) — Maryland real estate.\n` +
      `Timezone: ${BIZ_TZ}. Hours: Mon–Fri 9:00–17:00.\n\n` +
      `Brand\n- Friendly, concise, confident, local.\n- Office: 1316 E Churchville Rd, Bel Air MD 21014. Main: 833-888-1754.\n- Services: buyer consults and tours; seller/listing consults; investors; general Q&A.\n\n` +
      `Opening\n- Say: “Thanks for calling The Victory Team. How can I help today?”\n\n` +
      `Core Interaction Rules\n- Prompt-driven only. Transport executes exactly the tool calls you request.\n- One question at a time. ≤15 words unless reading back details.\n- Respect barge-in. No repeats. Check your scratchpad before asking.\n\n` +
      `Scratchpad\n- Name, Phone (+1XXXXXXXXXX normalized), Role, Service, Property/MLS, Date, Time, Meeting Type, Location, Notes.\n\n` +
      `Identity and Numbers\n- Use caller ID if they say “this number.” Only ask for a different number if they state one.\n- Never speak full phone numbers. Acknowledge with “noted.” If the caller insists, confirm only the last two digits.\n\n` +
      `Status/Tool Pairing Contract\n- A status line MUST be followed by the matching tool call in the SAME turn.\n- After the tool result, say exactly one short outcome line, then ask one question.\n- Coalesce status lines. Max one every 2.5 seconds.\n- Single-flight: never call the same tool twice for the same ISO window; dedupe by “startISO|endISO.”\n- Never say function names, arguments, code, or ISO strings.\n\n` +
      `Required Fields BEFORE any read_availability or book_appointment\n- You MUST have: service, name, phone, meeting type (in-person or virtual), and location (if in-person).\n- If any are missing, ask exactly one question to get the next missing item. Do not check or book until all are captured.\n\n` +
      `Confirm-Then-Book (strict)\n1) Propose the time back and get an explicit “yes”.\n2) Encode the hour in ${BIZ_TZ} correctly (e.g., 3 PM → 15:00-04:00 when EDT).\n3) Call read_availability(startISO,endISO) in the SAME turn using that exact local hour.\n4) If free → outcome “That hour is open.” Then immediately call book_appointment in the SAME turn with the SAME startISO/endISO. Include meeting_type and location, and copy them into Notes.\n5) If busy OR booking fails → ≤12-word outcome. Then offer 2–3 nearby in-hours options and ask one question.\n6) After a successful booking, confirm weekday + full date, time, meeting type, location, and notes. Then ask if they need anything else.\n\n` +
      `Time Handling\n- Business hours: 09:00–17:00 ${BIZ_TZ}. Never propose or attempt outside hours.\n- Always send ISO-8601 with the correct ET offset.\n- If a tool rejects an hour as out-of-hours or invalid, do not say “booked.” Offer the nearest in-hours options instead.\n\n` +
      `Reschedule / Cancel\n- find_customer_events → if single future match, capture event_id.\n- Reschedule: verify new hour with read_availability → cancel_appointment(event_id) → book_appointment.\n- Cancel: cancel_appointment(event_id). Outcome line. Ask if they want to rebook.\n\n` +
      `Ambiguous Times\n- If same-day “1:00” and context suggests afternoon, assume 1 PM once and confirm; else ask AM/PM.\n\n` +
      `Transfer / End\n- If caller asks for a human, call transfer(reason, callSid) and then stop.\n- If caller declines more help or says goodbye, say “Thanks for calling The Victory Team. Have a great day. Goodbye.” and in the SAME TURN call end_call(callSid).\n\n` +
      `Latency / Failure\n- If a tool will run, first say one short status line, then call the tool in the same turn.\n- If a tool fails, give a 5–10 word outcome and propose one concrete next step.\n`
  };

  return [system1, system2];
}

// ---- Simple inbound WS that simulates a call session ----
wss.on("connection", ws => {
  console.log(JSON.stringify({ evt: "WS_CONN" }));
  ws.__mem = [];
  ws.__llmBusy = false;
  ws.__queued = null;
  ws.__callSid = ""; // populate from your telephony stack if needed

  ws.on("message", async raw => {
    let msg = {};
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "start_call") {
      console.log(JSON.stringify({ evt: "CALL_START", from: msg.from || "" }));
      const messages = [
        ...seedPrompt(),
        { role: "assistant", content: "Thanks for calling The Victory Team. How can I help today?" }
      ];
      await speakULaw(ws, "Thanks for calling The Victory Team. How can I help today?");
      ws.__mem = messages;
      return;
    }

    if (msg.type === "user_text") {
      const messages = [...(ws.__mem || []), { role: "user", content: msg.text || "" }];
      const reply = await runTools(ws, messages);
      ws.__mem = [...messages, ...(reply ? [{ role: "assistant", content: reply }] : [])];
      return;
    }
  });
});

// ---- HTTP health + root ----
app.get("/", (_req, res) => {
  res.type("text").send("OK");
});

// ---- Startup ----
server.listen(PORT, () => {
  console.log(`[INIT] listening on ${PORT}`);
  console.log("[INIT] URLS", URLS);
  console.log("[INIT] TENANT", { DASH_SOURCE: "voice", BIZ_TZ });
});
