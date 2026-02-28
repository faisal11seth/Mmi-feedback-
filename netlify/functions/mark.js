// netlify/functions/mark.js
// Requires env var: OPENAI_API_KEY
// Optional env var: OPENAI_MODEL (default: gpt-4o-mini)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(bodyObj),
  };
}

function safeStr(x) {
  if (x === null || x === undefined) return "";
  return String(x).trim();
}

function clampLen(s, max) {
  s = safeStr(s);
  return s.length > max ? s.slice(0, max) : s;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Use POST." });
  }

  if (!OPENAI_API_KEY) {
    return json(500, { error: "Missing OPENAI_API_KEY in Netlify environment variables." });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Invalid JSON body." });
  }

  // Accept stationId as a label (do NOT hard-fail if unknown)
  const stationId = clampLen(payload.stationId, 80);
  const stationTitle = clampLen(payload.stationTitle, 120);
  const stationTag = clampLen(payload.stationTag, 40);

  const studentName = clampLen(payload.name || payload.studentName, 80);

  const mainQ = clampLen(payload.mainQuestion, 400);
  const f1Q = clampLen(payload.followUp1Question, 260);
  const f2Q = clampLen(payload.followUp2Question, 260);
  const f3Q = clampLen(payload.followUp3Question, 260);

  const mainA = clampLen(payload.main, 2500);
  const f1A = clampLen(payload.f1, 1800);
  const f2A = clampLen(payload.f2, 1800);
  const f3A = clampLen(payload.f3, 1800);

  if (!mainA) {
    return json(400, { error: "Main answer is required." });
  }

  // JSON schema that the model MUST follow
  const schema = {
    name: "mmi_feedback_schema",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        station: {
          type: "object",
          additionalProperties: false,
          properties: {
            stationId: { type: "string" },
            title: { type: "string" },
            tag: { type: "string" },
            studentName: { type: "string" },
          },
          required: ["stationId", "title", "tag", "studentName"],
        },
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
            main: {
              type: "object",
              additionalProperties: false,
              properties: {
                strengths: { type: "array", items: { type: "string" } },
                improvements: { type: "array", items: { type: "string" } },
                redFlags: { type: "array", items: { type: "string" } },
              },
              required: ["strengths", "improvements", "redFlags"],
            },
            f1: {
              type: "object",
              additionalProperties: false,
              properties: {
                strengths: { type: "array", items: { type: "string" } },
                improvements: { type: "array", items: { type: "string" } },
                redFlags: { type: "array", items: { type: "string" } },
              },
              required: ["strengths", "improvements", "redFlags"],
            },
            f2: {
              type: "object",
              additionalProperties: false,
              properties: {
                strengths: { type: "array", items: { type: "string" } },
                improvements: { type: "array", items: { type: "string" } },
                redFlags: { type: "array", items: { type: "string" } },
              },
              required: ["strengths", "improvements", "redFlags"],
            },
            f3: {
              type: "object",
              additionalProperties: false,
              properties: {
                strengths: { type: "array", items: { type: "string" } },
                improvements: { type: "array", items: { type: "string" } },
                redFlags: { type: "array", items: { type: "string" } },
              },
              required: ["strengths", "improvements", "redFlags"],
            },
          },
          required: ["main", "f1", "f2", "f3"],
        },
        models: {
          type: "object",
          additionalProperties: false,
          properties: {
            main_bullets: { type: "array", items: { type: "string" } },
            main_full: { type: "string" },
            f1_bullets: { type: "array", items: { type: "string" } },
            f1_full: { type: "string" },
            f2_bullets: { type: "array", items: { type: "string" } },
            f2_full: { type: "string" },
            f3_bullets: { type: "array", items: { type: "string" } },
            f3_full: { type: "string" },
          },
          required: [
            "main_bullets",
            "main_full",
            "f1_bullets",
            "f1_full",
            "f2_bullets",
            "f2_full",
            "f3_bullets",
            "f3_full",
          ],
        },
      },
      required: ["station", "scores", "feedback", "models"],
    },
  };

  const stationLabel = stationTitle || stationId || "Station";

  const developerMsg =
    `You are an expert UK medical school MMI examiner. ` +
    `Mark the candidate's answers and produce actionable feedback. ` +
    `Be realistic, not overly nice. Use UK framing (GMC, capacity, consent, safeguarding where relevant). ` +
    `Return ONLY JSON that matches the provided schema.`;

  const userMsg =
    `Station: ${stationLabel}\n` +
    `Tag: ${stationTag || "MMI"}\n` +
    `Student: ${studentName || "Student"}\n\n` +
    `MAIN QUESTION: ${mainQ || "(not provided)"}\n` +
    `MAIN ANSWER: ${mainA}\n\n` +
    `FOLLOW-UP 1 QUESTION: ${f1Q || "(not provided)"}\n` +
    `FOLLOW-UP 1 ANSWER: ${f1A || "(no answer)"}\n\n` +
    `FOLLOW-UP 2 QUESTION: ${f2Q || "(not provided)"}\n` +
    `FOLLOW-UP 2 ANSWER: ${f2A || "(no answer)"}\n\n` +
    `FOLLOW-UP 3 QUESTION: ${f3Q || "(not provided)"}\n` +
    `FOLLOW-UP 3 ANSWER: ${f3A || "(no answer)"}\n\n` +
    `Scoring: give 0-10 for overall, communication, empathy, ethics, insight.\n` +
    `Feedback: strengths/improvements/redFlags per question.\n` +
    `Models: give high-yield bullet points + a full spoken-style model answer per question.`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.4,
        max_tokens: 1200,
        response_format: {
          type: "json_schema",
          json_schema: schema,
        },
        messages: [
          { role: "developer", content: developerMsg },
          { role: "user", content: userMsg },
        ],
      }),
    });

    const raw = await resp.text();

    if (!resp.ok) {
      // Return raw to help you debug quickly
      return json(resp.status, {
        error: "OpenAI request failed",
        status: resp.status,
        raw,
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return json(500, { error: "OpenAI returned non-JSON unexpectedly", raw });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return json(500, { error: "No content returned from model.", raw });
    }

    // content should already be JSON due to json_schema
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return json(500, { error: "Model content was not valid JSON.", content });
    }

    // Ensure station info populated
    parsed.station = {
      stationId: stationId || "unknown",
      title: stationTitle || stationLabel,
      tag: stationTag || "MMI",
      studentName: studentName || "Student",
    };

    return json(200, parsed);
  } catch (err) {
    return json(500, {
      error: "Server error in mark.js",
      message: err?.message || String(err),
    });
  }
};
