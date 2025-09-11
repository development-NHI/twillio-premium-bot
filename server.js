// --- add envs at the top ---
const MAKE_READ_URL = process.env.MAKE_READ_URL || "";
const MAKE_CREATE_URL = process.env.MAKE_CREATE_URL || "";

// --- tool schema GPT sees ---
const TOOLS = [
  {
    type: "function",
    name: "check_availability",
    description: "Return if a time window is free",
    parameters: {
      type: "object",
      properties: {
        startISO: { type: "string", description: "Start time in ISO 8601" },
        endISO:   { type: "string", description: "End time in ISO 8601 (optional)" }
      },
      required: ["startISO"]
    }
  },
  {
    type: "function",
    name: "create_booking",
    description: "Create an appointment in the calendar",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "haircut | beard trim | combo" },
        startISO: { type: "string" },
        endISO:   { type: "string" },
        name:     { type: "string" },
        phone:    { type: "string" },
        email:    { type: "string" }
      },
      required: ["service","startISO","name","phone"]
    }
  }
];

// --- tiny helper to execute a tool via your Make URL ---
async function runTool(name, args, callMeta = {}) {
  if (name === "check_availability") {
    if (!MAKE_READ_URL) return { ok:false, reason:"no MAKE_READ_URL" };
    const r = await fetch(MAKE_READ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent:"READ", ...args, meta: callMeta }),
    });
    return await r.json().catch(() => ({}));
  }

  if (name === "create_booking") {
    if (!MAKE_CREATE_URL) return { ok:false, reason:"no MAKE_CREATE_URL" };
    const r = await fetch(MAKE_CREATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent:"CREATE", ...args, meta: callMeta }),
    });
    return await r.json().catch(() => ({}));
  }

  return { ok:false, reason:"unknown_tool" };
}

// --- new AI reply that supports tool-calls ---
async function aiReplyWithTools(userText, callMeta = {}) {
  // System prompt tells GPT to do all the flow and only call tools when ready
  const SYSTEM_PROMPT =
    (process.env.SYSTEM_PROMPT ||
    "You are a friendly receptionist. Keep replies under 22 words, one question max. " +
    "Ask for service → time → name → phone; then call tools to check availability and create the booking. " +
    "Only call create_booking after the caller confirms. If info is missing, ask for it. ") +
    "Use check_availability before offering times if the user provided a time.";

  // 1) First request: let model think + possibly call a tool
  const first = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      tools: TOOLS,
      tool_choice: "auto",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Caller: ${userText}` }
      ]
    })
  }).then(r => r.json());

  let msg = first?.choices?.[0]?.message;
  if (!msg) return "Okay. What else can I help with?";

  // 2) If the model called any tools, execute them and send results back
  if (msg.tool_calls && msg.tool_calls.length) {
    const toolResults = [];
    for (const tc of msg.tool_calls.slice(0, 3)) { // keep it simple: up to 3
      const name = tc.function?.name;
      const args = JSON.parse(tc.function?.arguments || "{}");
      const result = await runTool(name, args, callMeta);
      toolResults.push(
        { role: "tool", tool_call_id: tc.id, name, content: JSON.stringify(result) }
      );
    }

    // 3) Ask the model to finish the sentence using the tool results
    const second = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type":"application/json", Authorization:`Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Caller: ${userText}` },
          msg,
          ...toolResults
        ]
      })
    }).then(r => r.json());

    const finalText = second?.choices?.[0]?.message?.content?.trim();
    return finalText || "All set. Anything else?";
  }

  // No tools: just speak the assistant’s text
  return (msg.content || "Okay. What else can I help with?").trim();
}
