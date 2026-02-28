// netlify/functions/mark.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Keep these stationIds EXACTLY the same as index.html + station.html
const ALLOWED_STATIONS = new Set([
  "blood_transfusion_refusal",
  "confidentiality_breach",
  "colleague_error",
  "dnar_conflict",
  "capacity_refusal",
  "breaking_bad_news",
  "team_conflict",
  "cultural_refusal",
  "consent_understanding",
  "relative_requests_information",
]);

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

// Basic “is this real English sentence(s)?” check
function looksLikeGibberish(text) {
  const t = (text || "").trim();
  if (!t) return true;

  // Word count
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return true;

  // Ratio of letters
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (letters / Math.max(1, t.length) < 0.55) return true;

  // Too repetitive (e.g., "fffff", "hahaha", "dfdfdf")
  const uniqueChars = new Set(t.replace(/\s+/g, "").split("")).size;
  if (uniqueChars <= 5 && t.length >= 10) return true;

  return false;
}

function instantLowScoreResponse(reason) {
  return {
    scores: {
      overall: 1,
      communication: 1,
      empathy: 1,
      ethics: 1,
      insight: 1,
    },
    feedback: {
      main: `Your main answer didn’t contain enough meaningful content to assess (${reason}).`,
      followups: {
        f1: "Add a real, structured answer (clear steps + justification).",
        f2: "Use specific frameworks (e.g., capacity test, GMC confidentiality).",
        f3: "Finish with escalation + documentation + safety-netting where relevant.",
      },
    },
    models: {
      main: { bullets: "", full: "" },
      followups: {
        f1: { bullets: "", full: "" },
        f2: { bullets: "", full: "" },
        f3: { bullets: "", full: "" },
      },
    },
  };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const stationId = payload.stationId;
  if (!stationId || !ALLOWED_STATIONS.has(stationId)) {
    return json(400, { error: "Unknown stationId" });
  }

  const stationTitle = payload.stationTitle || "";
  const prompts = payload.prompts || {};
  const answers = payload.answers || {};
  const name = payload.name || "";

  const main = (answers.main || "").trim();
  const f1 = (answers.f1 || "").trim();
  const f2 = (answers.f2 || "").trim();
  const f3 = (answers.f3 || "").trim();

  if (!main) {
    return json(400, { error: "Main answer is required." });
  }

  // Kill “random letters” scoring BEFORE the model
  if (looksLikeGibberish(main)) {
    return json(200, instantLowScoreResponse("too short / gibberish"));
  }

  // JSON schema the model MUST follow
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      scores: {
        type: "object",
        additionalProperties: false,
        properties: {
          overall: { type: "number" },
          communication: { type: "number" },
          empathy: { type: "number" },
          ethics: { type: "number" },
          insight: { type: "number" },
        },
        required: ["overall", "communication", "empathy", "ethics", "insight"],
      },
      feedback: {
        type: "object",
        additionalProperties: false,
        properties: {
          main: { type: "string" },
          followups: {
            type: "object",
            additionalProperties: false,
            properties: {
              f1: { type: "string" },
              f2: { type: "string" },
              f3: { type: "string" },
            },
            required: ["f1", "f2", "f3"],
          },
        },
        required: ["main", "followups"],
      },
      models: {
        type: "object",
        additionalProperties: false,
        properties: {
          main: {
            type: "object",
            additionalProperties: false,
            properties: {
              bullets: { type: "string" },
              full: { type: "string" },
            },
            required: ["bullets", "full"],
          },
          followups: {
            type: "object",
            additionalProperties: false,
            properties: {
              f1: {
                type: "object",
                additionalProperties: false,
                properties: {
                  bullets: { type: "string" },
                  full: { type: "string" },
                },
                required: ["bullets", "full"],
              },
              f2: {
                type: "object",
                additionalProperties: false,
                properties: {
                  bullets: { type: "string" },
                  full: { type: "string" },
                },
                required: ["bullets", "full"],
              },
              f3: {
                type: "object",
                additionalProperties: false,
                properties: {
                  bullets: { type: "string" },
                  full: { type: "string" },
                },
                required: ["bullets", "full"],
              },
            },
            required: ["f1", "f2", "f3"],
          },
        },
        required: ["main", "followups"],
      },
    },
    required: ["scores", "feedback", "models"],
  };

  const system = `
You are a strict UK medical school MMI examiner and coach.

CRITICAL SCORING RULES:
- If the answer is vague, nonsense, filler, or random letters, scores must be 0–1/10.
- Scores must reflect evidence in the candidate’s text, not the prompt.
- Keep scores realistic (most average answers: 4–7; excellent: 8–10; weak: 0–3).

OUTPUT:
Return ONLY valid JSON matching the schema.
No markdown. No extra keys.
`;

  const user = `
Station: ${stationTitle}
Student: ${name || "Unknown"}

PROMPTS:
Main: ${prompts.main || ""}
F1: ${prompts.f1 || ""}
F2: ${prompts.f2 || ""}
F3: ${prompts.f3 || ""}

ANSWERS:
Main: ${main}
F1: ${f1}
F2: ${f2}
F3: ${f3}

TASK:
1) Give scores out of 10 for overall, communication, empathy, ethics, insight.
2) Give feedback for main answer (specific, actionable, structured).
3) Give feedback for each follow-up answer separately (f1/f2/f3).
4) Provide model answers:
   - main: bullets + full
   - f1: bullets + full
   - f2: bullets + full
   - f3: bullets + full
`;

  try {
    const resp = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: user }] },
      ],

      // ✅ THIS is the fix: Responses API uses text.format, not response_format  [oai_citation:3‡OpenAI Developers](https://developers.openai.com/api/reference/resources/responses/methods/create)
      text: {
        format: {
          type: "json_schema",
          name: "mmi_marking",
          schema,
          strict: true,
        },
      },
    });

    // The SDK returns content in output_text segments; easiest: use resp.output_text
    const raw = resp.output_text?.trim();
    if (!raw) return json(500, { error: "Empty model output" });

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return json(500, { error: "Invalid model JSON", raw: raw.slice(0, 800) });
    }

    return json(200, data);
  } catch (e) {
    return json(500, {
      error: "OpenAI request failed",
      details: e?.message || String(e),
    });
  }
}
