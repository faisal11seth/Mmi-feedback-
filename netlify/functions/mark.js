export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = safeJson(event.body);
    if (!body) return json(400, { error: "Invalid JSON body" });

    const { stationId, stationTitle, prompts, answers, name } = body;

    if (!stationId) return json(400, { error: "Unknown stationId" });
    if (!answers || !answers.main || !String(answers.main).trim()) {
      return json(400, { error: "Main answer is required." });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json(500, { error: "Missing OPENAI_API_KEY in Netlify env vars." });

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    // Build a compact, deterministic instruction to force JSON output
    const system = `
You are an expert UK medical school MMI interviewer.
Return ONLY valid JSON (no markdown, no extra text) matching this schema:

{
  "scores": { "overall": 0-10, "communication": 0-10, "empathy": 0-10, "ethics": 0-10, "insight": 0-10 },
  "feedback": { "main": "string", "followups": "string" },
  "models": { "bullets": "string", "full": "string" }
}

Scoring: be fair, specific, UK MMI style. Mention MCA/capacity/confidentiality/Duty of Candour where relevant.
Feedback: concise but actionable.
Models: high-yield station answer. Bullets + then a polished full answer.
`.trim();

    const user = `
STATION ID: ${stationId}
STATION TITLE: ${stationTitle || ""}

PROMPTS:
Main: ${prompts?.main || ""}
Follow-up 1: ${prompts?.f1 || ""}
Follow-up 2: ${prompts?.f2 || ""}
Follow-up 3: ${prompts?.f3 || ""}

STUDENT NAME (optional): ${name || ""}

STUDENT ANSWERS:
Main: ${answers.main || ""}
Follow-up 1: ${answers.f1 || ""}
Follow-up 2: ${answers.f2 || ""}
Follow-up 3: ${answers.f3 || ""}

Now produce the JSON response ONLY.
`.trim();

    // OpenAI call (Chat Completions) — stable for simple Netlify setups
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 900,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    const raw = await resp.text();
    const data = safeJson(raw);

    if (!resp.ok) {
      const msg = data?.error?.message || raw?.slice(0, 400) || "OpenAI request failed";
      return json(resp.status, { error: msg });
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) return json(500, { error: "No model output returned." });

    const out = safeJson(content);
    if (!out) {
      // If the model slips (rare), surface it clearly as JSON error (not HTML)
      return json(500, { error: "Invalid model JSON", raw: content.slice(0, 1200) });
    }

    // Minimal validation / defaults
    out.scores = out.scores || {};
    out.feedback = out.feedback || {};
    out.models = out.models || {};

    return json(200, out);

  } catch (e) {
    return json(500, { error: e?.message || "Server error" });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(obj)
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
