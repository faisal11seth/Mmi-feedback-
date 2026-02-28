export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(500, { error: "Missing OPENAI_API_KEY" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const stationId = body.stationId;
  const answers = body.answers || {};
  const station = STATIONS[stationId];

  if (!station) {
    return json(400, { error: "Unknown stationId" });
  }

  // Minimal validation: require main answer
  if (!String(answers.main || "").trim()) {
    return json(400, { error: "Please enter an answer for the Main question." });
  }

  const prompt = buildPrompt(station, answers);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: prompt
      })
    });

    const data = await res.json();
    const text = extractText(data);

    const parsed = safeJson(text);
    if (!parsed || !parsed.scores || !parsed.feedback) {
      return json(500, { error: "Invalid model JSON", raw: text, details: data });
    }

    // Return AI marking + rigid models
    return json(200, {
      scores: parsed.scores,
      feedback: parsed.feedback,
      models: station.models
    });
  } catch (e) {
    return json(500, { error: "Server error", detail: String(e) });
  }
}

function buildPrompt(station, answers) {
  return `
You are a UK medical school MMI examiner.

Station:
${station.title}

Mark the candidate across 4 domains (0–10 each):
- empathy
- communication
- ethics
- insight
Also give overall 0–10 (holistic, not a simple average).

Provide feedback separately for each question:
- main
- f1
- f2
- f3

Feedback style:
- 2–4 sentences per question.
- Include 1–2 strengths + 1–2 improvements.
- UK-appropriate: capacity/MCA where relevant, consent, confidentiality, escalation, documentation, MDT, duty of candour, safety-netting.
- If an answer is blank: "No answer provided — expected a structured approach covering …"

Return STRICT JSON ONLY (no markdown, no backticks, no extra text) in this exact shape:

{
  "scores": {
    "empathy": number,
    "communication": number,
    "ethics": number,
    "insight": number,
    "overall": number
  },
  "feedback": {
    "main": "text",
    "f1": "text",
    "f2": "text",
    "f3": "text"
  }
}

Main question:
${station.prompts.main}
Candidate answer (main):
${answers.main || ""}

Follow-up 1:
${station.prompts.f1}
Candidate answer (f1):
${answers.f1 || ""}

Follow-up 2:
${station.prompts.f2}
Candidate answer (f2):
${answers.f2 || ""}

Follow-up 3:
${station.prompts.f3}
Candidate answer (f3):
${answers.f3 || ""}
`.trim();
}

// Robust extraction for Responses API
function extractText(r) {
  try {
    for (const o of r.output || []) {
      if (o.type === "message" && Array.isArray(o.content)) {
        for (const c of o.content) {
          if (typeof c.text === "string" && c.text.trim()) return c.text;
          if (c.type === "output_text" && typeof c.text === "string" && c.text.trim()) return c.text;
          if (c.type === "text" && typeof c.text === "string" && c.text.trim()) return c.text;
        }
      }
    }
    if (typeof r.output_text === "string" && r.output_text.trim()) return r.output_text;
  } catch {}
  return "";
}

function safeJson(text) {
  try { return JSON.parse(text); } catch {}
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try { return JSON.parse(text.slice(s, e + 1)); } catch {}
  }
  return null;
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(code, obj) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json", ...cors() },
    body: JSON.stringify(obj)
  };
}

/* ============================================================
   STATIONS + RIGID MODEL ANSWERS (bullets + long-form)
   IDs MUST match index.html station IDs.
   ============================================================ */

