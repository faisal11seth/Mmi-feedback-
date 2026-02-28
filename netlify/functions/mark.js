// netlify/functions/mark.js

exports.handler = async (event) => {
  try {
    // Optional preflight support
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

    const input = `
You are a strict UK medical school MMI examiner.

Return ONLY valid JSON (no markdown, no extra commentary).

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

Scoring rules:
- If any answer is nonsense / too short (e.g., random letters), score low (0–2/10) and explain why.
- Use realistic UK MMI scoring, not generous.
- Scores are out of 10 for: overall, communication, empathy, ethics, insight.

Feedback rules:
- Give feedback separately for MAIN and each FOLLOW-UP (f1, f2, f3).
- Feedback should be specific: what was good, what was missing, and how to improve.

Model answer rules (IMPORTANT):
- Provide model answers separately for MAIN and each FOLLOW-UP.
- BULLETS must be structured and scannable using exactly these headings (each on its own line):
Opening line:
Key steps:
Safety / escalation:
Legal / ethical / GMC:
Close / safety-net:

- FULL answers must be USER-FRIENDLY:
  - DO NOT include headings like “Opening / Approach / Explain / Safety-net” inside the text.
  - Write as a single clean exam-ready response (max 2 paragraphs).
  - Use natural signposting (First… Then… Finally…) but keep it flowing.
  - No label breaks every few sentences.

Length targets (STRICT — hit these):
- MAIN full: 260–380 words (more detailed, “rigid” UK MMI standard).
- Each FOLLOW-UP full: 140–210 words.
- Bullets: concise but complete (don’t be vague).

Quality requirements:
- Mention key UK concepts appropriately when relevant (capacity/MCA, best interests, duty of candour, confidentiality, GMC, escalation, documentation, safety-netting).
- Must be specific and practical (exact actions + escalation steps), not generic.

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50000); // 50s safety

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input,
        text: { format: { type: "json_object" } },
        // More room for longer MAIN + follow-ups
        max_output_tokens: 2600,
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

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Request timed out (server abort). Try again, or reduce output slightly if it keeps timing out."
        : err?.message || "Unknown server error";

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: msg }),
    };
  }
};
