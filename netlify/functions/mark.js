// netlify/functions/mark.js

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Server misconfigured: OPENAI_API_KEY missing in Netlify env vars." }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { stationId, stationTitle, prompts, answers, name } = body || {};

    if (!stationId) {
      return { statusCode: 400, body: JSON.stringify({ error: "stationId missing" }) };
    }
    if (!prompts || !prompts.main) {
      return { statusCode: 400, body: JSON.stringify({ error: "prompts missing" }) };
    }
    if (!answers || !String(answers.main || "").trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: "Main answer is required." }) };
    }

    // Keep it shorter to reduce timeouts + cost
    const input = `
You are a strict UK medical school MMI examiner.

Return ONLY valid JSON.

Station ID: ${stationId}
Station Title: ${stationTitle || ""}

PROMPTS:
Main: ${prompts.main}
F1: ${prompts.f1}
F2: ${prompts.f2}
F3: ${prompts.f3}

STUDENT NAME (optional): ${name || ""}

ANSWERS:
Main: ${answers.main}
F1: ${answers.f1 || ""}
F2: ${answers.f2 || ""}
F3: ${answers.f3 || ""}

Rules:
- If answers are nonsense/too short (e.g., random letters), score low (0–2/10) and explain why.
- Provide feedback separately for MAIN and each FOLLOW-UP.
- Provide model answers separately for MAIN and each FOLLOW-UP in BOTH bullets and full.

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
    const timeout = setTimeout(() => controller.abort(), 25000); // 25s safety

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input,
        // ✅ correct replacement for the old response_format
        text: { format: { type: "json_object" } },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const raw = await resp.text();
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({
          error: `OpenAI request failed (${resp.status})`,
          details: raw.slice(0, 900),
        }),
      };
    }

    const data = JSON.parse(raw);

    // Extract the text output
    const outText =
      data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ||
      "";

    // outText should already be JSON due to text.format, but we still guard
    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch (e) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Model returned non-JSON output unexpectedly.",
          details: outText.slice(0, 900),
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Request timed out (server abort). Try shorter answers or reduce output."
        : (err?.message || "Unknown server error");

    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }
};