const STATIONS = {
  // 1) BLOOD TRANSFUSION REFUSAL
  blood_transfusion_refusal: {
    title: "Ethics: Refusal of life-saving blood transfusion (religious reasons)",
    prompts: {
      main: "A patient refuses a life-saving blood transfusion for religious reasons. Discuss how you would approach this situation.",
      f1: "What would you do if the patient did not have capacity?",
      f2: "How would you involve the multidisciplinary team or family?",
      f3: "Can you suggest any ethically acceptable alternatives?"
    },
    models: {
      main: {
        bullets:
`• Ensure immediate safety: assess urgency, stabilise, call senior early.
• Capacity first (MCA): understand/retain/weigh/communicate; check voluntariness and no coercion.
• Explain clearly: why transfusion is recommended, risks/benefits, likely outcomes of refusal; use teach-back.
• Explore beliefs respectfully: what products/procedures are acceptable (often individual-specific); offer chaplain/faith liaison if wanted.
• If capacitous refusal persists: respect autonomy even if life-threatening; continue supportive care; revisit if circumstances change.
• Escalate + document: capacity assessment, info given, decision, who was involved; plan + safety-netting.`,
        full:
`I would approach the patient calmly and respectfully, acknowledging that their decision may be based on deeply held beliefs. First, I would assess how time-critical the situation is and ensure the patient is stabilised, while involving a senior clinician early because this is potentially life-threatening and ethically complex.

Next, I would assess capacity in line with the Mental Capacity Act: confirming the patient can understand the relevant information, retain it, weigh it up and communicate a decision. I would also check that the decision is voluntary and not the result of coercion or misunderstanding. I would then explain the situation in clear, non-technical language: why a transfusion is recommended, the likely benefits, and the risks and consequences of refusing, and I would check understanding using teach-back.

I would explore the patient’s beliefs with sensitivity and ask what is or is not acceptable to them, because acceptability can vary between individuals and between different blood products or procedures. If the patient would like, I would offer support such as chaplaincy or a faith liaison, and I would ensure the discussion remains patient-centred rather than adversarial.

If the patient has capacity and continues to refuse, I must respect their autonomous decision even if it may lead to serious harm or death. I would not transfuse against their wishes, but I would continue compassionate supportive care, consider clinically appropriate alternatives, and keep communication open, particularly if the clinical situation changes.

Throughout, I would escalate appropriately (consultant/anaesthetics/haematology as relevant) and document clearly: the capacity assessment, information provided, the patient’s decision and rationale, any agreed alternatives, and the plan for ongoing review and safety-netting.`
      },
      f1: {
        bullets:
`• Confirm lack of capacity; treat reversible causes; reassess as appropriate.
• Check for valid/applicable ADRT refusing blood; check Health & Welfare LPA.
• If no ADRT: best-interests decision using MCA checklist; least restrictive option; involve seniors.
• If no family/friends: involve IMCA; if dispute/complexity and time allows, seek ethics/legal advice (court if needed).
• Document capacity, checks, best-interests reasoning and actions.`,
        full:
`If the patient lacked capacity, I would first confirm this with a structured MCA assessment and address reversible causes such as hypoxia, sepsis, pain, delirium or intoxication, reassessing capacity if the situation changes.

I would urgently check for a valid and applicable Advance Decision to Refuse Treatment (ADRT) relating to blood, and whether there is a Health & Welfare Lasting Power of Attorney. A valid, applicable ADRT must be followed.

If there is no applicable ADRT, I would make a best-interests decision using the statutory checklist, taking into account the patient’s known wishes, values and beliefs, and choosing the least restrictive option. I would involve senior clinicians early, and if there is no appropriate person to consult I would involve an IMCA. If there is disagreement or complexity (and the situation is not an immediate emergency), I would seek ethics/legal advice and consider court input. I would document the capacity assessment, checks performed, and best-interests rationale clearly.`
      },
      f2: {
        bullets:
`• Involve seniors early + nursing team for monitoring and consistent messaging.
• Engage specialists as needed: anaesthetics/ICU, haematology, surgery, transfusion team.
• Offer chaplaincy/faith liaison and interpreter if helpful (with patient consent).
• Family: involve with patient consent if capacitous; if no capacity, family helps inform best-interests (can’t “consent” for capacitous patient).
• Clarify plan/roles; document who was involved and decisions made.`,
        full:
`I would involve the multidisciplinary team early to ensure safe, coordinated care. This includes senior clinicians for oversight, nursing staff for close monitoring and communication, and relevant specialists such as anaesthetics/ICU and haematology (and surgery if relevant) to plan haemodynamic support and blood conservation strategies.

With the patient’s agreement, I would offer chaplaincy or a faith liaison and use an interpreter if language is a barrier. If the patient has capacity, family involvement should be with the patient’s consent—family can support the patient and help clarify values, but they cannot override a capacitous refusal. If the patient lacks capacity, family and carers can provide information about the patient’s wishes and beliefs to inform a best-interests decision, and an IMCA should be involved if there is no one appropriate.

I would ensure roles are clear, the plan is communicated consistently to avoid mixed messages, and I would document who was involved and the outcomes of discussions.`
      },
      f3: {
        bullets:
`• Optimise Hb / treat cause: iron, B12/folate; consider EPO where appropriate.
• Reduce blood loss: meticulous haemostasis, minimise phlebotomy (paediatric tubes), review anticoagulants.
• Haemostatic strategies: tranexamic acid; surgical/anaesthetic blood-conservation techniques.
• Consider cell salvage/ANH if acceptable to the patient.
• Support oxygen delivery: oxygen, fluids, vasopressors/ICU as needed.
• Be honest about limits; document what is acceptable.`,
        full:
`I would discuss blood-sparing alternatives with the patient and relevant specialists, noting that acceptability varies by individual belief. Options include optimising haemoglobin and treating reversible causes (iron replacement, correcting B12/folate deficiency, and considering erythropoietin where clinically appropriate), and minimising iatrogenic blood loss by reducing phlebotomy and using smaller-volume tubes.

Depending on the context, haemostatic strategies such as tranexamic acid and meticulous haemostasis are important, and surgical/anaesthetic blood conservation techniques may reduce bleeding. Where relevant, I would explore procedures like intra-operative cell salvage or acute normovolaemic haemodilution if these are acceptable to the patient.

I would also optimise oxygen delivery and haemodynamic support with careful fluid management, oxygen therapy, and escalation to critical care if needed. I would be transparent about the limits—alternatives may reduce risk but may not fully replace transfusion—and document clearly what products or procedures the patient accepts or refuses.`
      }
    }
  },

  // 2) CONFIDENTIALITY BREACH
  confidentiality_breach: {
    title: "Professionalism: Confidentiality breach (student discussing patient loudly)",
    prompts: {
      main: "You see a fellow student discussing identifiable patient information loudly in a corridor. What would you do?",
      f1: "What if they become defensive?",
      f2: "What if others overheard?",
      f3: "Why is confidentiality important?"
    },
    models: {
      main: {
        bullets:
`• Act immediately to reduce harm: interrupt politely and move conversation to a private space.
• Speak 1:1, non-judgemental: explain confidentiality duty (GMC), impact on trust and patient dignity.
• Clarify what should happen: discuss cases only in appropriate settings; anonymise details; “need-to-know”.
• Encourage reflection and learning; offer support (they may be stressed/unaware).
• Escalate if serious/repeated: supervisor/clinical lead per local policy.
• Document/incident report if required; consider patient disclosure if significant breach.`,
        full:
`My priority is to protect the patient’s confidentiality and minimise harm. I would intervene promptly but respectfully—politely stopping the conversation and suggesting we move somewhere private. That immediately reduces the risk of further disclosure.

I would then speak to the student one-to-one in a calm, non-judgemental way. I would explain that discussing identifiable patient information in public spaces breaches confidentiality and professionalism, undermines patient dignity, and can damage trust in the healthcare team. I would reinforce that case discussions should happen in appropriate settings and only with staff who need the information, and that details should be anonymised wherever possible.

I would encourage the student to reflect on what happened and why it matters, and I would offer support—sometimes these lapses occur due to stress or lack of awareness. If the breach was serious, repeated, or the student was unwilling to take it seriously, I would escalate to a supervisor or the clinical team according to local policy. If required, I would complete an incident report and ensure appropriate steps are taken to address any potential patient harm, including considering whether the patient needs to be informed depending on local governance guidance.`
      },
      f1: {
        bullets:
`• Stay calm; avoid arguing; focus on patient safety and professional standards.
• Use “I” language: “I’m concerned this could be identifiable…”
• Explain consequences: harm to trust, governance implications.
• If they refuse to engage or it’s repeated: escalate to supervisor.`,
        full:
`If they became defensive, I would remain calm and avoid confrontation. I’d use “I” language—such as “I’m concerned this might be identifiable in a public area”—to keep the discussion constructive. I would refocus on patient safety and professional standards rather than blame, and briefly outline why it matters, including the impact on trust and governance. If they continued to dismiss it or it was a repeated issue, I would escalate to an appropriate supervisor.`
      },
      f2: {
        bullets:
`• Treat as higher-risk: identifiable info may have been disclosed.
• Inform senior/supervisor promptly; follow local incident reporting.
• Consider mitigation: clarify what was said, who might have heard, whether patient needs informing.
• Support student + learning plan.`,
        full:
`If others may have overheard, I would treat it as a higher-risk breach and inform a supervisor promptly, following local incident reporting procedures. I would clarify what was said, whether it was identifiable, and who might have heard, so the team can mitigate harm appropriately. Depending on the severity and policy, the patient may need to be informed. I would also support the student with reflection and learning to prevent recurrence.`
      },
      f3: {
        bullets:
`• Protects dignity and privacy; legal/professional duty.
• Maintains trust so patients disclose sensitive information.
• Enables safe, effective care and safeguards reputation of the profession.`,
        full:
`Confidentiality protects patient dignity and privacy and is a legal and professional obligation. It also underpins trust—patients are more likely to share sensitive information if they believe it will be handled appropriately, which is essential for safe care. Breaches can harm patients and damage confidence in the healthcare system and profession.`
      }
    }
  },

  // 3) COLLEAGUE ERROR
  colleague_error: {
    title: "Patient safety: Prescribing error noticed",
    prompts: {
      main: "You notice a junior doctor prescribing the wrong medication dose. What would you do?",
      f1: "What if they dismiss you?",
      f2: "What if patient received it?",
      f3: "Why speak up?"
    },
    models: {
      main: {
        bullets:
`• Patient safety first: act promptly before harm occurs.
• Verify facts: check chart, indication, allergies, renal function, guidelines; avoid assumptions.
• Speak to prescriber privately and respectfully; use structured language (e.g., SBAR).
• Agree immediate fix: amend prescription, inform nursing/pharmacy as needed.
• Escalate to senior if unresolved/urgent; document appropriately and complete incident report if required.
• Support learning: debrief, reflect, encourage a just culture.`,
        full:
`My priority is patient safety, so I would act promptly. First, I would verify the concern by checking the prescription details—dose, route, frequency—alongside the patient’s indication, allergies, weight/renal function and relevant guidelines. That ensures I’m not misinterpreting the situation.

If I still believed the dose was wrong, I would speak to the prescriber privately and respectfully, using a structured approach such as SBAR: describing the situation, my concern, and suggesting a safer alternative. The aim is to correct the error collaboratively rather than blame. I would ensure the prescription is amended quickly and that the relevant team members—such as nursing staff and pharmacy—are aware so the patient is not given the wrong dose.

If the prescriber was not receptive, if there was immediate risk, or I could not resolve it promptly, I would escalate to a senior clinician. Depending on local policy and the seriousness, I would also ensure appropriate documentation and consider an incident report so the system can learn. Finally, I would support the colleague—errors happen—and encourage reflection and learning in a just culture to reduce recurrence.`
      },
      f1: {
        bullets:
`• Stay calm; restate objective safety concern and evidence.
• Escalate if unresolved: registrar/consultant, pharmacist, nurse in charge.
• If imminent harm: act immediately via senior/nursing to hold medication.`,
        full:
`If they dismissed me, I would remain calm and restate the concern clearly, focusing on objective safety evidence rather than opinion. If it still wasn’t resolved, I would escalate promptly to an appropriate senior and involve pharmacy or the nurse in charge, especially if the medication was due imminently. If there was a risk of immediate harm, I would ensure the drug is withheld until reviewed by a senior.`
      },
      f2: {
        bullets:
`• Assess patient immediately; ABCDE; check obs and symptoms.
• Inform senior urgently; initiate management (antidote/supportive care) per guidance.
• Document clearly; incident report.
• Duty of candour: honest explanation/apology, next steps, follow-up plan (with senior support).`,
        full:
`If the patient had already received the dose, I would assess them immediately using an ABCDE approach and check observations and symptoms. I would inform a senior urgently and start appropriate management in line with guidance, which may include monitoring, supportive care or an antidote depending on the drug. I would document what happened, complete an incident report, and follow duty of candour: ensuring the patient is informed honestly, with an apology and clear explanation of next steps and follow-up, supported by a senior.`
      },
      f3: {
        bullets:
`• Prevents avoidable harm; professional duty to raise concerns.
• Encourages a safety culture and system learning.
• Protects patients and supports colleagues through early correction.`,
        full:
`Speaking up prevents avoidable harm and is a core professional duty—patient safety comes before hierarchy. It also supports a culture where teams learn from errors and improve systems, reducing repeat mistakes. Early challenge can protect the patient and support colleagues by correcting issues before they escalate.`
      }
    }
  },

  // 4) DNAR CONFLICT
  dnar_conflict: {
    title: "Ethics: Family insists on CPR despite DNAR decision",
    prompts: {
      main: "Family insists on CPR despite DNAR decision. Approach?",
      f1: "If angry?",
      f2: "Who decides DNAR?",
      f3: "Support family?"
    },
    models: {
      main: {
        bullets:
`• Start with empathy: acknowledge emotion, grief, fear; ensure privacy.
• Clarify DNAR scope: applies to CPR only; other active treatments continue unless otherwise agreed.
• Explain rationale: CPR likely not beneficial / burdens outweigh benefits; focus on best interests and realistic outcomes.
• Explore understanding and values; check if patient expressed wishes/advance care plan.
• Involve senior clinician; consider palliative care; aim for shared understanding.
• De-escalate, document discussion; offer ongoing updates and support.`,
        full:
`I would begin by acknowledging the family’s distress and ensuring the conversation happens in a private, calm setting. I would use empathic language, recognising that insistence on CPR often reflects fear and a desire to “do everything”.

I would clarify what a DNAR decision means: it relates specifically to CPR in the event of cardiac or respiratory arrest, and it does not mean we stop other appropriate treatment or good care. I would then explain the clinical reasoning in an understandable way: that CPR may be very unlikely to succeed in this context, and even if it does, it may lead to significant suffering or poor outcomes. The goal is to act in the patient’s best interests and avoid interventions that are non-beneficial or harmful.

I would explore the family’s understanding and what the patient would have wanted—whether there is an advance care plan, previously expressed wishes, or values that should guide decisions. I would involve the senior clinician responsible for the DNAR decision early, and consider involving palliative care for symptom control and support. Throughout, I would aim for shared understanding, keep communication open, and document the discussion clearly.`
      },
      f1: {
        bullets:
`• Stay calm and respectful; validate emotions.
• Use de-escalation: slow pace, clear language, boundaries.
• Offer senior review; avoid arguing.
• If safety concern: involve security/staff support as needed.`,
        full:
`If the family were angry, I would remain calm, listen, and validate their emotions without becoming defensive. I would use de-escalation—slowing the conversation, using clear language, and setting respectful boundaries. I would offer a senior review and ensure the family feels heard, while avoiding arguments. If there were any safety concerns, I would involve staff support appropriately.`
      },
      f2: {
        bullets:
`• DNAR is a clinical decision by senior clinician, informed by patient wishes and best interests.
• Patient with capacity decides about CPR preferences; clinicians decide if CPR is clinically appropriate.
• Family contributes information but does not “consent” to DNAR for a capacitous patient.`,
        full:
`A DNAR decision is made by a senior clinician based on clinical judgement about whether CPR would be appropriate, informed by the patient’s wishes and best interests. If the patient has capacity, their preferences should be discussed and respected, but clinicians are not obliged to provide treatment that is clinically inappropriate. Families can provide valuable information about the patient’s values and wishes, but they do not give consent for or against DNAR on behalf of a capacitous patient.`
      },
      f3: {
        bullets:
`• Provide clear information, consistent messaging, and time for questions.
• Offer emotional support: liaison nurse, chaplaincy, palliative care, bereavement support.
• Agree communication plan and updates; signpost practical support.`,
        full:
`Supporting the family involves clear, compassionate communication and time for questions. I would ensure consistent messaging from the team, offer emotional support and signposting—such as palliative care input, chaplaincy, and bereavement services where relevant—and agree a plan for regular updates. Practical support and reassurance that comfort and dignity remain priorities can also help.`
      }
    }
  },

  // 5) CAPACITY REFUSAL
  capacity_refusal: {
    title: "Capacity: Elderly patient refuses needed surgery",
    prompts: {
      main: "Elderly patient refuses needed surgery. Approach?",
      f1: "Assess capacity?",
      f2: "Fluctuating capacity?",
      f3: "Treat without consent?"
    },
    models: {
      main: {
        bullets:
`• Start with empathy and rapport; check pain/anxiety; ensure privacy.
• Explore reasons for refusal (fear, misunderstanding, cultural beliefs, past experiences).
• Give balanced information: benefits/risks of surgery and of not having it; alternatives; answer questions.
• Assess capacity (MCA): understand/retain/weigh/communicate; support decision-making (interpreter, visuals, family support with consent).
• If capacitous refusal: respect autonomy; safety-net; document and involve seniors.
• If no capacity: best-interests pathway; consider ADRT/LPA; involve MDT.`,
        full:
`I would start by building rapport and acknowledging that refusing surgery can come from fear, previous experiences, or misunderstanding. I would ensure the setting is private, manage immediate discomfort such as pain or nausea, and ask open questions to explore the patient’s concerns and goals.

I would then provide clear, balanced information about the condition, what the surgery aims to achieve, the key risks and benefits, and importantly the likely consequences of not proceeding. I would discuss reasonable alternatives where available and check understanding with teach-back, inviting questions. I would also offer supportive measures to help decision-making, such as an interpreter, written information, or involving family with the patient’s consent.

I would assess capacity under the Mental Capacity Act by confirming the patient can understand, retain, weigh the information and communicate a decision. If the patient has capacity and still refuses, I must respect their autonomy, even if I disagree. I would document the discussion thoroughly, involve seniors, and safety-net by outlining warning signs and arranging follow-up. If the patient lacks capacity, I would follow a best-interests process and involve the MDT appropriately.`
      },
      f1: {
        bullets:
`• MCA test: understand, retain, weigh, communicate.
• Capacity is decision- and time-specific; presume capacity; support decision-making.
• Document assessment and supports used.`,
        full:
`Capacity is assessed under the MCA and is decision-specific and time-specific. I would check whether the patient can understand the relevant information, retain it long enough, weigh it as part of a decision, and communicate their choice. I would presume capacity unless proven otherwise and support decision-making by addressing reversible factors and using interpreters or aids as needed, documenting the assessment clearly.`
      },
      f2: {
        bullets:
`• Treat reversible causes and reassess; aim to decide at a time of best capacity.
• If urgent and no capacity: best interests, least restrictive.
• Involve family/IMCA and seniors; document.`,
        full:
`If capacity fluctuates, I would treat reversible causes and reassess, aiming to make the decision at a time when capacity is optimal. If the situation becomes urgent and the patient lacks capacity, I would proceed using a best-interests decision with senior input, involving family or an IMCA as appropriate and documenting the rationale and least restrictive approach.`
      },
      f3: {
        bullets:
`• Only if no capacity and treatment is in best interests, or in emergency to prevent serious harm.
• Respect ADRT/LPA; least restrictive; senior/legal support where needed.`,
        full:
`Treatment without consent is only justified if the patient lacks capacity and it is in their best interests, or in an emergency to prevent serious harm, within the legal framework of the MCA. I would check for an ADRT or LPA, choose the least restrictive option, involve seniors, and seek legal/ethics support if there is dispute or time allows.`
      }
    }
  },

  // 6) BREAKING BAD NEWS
  breaking_bad_news: {
    title: "Communication: Breaking bad news (new cancer diagnosis)",
    prompts: {
      main: "Explain new cancer diagnosis. Approach?",
      f1: "If distressed?",
      f2: "If doesn’t want details?",
      f3: "Why empathy?"
    },
    models: {
      main: {
        bullets:
`• Prepare: private room, no interruptions, sit down; invite relative if patient wants.
• Start with assess understanding + warning shot; ask preference for information.
• Deliver diagnosis clearly in small chunks; avoid jargon; pause.
• Respond to emotion with empathy; allow silence; validate feelings.
• Explain next steps: staging, referrals (MDT/oncology), support services, safety-net.
• Check understanding (teach-back), invite questions, summarize, document.`,
        full:
`I would prepare the environment first: a private room, seated at eye level, minimizing interruptions, and checking whether the patient would like a relative or support person present. I would start by assessing the patient’s current understanding and what they are expecting, and I would ask how much information they would like at this moment.

I would give a brief warning shot—such as “I’m afraid the results show something serious”—and then deliver the diagnosis clearly and compassionately, using simple language and giving information in small chunks, pausing frequently to allow processing. I would avoid jargon and check understanding as I go.

If the patient becomes emotional, I would respond with empathy, allowing silence, acknowledging the shock and distress, and using supportive statements rather than rushing to fill the space. Once the patient is ready, I would outline the immediate next steps: what further tests might be needed, referral to the specialist team and MDT, and what treatments could involve, without overwhelming detail. I would also signpost support such as specialist nurses, psychological support, and written information.

Finally, I would check understanding using teach-back, invite questions, summarize what we’ve discussed, agree a plan for follow-up, and document the conversation and any concerns.`
      },
      f1: {
        bullets:
`• Pause, acknowledge emotion, give time; use silence.
• Offer support person; assess immediate risk (panic/self-harm cues).
• Continue only when ready; provide clear next steps and support.`,
        full:
`If the patient is distressed, I would pause and acknowledge how they are feeling, allowing time and silence. I’d offer a support person and assess for immediate risk if there are cues of severe distress. I would only continue when the patient is ready, focusing on what they need right now and providing clear next steps and support.`
      },
      f2: {
        bullets:
`• Respect autonomy: ask what they want to know now; offer staged information.
• Ensure minimum necessary info for decisions and safety.
• Offer follow-up appointment and written resources.`,
        full:
`If they don’t want details, I would respect that preference and offer to provide information gradually. I would ensure they still understand the essentials needed for immediate decisions and safety, and I would arrange follow-up with opportunities to revisit information, providing written resources and contact details.`
      },
      f3: {
        bullets:
`• Builds trust and psychological safety.
• Improves understanding and engagement.
• Supports coping and shared decision-making.`,
        full:
`Empathy builds trust and helps the patient feel safe and supported during a life-changing conversation. It improves understanding and engagement with care, and supports coping and shared decision-making, which ultimately leads to better outcomes and a stronger therapeutic relationship.`
      }
    }
  },

  // 7) TEAM CONFLICT
  team_conflict: {
    title: "Teamwork: Team conflict affecting patient care",
    prompts: {
      main: "Team conflict affecting care. What do you do?",
      f1: "If ignored?",
      f2: "Why teamwork important?",
      f3: "What makes teamwork effective?"
    },
    models: {
      main: {
        bullets:
`• Patient safety first: identify immediate risks; ensure urgent tasks covered.
• Address early, privately and respectfully; avoid blame; focus on behaviours and impact.
• Facilitate structured discussion: shared goal, clarify roles, agree plan and communication method.
• Escalate to senior/ward lead if persistent or safety compromised.
• Document/escalate as per policy if serious; reflect and learn.`,
        full:
`I would start from the principle that patient safety is the priority. If the conflict is actively affecting care—for example delays or miscommunication—I would ensure immediate clinical tasks are covered and that the patient is safe, involving a senior if needed.

I would then address the issue early and professionally, ideally in a private setting, focusing on specific behaviours and their impact rather than personal blame. I would encourage both parties to share their perspectives and steer the conversation towards a shared goal: safe, effective patient care. Using a structured approach, I would clarify roles and responsibilities, agree a plan for communication—such as handover expectations or escalation routes—and confirm what will change going forward.

If the conflict persists or there is a risk to patients, I would escalate to an appropriate senior, such as the registrar, consultant, nurse in charge or ward manager, and consider wider support like mediation. If there are serious professional concerns, I would follow local policies for raising concerns. I would also reflect on what could prevent recurrence and promote a supportive team culture.`
      },
      f1: {
        bullets:
`• Re-state patient-safety risk with examples.
• Escalate via chain of command; involve ward lead.
• Use incident reporting if patient safety compromised.`,
        full:
`If my attempt was ignored, I would restate the concern in terms of patient safety with specific examples, and escalate via the appropriate chain of command. If patient safety had been compromised, I would also use incident reporting and governance processes so the issue is addressed and the system can learn.`
      },
      f2: {
        bullets:
`• Reduces errors and delays; improves continuity.
• Enables shared situational awareness and escalation.
• Improves patient experience and outcomes.`,
        full:
`Teamwork is crucial because healthcare is complex and relies on coordinated actions. Effective teamwork reduces errors and delays, improves continuity, and ensures concerns are escalated appropriately through shared situational awareness. It also improves the patient experience and outcomes.`
      },
      f3: {
        bullets:
`• Clear communication and structured handover.
• Mutual respect and psychological safety to speak up.
• Clear roles, leadership, shared goals.
• Reflection and learning culture.`,
        full:
`Effective teamwork requires clear communication, including structured handover, and mutual respect so people feel able to speak up. It also needs clear roles, leadership and shared goals, alongside a culture of reflection and learning rather than blame.`
      }
    }
  },

  // 8) CULTURAL / BELIEF-BASED REFUSAL
  cultural_refusal: {
    title: "Ethics: Patient refuses treatment due to beliefs",
    prompts: {
      main: "Patient refuses treatment due to beliefs. Approach?",
      f1: "Respect beliefs?",
      f2: "Conflict with advice?",
      f3: "Avoid bias?"
    },
    models: {
      main: {
        bullets:
`• Build rapport; explore beliefs and what matters to the patient (open questions).
• Provide clear medical info: risks/benefits of treatment vs refusal; alternatives.
• Assess capacity; ensure decision is informed and voluntary; use interpreter if needed.
• Shared decision-making: align plan with values where possible; negotiate acceptable options.
• If capacitous refusal persists: respect autonomy; safety-net and follow-up; document.
• Involve MDT: senior, specialist nurse, chaplain/faith liaison, cultural mediator if helpful (with consent).`,
        full:
`I would approach the situation with respect and curiosity rather than judgement, because beliefs often reflect identity and values. I’d start by building rapport and asking open questions to understand the patient’s perspective—what their belief means in practical terms, and what their key priorities and fears are.

I would then explain the medical situation clearly: the expected benefits and risks of the proposed treatment, and the likely consequences of declining it. I would discuss reasonable alternatives or modifications that might be acceptable within their beliefs, and I would check understanding using teach-back. I would also assess capacity and ensure the decision is informed and voluntary, using an interpreter if language could be a barrier and offering time if clinically safe.

Where possible, I would aim for shared decision-making—finding a plan that respects the patient’s values while maintaining safety. If the patient has capacity and continues to refuse, I would respect their autonomy even if I disagree, while providing supportive care, safety-netting, arranging follow-up, and documenting the discussion and decision clearly. I would involve seniors and the MDT, and if the patient wishes, offer chaplaincy/faith liaison or cultural mediation to support them.`
      },
      f1: {
        bullets:
`• Respect = listen, acknowledge, and avoid assumptions; don’t stereotype.
• Ask what is acceptable; clarify specifics; use interpreter/faith liaison if wanted.`,
        full:
`Respecting beliefs means listening carefully, acknowledging their importance, and avoiding assumptions or stereotypes. I would ask the patient what their belief requires in this situation and what options might be acceptable, supporting communication with interpreters or a faith liaison if the patient wants.`
      },
      f2: {
        bullets:
`• Be honest about medical risks; explain why you recommend treatment.
• Explore alternatives; confirm capacity; respect informed refusal.
• Escalate to senior if high-stakes; document and safety-net.`,
        full:
`If their decision conflicts with medical advice, I would be honest about the risks and why I’m recommending treatment, then explore acceptable alternatives. I would confirm capacity and that the refusal is informed. If it’s high-stakes, I would involve a senior and document clearly, while safety-netting and arranging follow-up.`
      },
      f3: {
        bullets:
`• Reflect on assumptions; use patient-centred questions.
• Use interpreters; avoid value judgements; treat with equal respect.
• Seek supervision if unsure; follow GMC equality guidance.`,
        full:
`To avoid bias, I would reflect on my assumptions, use patient-centred questions, and avoid value judgements. I would ensure communication is clear—using interpreters where needed—and treat the patient with equal respect. If I felt uncertain, I would seek supervision and follow professional guidance on equality and diversity.`
      }
    }
  },

  // 9) CONSENT UNDERSTANDING
  consent_understanding: {
    title: "Consent: Patient agrees but does not understand",
    prompts: {
      main: "Patient consents but lacks understanding. What do you do?",
      f1: "Valid consent?",
      f2: "Check understanding?",
      f3: "Why informed consent?"
    },
    models: {
      main: {
        bullets:
`• Pause procedure: consent not valid if not informed/understood.
• Re-explain diagnosis/procedure, key risks, benefits, alternatives (including no treatment) in plain language.
• Check capacity; ensure voluntariness; address pressure/anxiety; offer interpreter/written info.
• Use teach-back to confirm understanding; invite questions; allow time.
• If still not understanding: involve senior, delay if non-urgent; document thoroughly.`,
        full:
`If it becomes clear the patient is agreeing without understanding, I would pause and not proceed, because consent must be informed and voluntary. I would re-explain the procedure in plain language, covering the purpose, the key risks and benefits, and alternatives including doing nothing, and I would tailor the depth of information to what is material for that patient.

I would assess capacity and ensure the patient is not being pressured, addressing factors like anxiety, pain or language barriers. I would offer an interpreter, written information, diagrams, or a quieter setting, and I would encourage questions. I would use teach-back—asking the patient to explain in their own words what will happen and the main risks—to confirm genuine understanding.

If the patient still does not understand, I would involve a senior clinician, and if the procedure is non-urgent I would delay to allow time for better explanation or support. I would document the discussion, what information was provided, how understanding was checked, and the final decision.`
      },
      f1: {
        bullets:
`• Valid consent requires: capacity, adequate information, and voluntariness.
• Ongoing process; can be withdrawn any time.`,
        full:
`Valid consent requires that the patient has capacity, receives adequate information about risks/benefits/alternatives, and makes the decision voluntarily. It’s an ongoing process and the patient can withdraw consent at any time.`
      },
      f2: {
        bullets:
`• Teach-back; ask them to summarise.
• Use open questions; address misunderstandings.
• Use interpreter/visual aids; confirm specific key risks.`,
        full:
`I would check understanding by using teach-back and open questions, asking the patient to summarise the procedure and key risks in their own words. I would correct misunderstandings, use interpreters or visual aids where helpful, and confirm they understand the specific risks most relevant to them.`
      },
      f3: {
        bullets:
`• Respects autonomy and legal/ethical duties.
• Improves adherence and satisfaction; reduces complaints.
• Prevents harm from unwanted interventions.`,
        full:
`Informed consent is essential because it respects patient autonomy and meets legal and ethical duties. It improves engagement and satisfaction, reduces conflict and complaints, and prevents harm that can arise when patients undergo interventions they would not have chosen if properly informed.`
      }
    }
  },

  // 10) SOCIAL MEDIA BOUNDARY
  social_media_boundary: {
    title: "Professionalism: Patient sends friend request on social media",
    prompts: {
      main: "Patient sends friend request. Response?",
      f1: "Why boundaries?",
      f2: "Risks?",
      f3: "Doctor social media use?"
    },
    models: {
      main: {
        bullets:
`• Decline politely; do not engage clinically via social media.
• Explain professional boundaries: maintain therapeutic relationship and fairness to all patients.
• Offer appropriate channels: clinic contact details, PALS, appointment system.
• Maintain confidentiality: avoid acknowledging patient relationship publicly.
• Reflect and document if needed; seek senior advice if patient becomes distressed or persistent.`,
        full:
`I would not accept the friend request, and I would avoid any clinical discussion over social media. If appropriate, I would respond in a polite, professional way—if a response is necessary at all—explaining that I have to maintain professional boundaries to protect the patient-doctor relationship and ensure confidentiality and fairness.

I would signpost the patient to appropriate channels for clinical queries, such as the clinic contact details, the appointment system, or patient advice services, depending on the setting. I would also be careful not to disclose or imply the patient relationship publicly, as even acknowledging it can breach confidentiality.

If the patient raised this in person, I would discuss it sensitively, exploring what need they were trying to meet and ensuring they still feel supported within professional boundaries. If the situation felt complex—such as repeated requests or the patient becoming distressed—I would seek senior advice and document relevant discussions according to local guidance.`
      },
      f1: {
        bullets:
`• Boundaries protect trust and prevent dual relationships.
• Maintain objectivity and fairness; avoid dependence.
• Safeguards confidentiality and professional integrity.`,
        full:
`Boundaries protect trust and keep the relationship therapeutic rather than personal. They help maintain objectivity, prevent dual relationships or dependence, and safeguard confidentiality. Clear boundaries also protect the integrity of the profession and ensure all patients are treated fairly.`
      },
      f2: {
        bullets:
`• Confidentiality breaches (likes/comments/DMs).
• Blurred roles, favouritism perception, loss of objectivity.
• Data/privacy issues; complaints/fitness to practise risk.`,
        full:
`The risks include accidental breaches of confidentiality—through messages, comments, or even others seeing a connection—as well as blurred roles that can affect clinical objectivity or create perceptions of favouritism. There are also privacy and data security concerns, and it can lead to complaints or professional regulatory issues if boundaries are not maintained.`
      },
      f3: {
        bullets:
`• Follow professional guidance: privacy settings, professionalism, separate accounts if needed.
• Never post identifiable patient info; be mindful you represent the profession.
• Avoid online interactions that blur boundaries; seek advice if unsure.`,
        full:
`Doctors can use social media, but should follow professional guidance: maintain strong privacy settings, communicate professionally, and never share identifiable patient information. It’s important to remember online behaviour can reflect on the profession. Avoid interactions that blur boundaries with patients, and seek advice if uncertain.`
      }
    }
  }
};
