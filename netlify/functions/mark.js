// netlify/functions/mark.js

exports.handler = async (event) => {
  try {
    // (Optional) handle preflight if you ever call from a different origin
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
        },
        body: "",
      };
    }

    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Server misconfigured: OPENAI_API_KEY missing in Netlify env vars.",
        }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { stationId, stationTitle, prompts, answers, name } = body || {};

    if (!stationId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "stationId missing" }),
      };
    }
    if (!prompts || !prompts.main) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "prompts missing" }),
      };
    }
    if (!answers || !String(answers.main || "").trim()) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Main answer is required." }),
      };
    }

    // ---- Prompt (this is where your rigid model answer rules live) ----
    const input = `
You are a strict UK medical school MMI examiner.

Return ONLY valid JSON.

Station ID: ${stationId}
Station Title: ${stationTitle || ""}

PROMPTS:
Main: ${prompts.main}
F1: ${prompts.f1 || ""}
F2: ${prompts.f2 || ""}
F3: ${prompts.f3 || ""}

STUDENT NAME (optional): ${name || ""}

ANSWERS:
Main: ${answers.main}
F1: ${answers.f1 || ""}
F2: ${answers.f2 || ""}
F3: ${answers.f3 || ""}

Rules:
- If answers are nonsense/too short (e.g., random letters), score low (0–2/10) and explain why.
- Provide feedback separately for MAIN and each FOLLOW-UP.

MODEL ANSWERS MUST BE RIGID + CONSISTENT FOR EVERY STATION.

For MAIN and for each FOLLOW-UP (f1, f2, f3), output BOTH:
A) bullets
B) full answer

A) BULLETS FORMAT (use exactly these headings):
- Opening line (1 sentence)
- Key steps (6–10 bullets, in order)
- Safety / escalation (1–3 bullets)
- Legal / ethical / GMC angle (1–3 bullets)
- Close / safety-net (1 sentence)

B) FULL ANSWER FORMAT (use exactly these headings and structure):

Opening (1–2 sentences):
…

Approach (3–6 sentences):
…

Explain / Justify (3–6 sentences):
…

Escalation + Safety-net (2–4 sentences):
…

Close (1 sentence):
…

Word targets:
- MAIN full answer: 220–320 words.
- Each FOLLOW-UP full answer: 140–220 words.

Style:
- UK MMI tone, structured, concise.
- Use signposting (“First… Next… Finally…”).
- Directly address the prompt.

Return JSON in this exact shape:

{
  "scores": { "overall": 0, "communication": 0, "empathy": 0, "ethics": 0, "insight": 0 },
  "feedback": {
    "main": "string",
    "followups": { "f1": "string", "f2": "string", "f3": "string" }
  },
  "models": {
    "bullets": { "main": "string", "f1": "string", "f2": "string", "f3": "string" },
    "full": { "main": "string", "f1": "string", "f2": "string", "f3": "string" }
  }
}
`.trim();

    // ---- Call OpenAI Responses API ----
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000); // 25s safety

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input,
        // Force JSON output (replacement for old response_format)
        text: { format: { type: "json_object" } },
        // Give enough room for long per-question model answers
        max_output_tokens: 2800,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const raw = await resp.text();

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: `OpenAI request failed (${resp.status})`,
          details: raw.slice(0, 1200),
        }),
      };
    }

    const data = JSON.parse(raw);

    // Extract the model output text (Responses API format)
    const outText =
      data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text || "";

    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch (e) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Model returned non-JSON output unexpectedly.",
          details: outText.slice(0, 1200),
        }),
      };
    }

    // Return to frontend
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // If you ever host frontend elsewhere, keep this:
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Request timed out (server abort). Try shorter answers or reduce output."
        : err?.message || "Unknown server error";

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: msg }),
    };
  }
};
