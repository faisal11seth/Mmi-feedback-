export async function handler(event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (!process.env.OPENAI_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const student_name = body.student_name || "";
  const station_description = body.station_description || "";
  const timings = body.timings || { reading_minutes: 2, response_minutes: 6, followups_minutes: 2 };

  const main = body.main || { prompt: "", answer: "" };
  const followup2 = body.followup2 || { prompt: "", answer: "" };
  const followup3 = body.followup3 || { prompt: "", answer: "" };

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      student_name: { type: "string" },
      main: { $ref: "#/$defs/qblock" },
      followup2: { anyOf: [{ $ref: "#/$defs/qblock" }, { type: "null" }] },
      followup3: { anyOf: [{ $ref: "#/$defs/qblock" }, { type: "null" }] }
    },
    required: ["student_name", "main", "followup2", "followup3"],
    $defs: {
      qblock: {
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
          feedback: { type: "string" },
          model_answer: { type: "string" }
        },
        required: ["scores", "feedback", "model_answer"]
      }
    }
  };

  const prompt = `
You are a UK medical school MMI examiner.

You must mark THREE separate answers:
1) Main ethics question
2) Follow-up question 2
3) Follow-up question 3

Station description:
${station_description}

Timing:
- Reading: ${timings.reading_minutes} minutes
- Main response: ${timings.response_minutes} minutes
- Follow-ups: ${timings.followups_minutes} minutes

Marking rubric (0–10 in each domain):
- empathy: warmth, patient-centred tone, acknowledges feelings/concerns, avoids judgement
- communication: structure, clarity, signposting, professional language, checks understanding, summarises
- ethics: correct principles, balances autonomy/beneficence/non-maleficence/justice, capacity/consent, confidentiality/safeguarding/escalation where relevant
- insight: reflective thinking, uncertainty management, practical next steps, documentation and senior support
Overall is a holistic /10.

Important rules:
- Provide feedback SEPARATELY for each question (main, followup2, followup3).
- Provide a model answer SEPARATELY for each question.
- Model answers should be consistent and structured (intro → key principles → actions/plan → escalation/safety-net/documentation).
- If follow-up 2 prompt OR answer is blank, set followup2 to null.
- If follow-up 3 prompt OR answer is blank, set followup3 to null.
- Return ONLY JSON that matches the schema.

Candidate:
Name: ${student_name}

MAIN QUESTION PROMPT:
${main.prompt}

MAIN ANSWER:
${main.answer}

FOLLOW-UP 2 PROMPT:
${followup2.prompt}

FOLLOW-UP 2 ANSWER:
${followup2.answer}

FOLLOW-UP 3 PROMPT:
${followup3.prompt}

FOLLOW-UP 3 ANSWER:
${followup3.answer}
`;

  try {
    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: prompt,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "mmi_ethics_marking",
            strict: true,
            schema
          }
        }
      })
    });

    const aiData = await aiRes.json();

    const text =
      aiData?.output_text ||
      aiData?.output?.[0]?.content?.[0]?.text ||
      aiData?.choices?.[0]?.message?.content ||
      "";

    if (!text) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "No text returned from model", raw: aiData }) };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Invalid model JSON", raw: text }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server error", details: String(err) }) };
  }
}
