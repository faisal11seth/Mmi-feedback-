// netlify/functions/mark.js

exports.handler = async (event) => {
  // Helper: consistent JSON responses
  const j = (statusCode, obj) => ({
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });

  // Helper: trim very long user input to avoid timeouts/cost
  const clip = (s, max = 1200) => {
    const t = String(s || "").trim();
    if (!t) return "";
    if (t.length <= max) return t;
    return t.slice(0, max) + "…";
  };

  // Helper: build a compact but strict instruction
  const buildPrompt = ({ stationId, stationTitle, prompts, answers, name }) => {
    // Keep it compact: the main token driver is the user's text.
    // We clip each answer to keep the request safe.
    const aMain = clip(answers?.main, 1600);
    const aF1 = clip(answers?.f1, 900);
    const aF2 = clip(answers?.f2, 900);
    const aF3 = clip(answers?.f3, 900);

    return `
You are a strict UK medical school MMI examiner. Return ONLY valid JSON (no markdown, no extra keys).

Station: ${stationTitle || ""} (${stationId})

PROMPTS
Main: ${prompts?.main || ""}
F1: ${prompts?.f1 || ""}
F2: ${prompts?.f2 || ""}
F3: ${prompts?.f3 || ""}

Candidate: ${name || ""}

ANSWERS
Main: ${aMain}
F1: ${aF1}
F2: ${aF2}
F3: ${aF3}

Marking rules
- Score each domain 0–10. Overall should reflect the 4 domains.
- If content is unsafe/unprofessional/nonsense/too short (e.g., random letters), score 0–2 and explain clearly.
- Feedback must be specific and actionable (what to do next time).
- Model answers must be "rigid" and reusable: clear structure, UK context (GMC, capacity, consent, duty of candour etc when relevant).
- Model answers should be longer than a few lines, but keep each "full" answer to ~120–180 words.

Return JSON in EXACT shape:

{
  "scores": { "overall": 0, "communication": 0, "empathy": 0, "ethics": 0, "insight": 0 },
  "feedback": {
    "main": "string",
    "followups": { "f1": "string", "f2": "string", "f3": "string" }
  },
  "models": {
    "bullets": { "main": "string", "f1": "string", "f2": "string", "f3": "string" },
    "full": { "main": "string", "f1": "string", "f2": "string", "f3": "string" }
  }
}
`.trim();
  };

  try {
    if (event.httpMethod !== "POST") {
      return j(405, { error: "Method Not Allowed" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return j(500, { error: "Server misconfigured: OPENAI_API_KEY missing in Netlify env vars." });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return j(400, { error: "Invalid JSON body sent to function." });
    }

    const { stationId, stationTitle, prompts, answers, name } = body || {};

    if (!stationId) return j(400, { error: "stationId missing" });
    if (!prompts || !prompts.main) return j(400, { error: "prompts missing" });
    if (!answers || !String(answers.main || "").trim()) return j(400, { error: "Main answer is required." });

    const input = buildPrompt({ stationId, stationTitle, prompts, answers, name });

    // Abort safety: Netlify can be tight; keep this lower than your function timeout.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 24000); // 24s

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        // ✅ IMPORTANT: Responses API "input" in chat form (fixes the 400s)
        input: [{ role: "user", content: input }],
        // ✅ Correct way to force JSON output in Responses API
        text: { format: { type: "json_object" } },
        // Small extras to reduce rambling + speed up
        temperature: 0.4,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const raw = await resp.text();

    if (!resp.ok) {
      // Surface the useful part of OpenAI error
      return j(resp.status, {
        error: `OpenAI request failed (${resp.status})`,
        details: raw.slice(0, 1200),
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return j(500, { error: "OpenAI returned non-JSON response envelope.", details: raw.slice(0, 1200) });
    }

    // Extract model text
    const outText =
      data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ||
      "";

    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch {
      return j(500, {
        error: "Model did not return valid JSON content.",
        details: outText.slice(0, 1200),
      });
    }

    // Hard guard: ensure expected keys exist (prevents station.html breaking)
    if (!parsed?.scores || !parsed?.feedback || !parsed?.models) {
      return j(500, {
        error: "Unexpected response shape from model.",
        details: JSON.stringify(parsed).slice(0, 1200),
      });
    }

    return j(200, parsed);
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Request timed out (server abort). Try shorter answers or reduce output."
        : (err?.message || "Unknown server error");

    return j(500, { error: msg });
  }
};
