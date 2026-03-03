// netlify/functions/mark.js

const ALLOWED_STATIONS = new Set([
  "blood_transfusion_refusal",
  "confidentiality_breach",
  "colleague_error",
  "dnar_conflict",
  "capacity_refusal",
  "breaking_bad_news",
  "team_conflict",
  "cultural_refusal",
  "consent_understanding",
  "relative_requests_information",
]);

function json(statusCode, obj) {
  return {
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
}

// Basic "is this real English sentence(s)?" check.
// This is intentionally simple: we just want to detect random letters / nonsense.
function looksLikeGibberish(text) {
  const t = (text || "").trim();
  if (!t) return true;

  // Too short to be meaningful
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return true;
  // Helper: build a compact but strict instruction
  const buildPrompt = ({ stationId, stationTitle, prompts, answers, name }) => {
    // Keep it compact: the main token driver is the user's text.
    // We clip each answer to keep the request safe.
    const aMain = clip(answers?.main, 1600);
    const aF1 = clip(answers?.f1, 900);
    const aF2 = clip(answers?.f2, 900);
    const aF3 = clip(answers?.f3, 900);

  // If it's mostly non-letters (e.g., "asdf123 !!!")
  const letters = (t.match(/[a-zA-Z]/g) || []).length;
  if (letters < Math.min(10, t.length * 0.35)) return true;
    return `
You are a strict UK medical school MMI examiner. Return ONLY valid JSON (no markdown, no extra keys).

  // If it has extremely low vowel ratio (common in keyboard spam)
  const vowels = (t.match(/[aeiouAEIOU]/g) || []).length;
  if (letters > 0 && vowels / letters < 0.18) return true;
Station: ${stationTitle || ""} (${stationId})

  return false;
}

function validateModelShape(parsed) {
  // Required shape:
  // {
  //  scores: {overall, communication, empathy, ethics, insight},
  //  feedback: { main, followups:{f1,f2,f3} },
  //  models: { bullets:{main,f1,f2,f3}, full:{main,f1,f2,f3} }
  // }
PROMPTS
Main: ${prompts?.main || ""}
F1: ${prompts?.f1 || ""}
F2: ${prompts?.f2 || ""}
F3: ${prompts?.f3 || ""}

  const okObj = (x) => x && typeof x === "object" && !Array.isArray(x);
Candidate: ${name || ""}

  if (!okObj(parsed)) return "Top-level output is not an object.";
ANSWERS
Main: ${aMain}
F1: ${aF1}
F2: ${aF2}
F3: ${aF3}

  if (!okObj(parsed.scores)) return "Missing scores object.";
  for (const k of ["overall", "communication", "empathy", "ethics", "insight"]) {
    if (!(k in parsed.scores)) return `Missing scores.${k}`;
  }
Marking rules
- Score each domain 0–10. Overall should reflect the 4 domains.
- If content is unsafe/unprofessional/nonsense/too short (e.g., random letters), score 0–2 and explain clearly.
- Feedback must be specific and actionable (what to do next time).
- Model answers must be "rigid" and reusable: clear structure, UK context (GMC, capacity, consent, duty of candour etc when relevant).
- Model answers should be longer than a few lines, but keep each "full" answer to ~120–180 words.

  if (!okObj(parsed.feedback)) return "Missing feedback object.";
  if (typeof parsed.feedback.main !== "string") return "feedback.main must be a string.";
  if (!okObj(parsed.feedback.followups)) return "feedback.followups missing.";
  for (const k of ["f1", "f2", "f3"]) {
    if (typeof parsed.feedback.followups[k] !== "string") return `feedback.followups.${k} must be a string.`;
  }
Return JSON in EXACT shape:

  if (!okObj(parsed.models)) return "Missing models object.";
  if (!okObj(parsed.models.bullets)) return "models.bullets missing.";
  if (!okObj(parsed.models.full)) return "models.full missing.";
  for (const group of ["bullets", "full"]) {
    for (const k of ["main", "f1", "f2", "f3"]) {
      if (typeof parsed.models[group][k] !== "string") return `models.${group}.${k} must be a string.`;
    }
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

  return null;
}
`.trim();
  };

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
      return j(405, { error: "Method Not Allowed" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json(500, {
        error: "Server misconfigured: OPENAI_API_KEY missing in Netlify env vars.",
      });
      return j(500, { error: "Server misconfigured: OPENAI_API_KEY missing in Netlify env vars." });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { error: "Invalid JSON in request body." });
    } catch {
      return j(400, { error: "Invalid JSON body sent to function." });
    }

    const { stationId, stationTitle, prompts, answers, name } = body || {};

    if (!stationId) return json(400, { error: "stationId missing" });
    if (!ALLOWED_STATIONS.has(stationId)) {
      return json(400, { error: `Invalid stationId: ${stationId}` });
    }
    if (!prompts || !prompts.main) return json(400, { error: "prompts missing" });

    const mainAns = String(answers?.main || "").trim();
    if (!mainAns) return json(400, { error: "Main answer is required." });
    if (!stationId) return j(400, { error: "stationId missing" });
    if (!prompts || !prompts.main) return j(400, { error: "prompts missing" });
    if (!answers || !String(answers.main || "").trim()) return j(400, { error: "Main answer is required." });

    // Optional: score low if gibberish, but still return a full structured response.
    // We'll tell the model to handle it, BUT this is a guard for obviously empty/garbage.
    const mainIsGib = looksLikeGibberish(mainAns);

    // --- PROMPT ---
    const input = `
You are a strict UK medical school MMI examiner.

Return ONLY valid JSON. No markdown. No commentary. No backticks.

Station ID: ${stationId}
Station Title: ${stationTitle || ""}

PROMPTS:
Main: ${prompts.main}
F1: ${prompts.f1 || ""}
F2: ${prompts.f2 || ""}
F3: ${prompts.f3 || ""}

STUDENT NAME (optional): ${name || ""}

ANSWERS:
Main: ${mainAns}
F1: ${String(answers?.f1 || "")}
F2: ${String(answers?.f2 || "")}
F3: ${String(answers?.f3 || "")}

Rules:
- If answers are nonsense/too short (e.g., random letters), score low (0–2/10) and explain why.
- Provide feedback separately for MAIN and each FOLLOW-UP.
- Provide model answers separately for MAIN and each FOLLOW-UP in BOTH bullets and full.
- Full model answers should be written as natural paragraphs (no "Opening:", "Explain:", "Safety-net:" labels inside the paragraph).

Return JSON in this exact shape:

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

${mainIsGib ? "IMPORTANT: The MAIN answer is gibberish/too short. Scores must be 0–2/10 and feedback must explicitly explain why." : ""}
`.trim();
    const input = buildPrompt({ stationId, stationTitle, prompts, answers, name });

    // Abort safety: Netlify can be tight; keep this lower than your function timeout.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const timeout = setTimeout(() => controller.abort(), 24000); // 24s

    // --- CALL OPENAI RESPONSES API ---
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // ✅ pinned model (use this)
        model: "gpt-4.1-mini-2024-07-18",
        input,
        // ✅ reduce timeouts / token explosions
        max_output_tokens: 1200,
        // ✅ correct replacement for old response_format
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
@@ -186,52 +119,50 @@ ${mainIsGib ? "IMPORTANT: The MAIN answer is gibberish/too short. Scores must be
    const raw = await resp.text();

    if (!resp.ok) {
      return json(resp.status, {
      // Surface the useful part of OpenAI error
      return j(resp.status, {
        error: `OpenAI request failed (${resp.status})`,
        details: raw.slice(0, 900),
        details: raw.slice(0, 1200),
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return json(500, {
        error: "OpenAI returned non-JSON envelope unexpectedly.",
        details: raw.slice(0, 900),
      });
    } catch {
      return j(500, { error: "OpenAI returned non-JSON response envelope.", details: raw.slice(0, 1200) });
    }

    // Extract the output_text safely
    // Extract model text
    const outText =
      data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text || "";
      data?.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ||
      "";

    let parsed;
    try {
      parsed = JSON.parse(outText);
    } catch (e) {
      return json(500, {
        error: "Model returned non-JSON output unexpectedly.",
        details: outText.slice(0, 900),
    } catch {
      return j(500, {
        error: "Model did not return valid JSON content.",
        details: outText.slice(0, 1200),
      });
    }

    const shapeErr = validateModelShape(parsed);
    if (shapeErr) {
      return json(500, {
        error: "Unexpected response shape from function.",
        details: shapeErr,
        sample: JSON.stringify(parsed).slice(0, 900),
    // Hard guard: ensure expected keys exist (prevents station.html breaking)
    if (!parsed?.scores || !parsed?.feedback || !parsed?.models) {
      return j(500, {
        error: "Unexpected response shape from model.",
        details: JSON.stringify(parsed).slice(0, 1200),
      });
    }

    return json(200, parsed);
    return j(200, parsed);
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Request timed out (server abort). Try again."
        ? "Request timed out (server abort). Try shorter answers or reduce output."
        : (err?.message || "Unknown server error");

    return json(500, { error: msg });
    return j(500, { error: msg });
  }
};
