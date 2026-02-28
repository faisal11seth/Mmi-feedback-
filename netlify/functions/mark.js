export async function handler(event) {
  // CORS / preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Missing OPENAI_API_KEY in Netlify environment variables." })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Invalid JSON body." })
    };
  }

  const payload = {
    name: (body.name || "").trim(),
    station_description: (body.station_description || "").trim(),
    main_question: (body.main_question || "").trim(),
    followup1_question: (body.followup1_question || "").trim(),
    followup2_question: (body.followup2_question || "").trim(),
    followup3_question: (body.followup3_question || "").trim(),
    main_answer: (body.main_answer || "").trim(),
    followup1_answer: (body.followup1_answer || "").trim(),
    followup2_answer: (body.followup2_answer || "").trim(),
    followup3_answer: (body.followup3_answer || "").trim()
  };

  // basic validation
  if (!payload.main_answer) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Main answer is empty. Please fill the main answer box." })
    };
  }

  const prompt = buildPrompt(payload);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: prompt,
        // ✅ IMPORTANT: fixes your earlier error
        // Old response_format is deprecated; use text.format instead.
        text: {
          format: {
            type: "json_schema",
            name: "mmi_ethics_marking",
            schema: responseSchema(),
            strict: true
          }
        },
        // keep it concise + deterministic-ish
        temperature: 0.2
      })
    });

    const raw = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: "OpenAI API request failed.",
          details: raw
        })
      };
    }

    const text = extractOutputText(raw);

    if (!text) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: "No text returned from model.",
          details: raw
        })
      };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: "Model returned non-JSON (unexpected).",
          raw_text: text
        })
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify(data)
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: "Server error while calling OpenAI.",
        details: String(err)
      })
    };
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function buildPrompt(p) {
  // Rigid word targets so model answers stay consistent.
  return `
You are a UK medical school MMI examiner marking an ETHICS station.

You must:
1) Give DOMAIN SCORES out of 10 for: empathy, communication, ethics, insight, and an overall score out of 10.
2) Give FEEDBACK for EACH question separately (main + 3 follow-ups).
3) Provide RIGID MODEL ANSWERS for each question:
   - model_bullets: 5–8 bullet points (short, examiner-style)
   - model_full: a structured spoken-style answer (no bullets)
Word targets for model_full:
- Main: 140–170 words
- Each follow-up: 80–110 words

Station description:
${p.station_description}

Questions (fixed):
MAIN: ${p.main_question}
FOLLOW-UP 1: ${p.followup1_question}
FOLLOW-UP 2: ${p.followup2_question}
FOLLOW-UP 3: ${p.followup3_question}

Candidate answers:
MAIN ANSWER:
${p.main_answer}

FOLLOW-UP 1 ANSWER:
${p.followup1_answer}

FOLLOW-UP 2 ANSWER:
${p.followup2_answer}

FOLLOW-UP 3 ANSWER:
${p.followup3_answer}

Mark like a real MMI examiner:
- Reward: empathy, respecting beliefs, capacity assessment, clear explanation of risks/benefits, autonomy, legal/ethical reasoning, escalation/seniors, documentation, MDT involvement, alternatives, safety-netting.
- Penalise: coercion, judgemental tone, ignoring capacity, ignoring refusal, unsafe/illegal actions, lack of structure.

Return ONLY valid JSON matching the schema.`;
}

function responseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      scores: {
        type: "object",
        additionalProperties: false,
        properties: {
          empathy: { type: "number" },
          communication: { type: "number" },
          ethics: { type: "number" },
          insight: { type: "number" },
          overall: { type: "number" }
        },
        required: ["empathy", "communication", "ethics", "insight", "overall"]
      },
      main: qaSchema(),
      followup1: qaSchema(),
      followup2: qaSchema(),
      followup3: qaSchema()
    },
    required: ["scores", "main", "followup1", "followup2", "followup3"]
  };
}

function qaSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      feedback: { type: "string" },
      model_bullets: {
        type: "array",
        items: { type: "string" },
        minItems: 5,
        maxItems: 10
      },
      model_full: { type: "string" }
    },
    required: ["feedback", "model_bullets", "model_full"]
  };
}

// Extracts the model's output_text from Responses API payloads
function extractOutputText(raw) {
  try {
    // Newer responses commonly contain output[] with message items
    if (Array.isArray(raw.output)) {
      for (const item of raw.output) {
        if (item && item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (!c) continue;
            // Typical: {type:"output_text", text:"..."}
            if (c.type === "output_text" && typeof c.text === "string") return c.text;
            // Sometimes: {type:"text", text:"..."}
            if (c.type === "text" && typeof c.text === "string") return c.text;
          }
        }
      }
    }
    // Fallback if platform returns output_text directly
    if (typeof raw.output_text === "string") return raw.output_text;
    return "";
  } catch {
    return "";
  }
}
