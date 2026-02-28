// netlify/functions/mark.js

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: cors(),
        body: ""
      };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json(500, { error: "Server misconfigured: OPENAI_API_KEY missing in Netlify env vars." });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { stationId, stationTitle, prompts, answers, name } = body || {};

    if (!stationId) return json(400, { error: "stationId missing" });
    if (!prompts || !prompts.main) return json(400, { error: "prompts missing" });
    if (!answers || !String(answers.main || "").trim()) return json(400, { error: "Main answer is required." });

    const input = buildPrompt({
      stationId,
      stationTitle: stationTitle || "",
      prompts,
      answers,
      name: name || ""
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input,
        // ✅ new Responses API JSON enforcement
        text: { format: { type: "json_object" } },
        // Optional: helps reduce rambling / token spend
        max_output_tokens: 1200
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const raw = await resp.text();

    if (!resp.ok) {
      return json(resp.status, {
        error: `OpenAI request failed (${resp.status})`,
        details: raw.slice(0, 1200)
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return json(500, { error: "OpenAI returned non-JSON HTTP body", details: raw.slice(0, 1200) });
    }

    const outText = extractOutputText(data);

    if (!outText || !outText.trim()) {
      return json(500, {
        error: "Empty model output (could not extract output_text).",
        details: JSON.stringify(data, null, 2).slice(0, 1200)
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch {
      return json(500, {
        error: "Model returned non-JSON output unexpectedly.",
        details: outText.slice(0, 1200)
      });
    }

    // ✅ Guarantee the exact structure station.html expects
    const normalized = normalizeResult(parsed);

    return json(200, normalized);
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Request timed out (server abort). Try shorter answers."
        : (err?.message || "Unknown server error");

    return json(500, { error: msg });
  }
};

/* ---------------- Helpers ---------------- */

function buildPrompt({ stationId, stationTitle, prompts, answers, name }) {
  return `
You are a strict UK medical school MMI examiner.

Return ONLY valid JSON.

Station ID: ${stationId}
Station Title: ${stationTitle}

PROMPTS:
Main: ${prompts.main}
F1: ${prompts.f1 || ""}
F2: ${prompts.f2 || ""}
F3: ${prompts.f3 || ""}

STUDENT NAME (optional): ${name}

ANSWERS:
Main: ${answers.main}
F1: ${answers.f1 || ""}
F2: ${answers.f2 || ""}
F3: ${answers.f3 || ""}

Marking rules:
- Scores are 0–10 per domain (overall, communication, empathy, ethics, insight).
- If answers are nonsense/too short (e.g., random letters), score 0–2/10 and explicitly say it’s too short/nonsense.
- Feedback must be specific and actionable.
- Feedback must be separate for MAIN and each FOLLOW-UP.
- Model answers must be provided for MAIN and each FOLLOW-UP in BOTH bullets and full.

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
}

function extractOutputText(data) {
  // Prefer the official Responses API shape
  try {
    for (const out of data.output || []) {
      for (const c of out.content || []) {
        if (c.type === "output_text" && typeof c.text === "string") return c.text;
        // Some SDKs use "text" directly
        if (typeof c.text === "string") return c.text;
      }
    }
  } catch {}

  // Fallbacks (sometimes libraries expose output_text)
  if (typeof data.output_text === "string") return data.output_text;
  if (typeof data.text === "string") return data.text;

  return "";
}

function normalizeResult(raw) {
  const scores = raw?.scores || {};
  const feedback = raw?.feedback || {};
  const followups = feedback?.followups || {};
  const models = raw?.models || {};
  const bullets = models?.bullets || {};
  const full = models?.full || {};

  return {
    scores: {
      overall: num(scores.overall),
      communication: num(scores.communication),
      empathy: num(scores.empathy),
      ethics: num(scores.ethics),
      insight: num(scores.insight)
    },
    feedback: {
      main: str(feedback.main),
      followups: {
        f1: str(followups.f1),
        f2: str(followups.f2),
        f3: str(followups.f3)
      }
    },
    models: {
      bullets: {
        main: str(bullets.main),
        f1: str(bullets.f1),
        f2: str(bullets.f2),
        f3: str(bullets.f3)
      },
      full: {
        main: str(full.main),
        f1: str(full.f1),
        f2: str(full.f2),
        f3: str(full.f3)
      }
    }
  };
}

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // clamp 0–10
  return Math.max(0, Math.min(10, Math.round(n)));
}

function str(v) {
  return typeof v === "string" ? v : (v == null ? "" : String(v));
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(code, obj) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json", ...cors() },
    body: JSON.stringify(obj)
  };
}
