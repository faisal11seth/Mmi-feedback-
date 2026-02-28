// netlify/functions/mark.js

export async function handler(event) {
  // Only allow POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed. Use POST." }),
    };
  }

  // Check key
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Missing OPENAI_API_KEY in Netlify environment variables.",
      }),
    };
  }

  // Parse body safely
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON body." }),
    };
  }

  // Pull fields (works even if some are missing)
  const name = (body.name || "").trim();

  // Station brief + timings
  const stationDescription = (body.station_description || body.stationDescription || "").trim();
  const readingTime = (body.reading_time || body.readingTime || "2 minutes").trim();
  const responseTime = (body.response_time || body.responseTime || "6 minutes").trim();
  const followupTime = (body.followup_time || body.followupTime || "2 minutes").trim();

  // Questions
  const mainQuestion = (body.main_question || body.mainQuestion || "").trim();
  const followup2 = (body.followup2 || body.follow_up_2 || body.followup_question_2 || "").trim();
  const followup3 = (body.followup3 || body.follow_up_3 || body.followup_question_3 || "").trim();

  // Candidate answer text (support your old field name too)
  const candidateAnswer = (body.answer || body.candidate_answer || body.candidateAnswer || "").trim();

  if (!candidateAnswer) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing candidate answer text." }),
    };
  }

  // Build prompt
  const prompt = `
You are a UK medical school MMI examiner marking an ETHICS station.

Use UK framing (capacity, consent, autonomy, best interests, safeguarding, confidentiality, escalation, documentation, GMC-style professionalism).
Be constructive and specific.

STATION INFO
- Reading time: ${readingTime}
- Response time: ${responseTime}
- Follow-ups time: ${followupTime}

Station description (what is being assessed):
${stationDescription || "(not provided)"}

Main ethics question / scenario prompt:
${mainQuestion || "(not provided)"}

Follow-up question 2:
${followup2 || "(not provided)"}

Follow-up question 3:
${followup3 || "(not provided)"}

CANDIDATE
Name: ${name || "(not provided)"}

Candidate answer:
${candidateAnswer}

Return ONLY JSON matching the required schema.
`;

  // JSON schema to FORCE valid JSON output
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      empathy: { type: "integer", minimum: 0, maximum: 2 },
      communication: { type: "integer", minimum: 0, maximum: 2 },
      ethics: { type: "integer", minimum: 0, maximum: 2 },
      insight: { type: "integer", minimum: 0, maximum: 2 },
      overall: { type: "integer", minimum: 0, maximum: 10 },
      strengths: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
      improvements: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 8 },
      comments: { type: "string" },
      model_main: { type: "string" },
    },
    required: [
      "empathy",
      "communication",
      "ethics",
      "insight",
      "overall",
      "strengths",
      "improvements",
      "comments",
      "model_main",
    ],
  };

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          {
            role: "system",
            content: "You are a careful examiner. Return only valid JSON that matches the provided schema.",
          },
          { role: "user", content: prompt },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "mmi_ethics_feedback",
            strict: true,
            schema,
          },
        },
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "OpenAI API error",
          details: data,
        }),
      };
    }

    // IMPORTANT:
    // Responses output may include multiple items (reasoning/tool/etc).
    // We must extract the "output_text" message safely.
    let outText = "";

    // Some SDKs provide `output_text`, but raw JSON may not.
    // So we scan the output array and aggregate any output_text blocks.
    if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item && item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c && (c.type === "output_text" || c.type === "text") && typeof c.text === "string") {
              outText += c.text;
            }
          }
        }
      }
    }

    // Fallback: if OpenAI returns a top-level output_text (sometimes happens)
    if (!outText && typeof data.output_text === "string") outText = data.output_text;

    if (!outText) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "No text returned from model.",
          details: data,
        }),
      };
    }

    // Parse the JSON text into an object
    let resultObj;
    try {
      resultObj = JSON.parse(outText);
    } catch (e) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Model returned non-JSON output (unexpected).",
          raw: outText,
          details: data,
        }),
      };
    }

    // Return JSON to frontend
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // Helpful if your browser ever complains:
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(resultObj),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Server error calling OpenAI.",
        message: String(err?.message || err),
      }),
    };
  }
}
