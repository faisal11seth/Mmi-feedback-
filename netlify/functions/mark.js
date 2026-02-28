// netlify/functions/mark.js

export async function handler(event) {
  // Only allow POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed. Use POST." })
    };
  }

  // Parse body safely
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON body." })
    };
  }

  const name = body.name || "";
  const description = body.description || "";
  const q1 = body.q1 || "";
  const q2 = body.q2 || "";
  const q3 = body.q3 || "";
  const answer = body.answer || "";

  if (!answer.trim()) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing candidate answer." })
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "OPENAI_API_KEY is not set on Netlify." })
    };
  }

  const prompt = `
You are a UK medical school MMI examiner marking an ETHICS station.

Station timings:
- 2 min reading, 6 min response, 2 min follow-ups.

Station description:
${description}

Main question:
${q1}

Follow-up Q2:
${q2}

Follow-up Q3:
${q3}

Mark the candidate's answer.

Scoring (0–2 each):
- empathy
- communication
- ethics
- insight

overall must be /10:
1) add the 4 domain scores (max 8)
2) scale to /10: overall = round((sum/8)*10)

Return ONLY valid JSON in exactly this shape (no extra keys, no markdown):
{
  "empathy": number,
  "communication": number,
  "ethics": number,
  "insight": number,
  "overall": number,
  "comments": "string",
  "model_main": "string"
}

Candidate name:
${name}

Candidate answer:
${answer}
`;

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: prompt
      })
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "OpenAI API error",
          details: data
        })
      };
    }

    // Extract text output from Responses API
    const text =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "";

    if (!text) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "No text returned from model.",
          details: data
        })
      };
    }

    // Ensure we return JSON to the frontend (your index.html does JSON.parse)
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Model did not return valid JSON.",
          raw: text
        })
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Server error calling OpenAI.",
        details: String(err)
      })
    };
  }
}
