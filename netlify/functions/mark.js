// netlify/functions/mark.js

const fs = require("fs");
const path = require("path");

// Optional: load exemplars from netlify/functions/exemplars.json if it exists
function loadExemplars() {
  try {
    const p = path.join(__dirname, "exemplars.json");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const json = JSON.parse(raw);
      return json;
    }
  } catch (e) {
    // swallow – exemplars are optional
  }
  return null;
}

// Keep prompt tight: only include station exemplars if present
function pickStationExemplars(allExemplars, stationId) {
  if (!allExemplars || !stationId) return null;
  const x = allExemplars[stationId];
  if (!x) return null;
  return x;
}

// Reduce payload size: clamp very long answers (prevents runaway tokens)
function clampText(s, maxChars) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > maxChars ? t.slice(0, maxChars) + "…" : t;
}

exports.handler = async (event) => {
  try {
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
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "stationId missing" }) };
    }
    if (!prompts || !prompts.main) {
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "prompts missing" }) };
    }
    if (!answers || !String(answers.main || "").trim()) {
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Main answer is required." }) };
    }

    const exemplarsAll = loadExemplars();
    const stationEx = pickStationExemplars(exemplarsAll, stationId);

    // Clamp inputs so one giant paste can’t nuke runtime
    const aMain = clampText(answers.main, 2200);
    const aF1 = clampText(answers.f1, 1200);
    const aF2 = clampText(answers.f2, 1200);
    const aF3 = clampText(answers.f3, 1200);

    // Keep exemplars compact too (but still useful)
    // Expected exemplars.json shape (flexible):
    // exemplars[stationId] = {
    //   main: { excellent: "...", average: "...", poor: "..." },
    //   f1:   { excellent: "...", average: "...", poor: "..." },
    //   f2:   { excellent: "...", average: "...", poor: "..." },
    //   f3:   { excellent: "...", average: "...", poor: "..." }
    // }
    function exBlock(label, obj) {
      if (!obj) return "";
      const ex = {
        excellent: clampText(obj.excellent, 900),
        average: clampText(obj.average, 700),
        poor: clampText(obj.poor, 500),
      };
      // only include fields that exist
      const lines = [];
      if (ex.excellent) lines.push(`- Excellent: ${ex.excellent}`);
      if (ex.average) lines.push(`- Average: ${ex.average}`);
      if (ex.poor) lines.push(`- Poor: ${ex.poor}`);
      if (!lines.length) return "";
      return `\n${label} EXEMPLARS:\n${lines.join("\n")}\n`;
    }

    const exemplarsText = stationEx
      ? [
          exBlock("MAIN", stationEx.main),
          exBlock("F1", stationEx.f1),
          exBlock("F2", stationEx.f2),
          exBlock("F3", stationEx.f3),
        ].join("")
      : "";

    // ✅ Key optimisation: full model answer ONLY for MAIN.
    // Follow-ups get bullets only (fast, still high quality).
    const input = `
You are a strict UK medical school MMI examiner.

Return ONLY valid JSON. No markdown. No extra keys. No explanations outside JSON.

Station ID: ${stationId}
Station Title: ${clampText(stationTitle || "", 120)}

PROMPTS:
Main: ${clampText(prompts.main, 350)}
F1: ${clampText(prompts.f1 || "", 220)}
F2: ${clampText(prompts.f2 || "", 220)}
F3: ${clampText(prompts.f3 || "", 220)}

STUDENT NAME (optional): ${clampText(name || "", 60)}

ANSWERS:
Main: ${aMain}
F1: ${aF1}
F2: ${aF2}
F3: ${aF3}
${exemplarsText ? `\nREFERENCE EXEMPLARS (use to calibrate scoring + tone; do not copy verbatim):\n${exemplarsText}\n` : ""}

Rules:
- Score each domain 0–10. Overall should reflect the whole performance.
- If an answer is nonsense/too short (random letters / irrelevant), score 0–2 and explain clearly.
- Give feedback separately for MAIN and each FOLLOW-UP (f1,f2,f3). Be specific and improvement-focused.
- Model answers:
  - MAIN: provide BOTH bullets AND a FULL, natural, user-friendly model answer (no weird labels like "safety net:" mid-paragraph).
  - FOLLOW-UPS: provide BULLETS only (concise but high quality).

Return JSON in EXACTLY this shape:

{
  "scores": { "overall": 0, "communication": 0, "empathy": 0, "ethics": 0, "insight": 0 },
  "feedback": {
    "main": "string",
    "followups": { "f1": "string", "f2": "string", "f3": "string" }
  },
  "models": {
    "bullets": { "main": "string", "f1": "string", "f2": "string", "f3": "string" },
    "full": { "main": "string" }
  }
}
`.trim();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 24000); // keep under typical limits

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
        // optional but helps prevent runaway verbose outputs
        // max_output_tokens: 1400,
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
          details: raw.slice(0, 900),
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
        : err?.message || "Unknown server error";

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: msg }),
    };
  }
};
