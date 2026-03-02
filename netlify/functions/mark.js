// netlify/functions/mark.js

const fs = require("fs");
const path = require("path");

// Optional: load exemplars from netlify/functions/exemplars.json if it exists
function loadExemplars() {
  try {
    const p = path.join(__dirname, "exemplars.json");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    // exemplars are optional
  }
  return null;
}

function pickStationExemplars(allExemplars, stationId) {
  if (!allExemplars || !stationId) return null;
  return allExemplars[stationId] || null;
}

// Reduce payload size: clamp long text so a giant paste doesn't time out
function clampText(s, maxChars) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > maxChars ? t.slice(0, maxChars) + "…" : t;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      // harmless even if same-origin; helps if you test elsewhere
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json(500, { error: "Server misconfigured: OPENAI_API_KEY missing in Netlify env vars." });
    }

    const body = JSON.parse(event.body || "{}");
    const { stationId, stationTitle, prompts, answers, name } = body || {};

    if (!stationId) return json(400, { error: "stationId missing" });
    if (!prompts || !prompts.main) return json(400, { error: "prompts missing" });
    if (!answers || !String(answers.main || "").trim()) return json(400, { error: "Main answer is required." });

    const exemplarsAll = loadExemplars();
    const stationEx = pickStationExemplars(exemplarsAll, stationId);

    // Clamp inputs (prevents runaway tokens + timeouts)
    const aMain = clampText(answers.main, 2200);
    const aF1 = clampText(answers.f1, 1200);
    const aF2 = clampText(answers.f2, 1200);
    const aF3 = clampText(answers.f3, 1200);

    // Exemplars helper (compact but useful)
    function exBlock(label, obj) {
      if (!obj) return "";
      const excellent = clampText(obj.excellent, 900);
      const average = clampText(obj.average, 700);
      const poor = clampText(obj.poor, 500);

      const lines = [];
      if (excellent) lines.push(`- Excellent: ${excellent}`);
      if (average) lines.push(`- Average: ${average}`);
      if (poor) lines.push(`- Poor: ${poor}`);
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

    const input = `
You are a strict UK medical school MMI examiner.

Return ONLY valid JSON. No markdown. No extra keys. No text outside JSON.

Station ID: ${stationId}
Station Title: ${clampText(stationTitle || "", 120)}

PROMPTS:
Main: ${clampText(prompts.main, 380)}
F1: ${clampText(prompts.f1 || "", 240)}
F2: ${clampText(prompts.f2 || "", 240)}
F3: ${clampText(prompts.f3 || "", 240)}

STUDENT NAME (optional): ${clampText(name || "", 60)}

ANSWERS:
Main: ${aMain}
F1: ${aF1}
F2: ${aF2}
F3: ${aF3}
${exemplarsText ? `\nREFERENCE EXEMPLARS (calibrate scoring + tone; do not copy verbatim):\n${exemplarsText}\n` : ""}

Rules:
- Score each domain 0–10. Overall should reflect the whole performance.
- If an answer is nonsense/too short/irrelevant, score 0–2 and explain clearly.
- Give feedback separately for MAIN and each FOLLOW-UP (f1,f2,f3). Be specific and improvement-focused.
- Model answers:
  - MAIN: provide BOTH bullets AND a FULL natural, user-friendly paragraph answer (no weird labels mid-paragraph).
  - FOLLOW-UPS: provide BULLETS ONLY (each bullet on a new line starting with "- ").
- Any "models.bullets.*" MUST use real bullet formatting: each bullet line begins "- ".

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
    const timeout = setTimeout(() => controller.abort(), 24000);

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
        // keep output controlled so Netlify doesn’t die
        max_output_tokens: 1400,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const raw = await resp.text();
    if (!resp.ok) {
      return json(resp.status, {
        error: `OpenAI request failed (${resp.status})`,
        details: raw.slice(0, 900),
      });
    }

    const data = JSON.parse(raw);
    const outText = data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text || "";

    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch (e) {
      return json(500, {
        error: "Model returned non-JSON output unexpectedly.",
        details: outText.slice(0, 900),
      });
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
