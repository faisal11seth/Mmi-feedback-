// netlify/functions/mark.js
export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = safeJson(event.body);
    if (!body) return json(400, { error: "Invalid JSON body" });

    const { stationId, stationTitle, stationDesc, prompts, answers, name } = body;

    if (!stationId) return json(400, { error: "Missing stationId" });
    if (!prompts || !prompts.main) return json(400, { error: "Missing station prompts" });
    if (!answers || typeof answers !== "object") return json(400, { error: "Missing answers" });

    // ---- HARD VALIDATION: stop “random letters” scoring ----
    const main = (answers.main || "").trim();
    const f1 = (answers.f1 || "").trim();
    const f2 = (answers.f2 || "").trim();
    const f3 = (answers.f3 || "").trim();

    const mainCheck = validateAnswer(main);
    if (!mainCheck.ok) return json(400, { error: `Main answer: ${mainCheck.reason}` });

    // follow-ups can be optional, but if they typed something, also validate
    for (const [key, val] of Object.entries({ f1, f2, f3 })) {
      if (val.length > 0) {
        const c = validateAnswer(val, { minWords: 6, minChars: 25 });
        if (!c.ok) return json(400, { error: `${key.toUpperCase()} answer: ${c.reason}` });
      }
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return json(500, { error: "Missing OPENAI_API_KEY" });

    // Use your existing model if you already set one in env
    const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const payloadForModel = {
      station: {
        id: stationId,
        title: stationTitle || "",
        desc: stationDesc || "",
      },
      prompts: {
        main: prompts.main,
        f1: prompts.f1 || "",
        f2: prompts.f2 || "",
        f3: prompts.f3 || "",
      },
      answers: {
        main,
        f1,
        f2,
        f3,
      },
      studentName: (name || "").trim(),
      markingRules: {
        ukContext: true,
        scoreScale: "0-10",
        gibberishPolicy: "If answer is meaningless, score 0-1 and explicitly say it's too short/unclear.",
      },
    };

    const system = `
You are an expert UK medical school MMI interviewer and marker.
Return STRICT JSON only (no markdown, no extra text).
Be harsh on low-effort answers. Random letters or vague filler must score 0–1/10.

Mark separately:
- Main question
- Follow-up 1
- Follow-up 2
- Follow-up 3

For each question return:
- score (0-10 integer)
- feedback: strengths (bullets), improvements (bullets), next_steps (bullets)
- model_answer: bullets (5-10 bullets), full (a spoken-style answer ~150-220 words)

Also return:
- domain_scores (overall, communication, empathy, ethics_reasoning, insight) each 0-10 integer
- overall_summary (1-3 sentences)
`;

    // JSON schema forces clean output
    const schema = {
      name: "MMIFeedback",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          domain_scores: {
            type: "object",
            additionalProperties: false,
            properties: {
              overall: { type: "integer", minimum: 0, maximum: 10 },
              communication: { type: "integer", minimum: 0, maximum: 10 },
              empathy: { type: "integer", minimum: 0, maximum: 10 },
              ethics_reasoning: { type: "integer", minimum: 0, maximum: 10 },
              insight: { type: "integer", minimum: 0, maximum: 10 },
            },
            required: ["overall", "communication", "empathy", "ethics_reasoning", "insight"],
          },
          overall_summary: { type: "string" },
          per_question: {
            type: "array",
            minItems: 4,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", enum: ["main", "f1", "f2", "f3"] },
                question: { type: "string" },
                score: { type: "integer", minimum: 0, maximum: 10 },
                feedback: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    strengths: { type: "array", items: { type: "string" } },
                    improvements: { type: "array", items: { type: "string" } },
                    next_steps: { type: "array", items: { type: "string" } },
                  },
                  required: ["strengths", "improvements", "next_steps"],
                },
                model_answer: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    bullets: { type: "array", items: { type: "string" } },
                    full: { type: "string" },
                  },
                  required: ["bullets", "full"],
                },
              },
              required: ["id", "question", "score", "feedback", "model_answer"],
            },
          },
        },
        required: ["domain_scores", "overall_summary", "per_question"],
      },
    };

    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payloadForModel) },
        ],
        // strict JSON output
        response_format: {
          type: "json_schema",
          json_schema: schema,
        },
      }),
    });

    const rawText = await openaiRes.text();
    const parsed = safeJson(rawText);

    if (!openaiRes.ok) {
      return json(500, {
        error: "OpenAI request failed",
        details: parsed?.error?.message || rawText.slice(0, 500),
      });
    }

    // Responses API returns { output: [...] } — easiest is to extract the JSON from output_text
    const outputText = extractOutputText(parsed);
    const data = safeJson(outputText) || parsed; // schema usually makes outputText already JSON string

    // If something weird, fail clearly
    if (!data || !data.domain_scores || !Array.isArray(data.per_question)) {
      return json(500, {
        error: "Invalid model JSON",
        details: outputText?.slice?.(0, 500) || rawText.slice(0, 500),
      });
    }

    return json(200, data);
  } catch (e) {
    return json(500, { error: "Server error", details: String(e?.message || e) });
  }
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

function safeJson(x) {
  try {
    if (typeof x === "string") return JSON.parse(x);
    return x;
  } catch {
    return null;
  }
}

// Detect “random letters”, too short, or no real words
function validateAnswer(text, opts = {}) {
  const minChars = opts.minChars ?? 35;
  const minWords = opts.minWords ?? 10;

  if (!text || text.trim().length === 0) return { ok: false, reason: "is empty" };

  const t = text.trim();
  if (t.length < minChars) return { ok: false, reason: `too short (min ${minChars} characters)` };

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < minWords) return { ok: false, reason: `too short (min ${minWords} words)` };

  const letters = t.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 20) return { ok: false, reason: "not enough meaningful text" };

  // gibberish-ish: very low vowel ratio often means keyboard mash
  const vowels = letters.match(/[aeiou]/gi)?.length || 0;
  const vowelRatio = vowels / Math.max(letters.length, 1);
  if (vowelRatio < 0.20) return { ok: false, reason: "looks like gibberish / keyboard mash" };

  // too repetitive
  const unique = new Set(words.map(w => w.toLowerCase()));
  if (unique.size < Math.min(5, words.length)) return { ok: false, reason: "too repetitive / low content" };

  return { ok: true };
}

function extractOutputText(responsesApiJson) {
  // Responses API shape varies; this is a resilient extractor:
  // Look for any output_text content.
  const out = responsesApiJson?.output;
  if (!Array.isArray(out)) return null;

  let text = "";
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") {
        text += c.text;
      }
    }
  }
  return text || null;
}
