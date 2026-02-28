// netlify/functions/mark.js

function words(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

async function callOpenAI({ apiKey, input, max_output_tokens = 2600, timeoutMs = 50000 }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
      max_output_tokens,
    }),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  const raw = await resp.text();
  if (!resp.ok) {
    return { ok: false, status: resp.status, raw };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, status: 500, raw: "OpenAI returned non-JSON HTTP body." };
  }

  const outText =
    data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text || "";

  let parsed;
  try {
    parsed = JSON.parse(outText);
  } catch {
    return { ok: false, status: 500, raw: outText.slice(0, 1400) };
  }

  return { ok: true, parsed };
}

exports.handler = async (event) => {
  try {
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
      return json(500, {
        error: "Server misconfigured: OPENAI_API_KEY missing in Netlify env vars.",
      });
    }

    const body = JSON.parse(event.body || "{}");
    const { stationId, stationTitle, prompts, answers, name } = body || {};

    if (!stationId) return json(400, { error: "stationId missing" });
    if (!prompts || !prompts.main) return json(400, { error: "prompts missing" });
    if (!answers || !String(answers.main || "").trim())
      return json(400, { error: "Main answer is required." });

    // ----------------------------
    // CALL 1: full grading + models
    // ----------------------------
    const input1 = `
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

Model answers:
- Provide model answers separately for MAIN and each FOLLOW-UP.
- BULLETS must be structured and scannable using exactly these headings (each on its own line):
Opening line:
Key steps:
Safety / escalation:
Legal / ethical / GMC:
Close / safety-net:

- FULL answers must be USER-FRIENDLY:
  - No headings inside the paragraph.
  - Max 2 paragraphs.
  - Natural signposting is fine (First… Then… Finally…), but keep it flowing.

Length targets:
- MAIN full: 300–450 words.
- Each FOLLOW-UP full: 180–260 words.
- Bullets: concise but complete.

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

    const r1 = await callOpenAI({
      apiKey,
      input: input1,
      max_output_tokens: 3200, // more room for longer models
      timeoutMs: 50000,
    });

    if (!r1.ok) {
      return json(r1.status, {
        error: `OpenAI request failed (${r1.status})`,
        details: String(r1.raw || "").slice(0, 1400),
      });
    }

    let result = r1.parsed;

    // ----------------------------
    // ENFORCEMENT: if models are too short -> CALL 2 expand only models.full
    // ----------------------------
    const minMain = 260; // hard minimum
    const minFU = 140;   // hard minimum

    const full = result?.models?.full || {};
    const needExpand =
      words(full.main) < minMain ||
      words(full.f1) < minFU ||
      words(full.f2) < minFU ||
      words(full.f3) < minFU;

    if (needExpand) {
      const input2 = `
You are improving ONLY the model FULL answers for a UK medical school MMI.

You MUST return ONLY valid JSON.

You will be given the station prompts and your current draft model FULL answers.
Rewrite them to meet minimum word counts and quality:

Requirements for FULL answers:
- USER-FRIENDLY paragraphs (no headings like "Opening / Explain / Safety-net").
- Max 2 paragraphs per answer.
- Natural signposting is fine.
- Make them "rigid" UK MMI standard: practical actions, escalation, documentation, GMC/ethics where relevant.
- KEEP content aligned to the prompt.

Minimum lengths:
- MAIN full: at least ${minMain} words.
- Each FOLLOW-UP full: at least ${minFU} words.

PROMPTS:
Main: ${prompts.main}
F1: ${prompts.f1 || ""}
F2: ${prompts.f2 || ""}
F3: ${prompts.f3 || ""}

CURRENT FULL (rewrite these longer + better):
Main: ${full.main || ""}
F1: ${full.f1 || ""}
F2: ${full.f2 || ""}
F3: ${full.f3 || ""}

Return JSON in this exact shape:
{
  "full": { "main": "string", "f1": "string", "f2": "string", "f3": "string" }
}
`.trim();

      const r2 = await callOpenAI({
        apiKey,
        input: input2,
        max_output_tokens: 2600,
        timeoutMs: 50000,
      });

      if (r2.ok && r2.parsed?.full) {
        // merge expanded full answers back in
        result.models = result.models || {};
        result.models.full = {
          main: r2.parsed.full.main || result.models.full?.main || "",
          f1: r2.parsed.full.f1 || result.models.full?.f1 || "",
          f2: r2.parsed.full.f2 || result.models.full?.f2 || "",
          f3: r2.parsed.full.f3 || result.models.full?.f3 || "",
        };
      }
    }

    return json(200, result);
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Request timed out (server abort). Try again — if it keeps happening, we’ll reduce output slightly."
        : err?.message || "Unknown server error";

    return json(500, { error: msg });
  }
};
