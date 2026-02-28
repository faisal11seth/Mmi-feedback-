// netlify/functions/mark.js

export async function handler(event) {
  // CORS (so browser can call the function)
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed. Use POST." }),
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing OPENAI_API_KEY in Netlify environment variables." }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON body." }),
    };
  }

  const name = (body.name || "").trim();

  // Candidate answers (separate, as requested)
  const aMain = (body.aMain || "").trim();
  const a1 = (body.a1 || "").trim();
  const a2 = (body.a2 || "").trim();
  const a3 = (body.a3 || "").trim();

  // Fixed station content (your exact questions)
  const STATION = {
    title: "MMI Ethics Station — Blood Transfusion Refusal",
    timings: { reading: "2 minutes", response: "6 minutes", followups: "2 minutes" },
    description:
      "Assesses autonomy vs beneficence/non-maleficence, capacity assessment, informed refusal, communication, escalation/senior support, documentation, MDT/family involvement, and ethically acceptable alternatives within UK practice.",
    qMain:
      "A patient refuses a life-saving blood transfusion for religious reasons. Discuss how you would approach this situation.",
    q1: "What would you do if the patient did not have capacity?",
    q2: "How would you involve the multidisciplinary team or family?",
    q3: "Can you suggest any ethically acceptable alternatives?",
  };

  // RIGID model answers (always the same) — bullets + full answer for each
  const MODEL = {
    main: {
      bullets: [
        "Confirm urgency + stabilise; seek senior help early.",
        "Assess capacity (understand/retain/weigh/communicate) and ensure no coercion.",
        "Explain risks/benefits/likely outcome without transfusion; check understanding.",
        "Explore reasons and what is acceptable (some products/procedures vary).",
        "If capacitous refusal persists: respect autonomy; document clearly; continue supportive care.",
        "Consider alternatives and involve haematology/anaesthetics; consider ethics/liaison support.",
        "Safety-net + ongoing review; DNAR not assumed; treat reversible issues.",
      ],
      full:
        "I would approach the patient calmly and respectfully, recognising the refusal may be grounded in deeply held beliefs. First, I would assess the urgency and ensure immediate stabilisation, involving a senior clinician early. I would then assess capacity by confirming the patient can understand, retain, weigh the information, and communicate a choice, and ensure the decision is voluntary without pressure.\n\nI would explain the clinical situation and the role of transfusion, including the likely risks of refusing it, using clear language and checking understanding. I would explore the patient’s reasons and clarify what treatments they may find acceptable, as beliefs can differ between individuals.\n\nIf the patient has capacity and continues to refuse, I would respect their autonomous decision even if this may result in serious harm or death. I would document the capacity assessment, information given, the patient’s decision and reasoning, and discussions with seniors. I would continue to provide compassionate supportive care, consider clinically appropriate alternatives, and maintain ongoing communication and review.",
    },
    fu1: {
      bullets: [
        "Confirm lack of capacity and address reversible causes.",
        "Check for valid/ applicable Advance Decision (ADRT) refusing blood.",
        "Best-interests decision: consider values/beliefs, prior wishes, least restrictive option.",
        "Involve seniors, legal/ethics support as needed; family informs values but doesn’t decide.",
        "Document reasoning and actions.",
      ],
      full:
        "If the patient lacked capacity, I would confirm this with a structured capacity assessment and address reversible causes such as hypoxia, pain, sepsis or delirium. I would check for any valid and applicable advance decision refusing blood (ADRT) or other documented wishes.\n\nIf there is no applicable ADRT, I would make a best-interests decision, considering the patient’s previously expressed values and beliefs and choosing the least restrictive option. I would involve senior clinicians and, where appropriate, seek legal/ethics advice. Family can help clarify the patient’s values but do not make the decision themselves. I would document the assessment, discussions and rationale clearly.",
    },
    fu2: {
      bullets: [
        "Involve seniors early (registrar/consultant) + nursing team.",
        "Specialists: haematology/anaesthetics/surgery as relevant for blood conservation plan.",
        "Consider chaplaincy/faith liaison if patient agrees.",
        "Family involvement only with consent (or best-interests when no capacity).",
        "Clear roles, communication, documentation.",
      ],
      full:
        "I would involve the multidisciplinary team early to ensure safe and coordinated care: senior clinicians for oversight, nursing staff for monitoring and communication, and relevant specialists such as haematology and anaesthetics to develop a blood-conservation plan and explore alternatives.\n\nIf the patient consents, I would involve family to support the patient and help ensure understanding; if the patient lacks capacity, family input can inform the patient’s values for best-interests decisions. If appropriate and with the patient’s agreement, I would consider chaplaincy or faith liaison to support shared understanding. I would keep communication clear, ensure confidentiality, and document decisions and agreed plans.",
    },
    fu3: {
      bullets: [
        "Optimise haemoglobin / treat cause: iron, B12/folate, EPO where appropriate.",
        "Minimise blood loss: meticulous haemostasis, cell salvage (if acceptable), paediatric tubes.",
        "Haemostatic agents/techniques where indicated (e.g., TXA) — specialist input.",
        "Non-blood volume support + oxygenation + permissive strategies if safe.",
        "Be transparent: alternatives may reduce risk but not fully replace transfusion.",
      ],
      full:
        "I would explore ethically acceptable alternatives that align with the patient’s beliefs while remaining clinically appropriate. This may include optimising haemoglobin by treating reversible causes and using iron or other therapies where indicated, and minimising blood loss through careful haemostasis, limiting phlebotomy, and specialist blood-conservation strategies such as cell salvage if acceptable to the patient.\n\nDepending on the scenario, specialist teams may consider haemostatic measures and supportive strategies to improve oxygen delivery. I would be transparent that alternatives may reduce risk but may not fully replace transfusion, and I would support the patient to make an informed decision consistent with their values.",
    },
  };

  // Validate required fields
  if (!aMain || !a1 || !a2 || !a3) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Please fill in ALL four answer boxes (Main + Follow-up 1/2/3) before generating feedback.",
      }),
    };
  }

  // OpenAI prompt: generate ONLY scores + feedback, NOT model answers (model answers are hard-coded above)
  const prompt = `
You are a UK medical school MMI examiner.

Station:
Title: ${STATION.title}
Timings: Reading ${STATION.timings.reading}, Response ${STATION.timings.response}, Follow-ups ${STATION.timings.followups}
Description: ${STATION.description}

Questions:
MAIN: ${STATION.qMain}
FU1: ${STATION.q1}
FU2: ${STATION.q2}
FU3: ${STATION.q3}

Candidate (${name || "Candidate"}) answers:
MAIN ANSWER:
${aMain}

FU1 ANSWER:
${a1}

FU2 ANSWER:
${a2}

FU3 ANSWER:
${a3}

Mark using FOUR domains scored 0–10 each:
- empathy
- communication
- ethics
- insight

Give:
1) domain scores (0–10 each)
2) overall (0–10): average rounded to nearest whole number
3) feedback for each question separately (MAIN, FU1, FU2, FU3). Keep each section concise and actionable.

Return STRICT JSON only (no markdown, no extra text) in this exact schema:
{
  "empathy": number,
  "communication": number,
  "ethics": number,
  "insight": number,
  "overall": number,
  "feedback_main": "string",
  "feedback_fu1": "string",
  "feedback_fu2": "string",
  "feedback_fu3": "string"
}
`;

  let apiJson;
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: prompt,
        // IMPORTANT: do NOT send temperature / response_format / etc (your error came from unsupported params)
      }),
    });

    apiJson = await res.json();

    if (!res.ok) {
      return {
        statusCode: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "OpenAI API request failed.", details: apiJson }),
      };
    }
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "OpenAI API request failed (network/runtime).", details: String(e) }),
    };
  }

  // Extract text robustly across Responses API shapes
  const text =
    apiJson.output_text ||
    (apiJson.output &&
      apiJson.output
        .flatMap((o) => (o.content ? o.content : []))
        .map((c) => c.text)
        .filter(Boolean)
        .join("\n")) ||
    "";

  if (!text.trim()) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "No text returned from model.", details: apiJson }),
    };
  }

  let marking;
  try {
    marking = JSON.parse(text);
  } catch {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid model JSON", raw: text }),
    };
  }

  // Final response includes rigid model answers (bullets + full) for each question
  const finalPayload = {
    station: STATION,
    ...marking,
    model_main_bullets: MODEL.main.bullets,
    model_main_full: MODEL.main.full,
    model_fu1_bullets: MODEL.fu1.bullets,
    model_fu1_full: MODEL.fu1.full,
    model_fu2_bullets: MODEL.fu2.bullets,
    model_fu2_full: MODEL.fu2.full,
    model_fu3_bullets: MODEL.fu3.bullets,
    model_fu3_full: MODEL.fu3.full,
  };

  return {
    statusCode: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(finalPayload),
  };
}
