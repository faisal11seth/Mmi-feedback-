// netlify/functions/mark.js
const fs = require("fs");
const path = require("path");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function loadExemplars(stationId) {
  try {
    const p = path.join(process.cwd(), "training", `${stationId}.json`);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json(500, { error: "OPENAI_API_KEY missing in Netlify env vars." });

    const body = JSON.parse(event.body || "{}");
    const { stationId, stationTitle, prompts, answers, name } = body || {};

    if (!stationId) return json(400, { error: "stationId missing" });
    if (!prompts?.main) return json(400, { error: "prompts missing" });
    if (!String(answers?.main || "").trim()) return json(400, { error: "Main answer is required." });

    const ex = loadExemplars(stationId);

    // Keep tokens controlled: include only EXEMPLARS + RUBRIC if available
    const exemplarBlock = ex
      ? `
RUBRIC (use for scoring):
${JSON.stringify(ex.rubric || {}, null, 0)}

EXEMPLARS (calibrate scoring; do not copy verbatim, write original model answers):
${JSON.stringify(ex.exemplars || {}, null, 0)}
`.trim()
      : "No exemplar file found for this stationId.";

    const input = `
You are a strict UK medical school MMI examiner.

Return ONLY valid JSON (no markdown, no extra keys).

Station ID: ${stationId}
Station Title: ${stationTitle || ""}

PROMPTS:
Main: ${prompts.main}
F1: ${prompts.f1 || ""}
F2: ${prompts.f2 || ""}
F3: ${prompts.f3 || ""}

STUDENT (optional): ${name || ""}

ANSWERS:
Main: ${answers.main}
F1: ${answers.f1 || ""}
F2: ${answers.f2 || ""}
F3: ${answers.f3 || ""}

${exemplarBlock}

Rules:
- Score 0–2/10 if an answer is nonsense/too short; explain why.
- Give feedback separately for MAIN and each FOLLOW-UP.
- Provide model answers:
- MAIN: bullets + full (detailed)
- FOLLOW-UPS: bullets only (concise)
- Full model answers should be a single readable paragraph (no labels like "Opening line:" etc).

Return JSON in this EXACT shape:
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
    const timeout = setTimeout(() => controller.abort(), 25000);

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
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const raw = await resp.text();
    if (!resp.ok) return json(resp.status, { error: `OpenAI request failed (${resp.status})`, details: raw.slice(0, 900) });

    const data = JSON.parse(raw);
    const outText = data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text || "";

    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch {
      return json(500, { error: "Model returned non-JSON output.", details: outText.slice(0, 900) });
    }

    return json(200, parsed);
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Request timed out (server abort). Try shorter answers or reduce output."
        : err?.message || "Unknown server error";
    return json(500, { error: msg });
  }
};
