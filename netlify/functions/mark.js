export async function handler(event) {
  const body = JSON.parse(event.body || "{}");
  const name = body.name || "";
  const answer = body.answer || "";

  const prompt = `
You are a UK medical school MMI examiner.

Mark this candidate answer for an ethics station.

Score each domain 0–2:
- empathy
- communication
- ethics
- insight

Return JSON:
{
  "empathy": number,
  "communication": number,
  "ethics": number,
  "insight": number,
  "overall": number,
  "comments": "string",
  "model_main": "string"
}

Candidate answer:
${answer}
`;

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
  const text = data.output[0].content[0].text;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = {
      overall: 0,
      empathy: 0,
      communication: 0,
      ethics: 0,
      insight: 0,
      comments: "Model output parsing failed",
      model_main: text
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed)
  };
}
