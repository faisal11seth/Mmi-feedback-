export async function handler(event) {
  // Basic CORS (helps if you ever call from elsewhere)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, { error: "Missing OPENAI_API_KEY in Netlify environment variables." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const name = (body.name || "").trim();
  const prompts = body.prompts || {};
  const answers = body.answers || {};

  const promptMain = (prompts.main || "").trim();
  const promptFU1  = (prompts.fu1 || "").trim();
  const promptFU2  = (prompts.fu2 || "").trim();
  const promptFU3  = (prompts.fu3 || "").trim();

  const ansMain = (answers.main || "").trim();
  const ansFU1  = (answers.fu1 || "").trim();
  const ansFU2  = (answers.fu2 || "").trim();
  const ansFU3  = (answers.fu3 || "").trim();

  if (!promptMain || !promptFU1 || !promptFU2 || !promptFU3) {
    return json(400, { error: "Missing one or more station prompts." });
  }
  if (!ansMain) {
    return json(400, { error: "Main answer is empty. Please answer the main question." });
  }

  // Rigid word counts (so model answers are consistent)
  // Main: ~180–220 words, each follow-up: ~60–90 words.
  const system = `
You are a UK medical school MMI examiner marking an ethics station.
You MUST return ONLY valid JSON that matches the provided schema.
Do not include any extra keys.
Be consistent and structured.
  `.trim();

  const user = `
Station timings: Reading 2 minutes, Response 6 minutes, Follow-ups 2 minutes.

Candidate name: ${name || "Candidate"}

Station questions:
MAIN: ${promptMain}
FU1: ${promptFU1}
FU2: ${promptFU2}
FU3: ${promptFU3}

Candidate answers (mark each separately):
MAIN ANSWER:
${ansMain}

FU1 ANSWER:
${ansFU1 || "(no answer provided)"}

FU2 ANSWER:
${ansFU2 || "(no answer provided)"}

FU3 ANSWER:
${ansFU3 || "(no answer provided)"}

Marking requirements:
1) Give domain scores out of 10: empathy, communication, ethics, insight (integers 0–10).
2) Give an overall score out of 10 (integer 0–10).
3) Provide feedback separately for each question (main, fu1, fu2, fu3). Each feedback section should be:
   - 2–4 bullet points: what was done well
   - 2–4 bullet points: improvements (very practical)
   If a follow-up answer is missing, say so and give what they should have covered.
4) Provide rigid model answers (consistent style) for each question:
   - MAIN model answer: 180–220 words
   - Each follow-up model answer: 60–90 words
   Use UK framing: capacity assessment, autonomy, best interests, escalation, documentation, MDT, and alternatives.
   Avoid quoting laws verbatim; keep it MMI-suitable and safe.

Return only JSON, nothing else.
  `.trim();

  // JSON schema enforced output (stops “invalid model JSON”)
  const schema = {
    name: "mmi_ethics_feedback",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["domain_scores", "overall", "feedback", "model_answers"],
      properties: {
        domain_scores: {
          type: "object",
          additionalProperties: false,
          required: ["empathy", "communication", "ethics", "insight"],
          properties: {
            empathy: { type: "integer", minimum: 0, maximum: 10 },
            communication: { type: "integer", minimum: 0, maximum: 10 },
            ethics: { type: "integer", minimum: 0, maximum: 10 },
            insight: { type: "integer", minimum: 0, maximum: 10 },
          },
        },
        overall: { type: "integer", minimum: 0, maximum: 10 },
        feedback: {
          type: "object",
          additionalProperties: false,
          required: ["main", "fu1", "fu2", "fu3"],
          properties: {
            main: { type: "string" },
            fu1: { type: "string" },
            fu2: { type: "string" },
            fu3: { type: "string" },
          },
        },
        model_answers: {
          type: "object",
          additionalProperties: false,
          required: ["main", "fu1", "fu2", "fu3"],
          properties: {
            main: { type: "string" },
            fu1: { type: "string" },
            fu2: { type: "string" },
            fu3: { type: "string" },
          },
        },
      },
    },
  };

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        temperature: 0,
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: schema },
        max_output_tokens: 1200,
      }),
    });

    const raw = await res.json();

    if (!res.ok) {
      return json(res.status, {
        error: "OpenAI API request failed.",
        details: raw,
      });
    }

    // The Responses API returns a structured output array.
    // With json_schema, the message content is guaranteed JSON.
    const outText = extractOutputText(raw);
    if (!outText) {
      return json(500, { error: "No text returned from model.", details: raw });
    }

    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch {
      return json(500, { error: "Model returned non-JSON.", details: raw, raw_text: outText });
    }

    return json(200, parsed);
  } catch (err) {
    return json(500, { error: "Server error in function.", details: String(err) });
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

// Try to robustly extract the assistant text from Responses API output
function extractOutputText(data) {
  try {
    // Common shape:
    // data.output = [{ type:"message", content:[{ type:"output_text", text:"{...json...}" }]}]
    const output = data?.output || [];
    for (const item of output) {
      if (item?.type === "message") {
        const content = item?.content || [];
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string") return c.text;
          if (typeof c?.text === "string") return c.text;
        }
      }
    }
    // Fallbacks
    if (typeof data?.output_text === "string") return data.output_text;
    if (typeof data?.text === "string") return data.text;
    return null;
  } catch {
    return null;
  }
}
