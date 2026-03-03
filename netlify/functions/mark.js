// netlify/functions/mark.js
const fs = require("fs");
const path = require("path");

function clampText(s, maxChars) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > maxChars ? t.slice(0, maxChars) + "…" : t;
}

// Optional: load exemplars from netlify/functions/exemplars.json if it exists
function loadExemplars() {
  try {
    const p = path.join(__dirname, "exemplars.json");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw);
    }
  } catch (_) {}
  return null;
}

function pickStationExemplars(all, stationId) {
  if (!all || !stationId) return null;
  return all[stationId] || null;
}

function exBlock(label, obj) {
  if (!obj) return "";
  const excellent = clampText(obj.excellent, 900);
  const average   = clampText(obj.average, 700);
  const poor      = clampText(obj.poor, 500);

  const lines = [];
  if (excellent) lines.push(`- Excellent: ${excellent}`);
  if (average)   lines.push(`- Average: ${average}`);
  if (poor)      lines.push(`- Poor: ${poor}`);
  if (!lines.length) return "";
  return `\n${label} EXEMPLARS:\n${lines.join("\n")}\n`;
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
        body: JSON.stringify({ error: "Server misconfigured: OPENAI_API_KEY missing in Netlify env vars." }),
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

    // Clamp answers (avoid runaway token/timeouts)
    const aMain = clampText(answers.main, 2200);
    const aF1   = clampText(answers.f1, 1200);
    const aF2   = clampText(answers.f2, 1200);
    const aF3   = clampText(answers.f3, 1200);

    // Optional exemplars per station
    const exemplarsAll = loadExemplars();
    const stationEx = pickStationExemplars(exemplarsAll, stationId);

    const exemplarsText = stationEx
      ? [
          exBlock("MAIN", stationEx.main),
          exBlock("F1", stationEx.f1),
          exBlock("F2", stationEx.f2),
          exBlock("F3", stationEx.f3),
        ].join("")
      : "";

    // IMPORTANT: Output schema matches station.html exactly.
    // Follow-ups: bullets only (as ONE string each), no "full" keys.
    const input = `
You are a strict UK medical school MMI examiner.

Return ONLY valid JSON. No markdown. No extra keys.

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
${exemplarsText ? `\nREFERENCE EXEMPLARS (calibrate scoring + structure; do NOT copy verbatim):\n${exemplarsText}\n` : ""}

Rules:
- Score each domain 0–10. Overall reflects the whole performance.
- If any answer is nonsense/too short/irrelevant, score 0–2 and explain clearly.
- Feedback must be specific and improvement-focused.

Model answers:
- MAIN:
  - Provide bullet points (each bullet on its own line starting with "- ").
  - Provide one FULL natural paragraph model answer (no labels inside the paragraph).
- FOLLOW-UPS (f1,f2,f3):
  - Provide bullet points ONLY (each bullet on its own line starting with "- ").
  - Make them detailed (8–12 bullets) but still readable.

Return JSON in EXACTLY this shape:

{
  "scores": { "overall": 0, "communication": 0, "empathy": 0, "ethics": 0, "insight": 0 },
  "feedback": {
    "main": "string",
    "followups": { "f1": "string", "f2": "string", "f3": "string" }
  },
  "models": {
    "main": { "bullets": "string", "full": "string" },
    "followups": { "f1": "string", "f2": "string", "f3": "string" }
  }
}
`.trim();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 24000);

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input,
        text: { format: { type: "json_object" } },
        max_output_tokens: 1600
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
        : (err?.message || "Unknown server error");

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: msg }),
    };
  }
};
