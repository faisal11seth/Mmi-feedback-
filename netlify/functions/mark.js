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
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Missing OPENAI_API_KEY" })
    };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const {
    name = "",
    station_description = "",
    main_question = "",
    followup2 = "",
    followup3 = "",
    candidate_answer = ""
  } = body;

  if (!candidate_answer) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing candidate_answer" }) };
  }

  const prompt = `
You are a UK medical school MMI examiner marking an ethics station.

Station description:
${station_description}

Main question:
${main_question}

Follow-up 2:
${followup2}

Follow-up 3:
${followup3}

Candidate name: ${name}

Candidate answer:
${candidate_answer}

Return ONLY JSON:
{
  "empathy": number,
  "communication": number,
  "ethics": number,
  "insight": number,
  "overall": number,
  "strengths": ["string"],
  "improvements": ["string"],
  "comments": "string",
  "model_main": "string"
}
`;

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: prompt,
        response_format: { type: "json_object" }
      })
    });

    const data = await res.json();

    const text =
      data?.output_text ||
      data?.output?.[0]?.content?.[0]?.text ||
      "";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Invalid model JSON", raw: text }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(parsed)
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server error", details: String(err) })
    };
  }
}
