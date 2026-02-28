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

Return ONLY valid JSON (no markdown, no commentary).

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
- If any answer is nonsense/too short (e.g., random letters), score low (0–2/10) and explain why.
- Give feedback separately for MAIN and each FOLLOW-UP (f1, f2, f3).
- Generate model answers separately for MAIN and each FOLLOW-UP.

MODEL ANSWERS MUST BE RIGID + CONSISTENT FOR EVERY STATION.

For MAIN and for each FOLLOW-UP:
A) BULLETS (use exactly these headings):
Opening line:
Key steps:
Safety / escalation:
Legal / ethical / GMC:
Close / safety-net:

B) FULL (use exactly these headings):
Opening (1–2 sentences):
Approach (2–4 sentences):
Explain / Justify (2–4 sentences):
Escalation + Safety-net (1–3 sentences):
Close (1 sentence):

Word targets (KEEP WITHIN):
- MAIN full: 140–200 words.
- Each FOLLOW-UP full: 90–140 words.
- Bullets should be compact (no essays).

Style:
- UK MMI tone, signposting (“First… Next… Finally…”).
- Directly answer each prompt.
- Do NOT add extra sections.

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
    const timeout = setTimeout(() => controller.abort(), 40000); // 40s safety

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
        max_output_tokens: 1600, // key: prevents huge outputs = fewer timeouts
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

    // Extract text output (Responses API)
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
        ? "Request timed out (server abort). Output still too large/slow — reduce model answer length further."
        : err?.message || "Unknown server error";

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: msg }),
    };
  }
};
