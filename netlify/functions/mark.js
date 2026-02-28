export async function handler(event) {
  const body = JSON.parse(event.body || "{}");
  const name = body.name || "";
  const answer = body.answer || "";

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: "You are a UK medical school MMI examiner. Always return valid JSON only."
        },
        {
          role: "user",
          content: `Mark this candidate answer for an ethics station.

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
${answer}`
        }
      ],
      response_format: { type: "json_object" }
    })
  });

  const data = await res.json();

  const parsed = JSON.parse(data.output[0].content[0].text);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed)
  };
}
