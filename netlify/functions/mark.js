// netlify/functions/mark.js

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

  const stationId = String(body.stationId || "").trim();
  const answers = body.answers || {};
  const station = STATIONS[stationId];

  if (!stationId) {
    return json(400, { error: "Missing stationId" });
  }

  // This is the error you're seeing: stationId in station.html not matching backend keys.
  if (!station) {
    return json(400, {
      error: "Unknown stationId",
      received: stationId,
      expected: Object.keys(STATIONS)
    });
  }

  const prompt = buildPrompt(station, answers);

  try {
    // Hard timeout guard (so it fails cleanly rather than hanging)
    const controller = new AbortController();
    const timeoutMs = 25000; // keep < common Netlify limits
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: prompt,
        // Keeping output short reduces slow responses/timeouts
        max_output_tokens: 550
      })
    });

    clearTimeout(t);

    const data = await res.json().catch(() => null);
    if (!data) {
      return json(500, { error: "Invalid OpenAI response (non-JSON)" });
    }

    const text = extractText(data);
    const parsed = safeJson(text);

    if (!parsed || !parsed.scores || !parsed.feedback) {
      return json(500, {
        error: "Invalid model JSON",
        raw: text
      });
    }

    return json(200, {
      scores: parsed.scores,
      feedback: parsed.feedback,
      models: station.models
    });
  } catch (e) {
    const msg = String(e);

    // AbortController timeout
    if (msg.includes("AbortError")) {
      return json(504, {
        error: "Upstream timeout (model took too long). Try again."
      });
    }

    return json(500, { error: "Server error", detail: msg });
  }
}

function buildPrompt(station, answers) {
  return `
You are a UK medical school MMI examiner.

Mark this candidate for the station:
${station.title}

Score 0–10 each:
- empathy
- communication
- ethics
- insight
Also give overall 0–10.

Provide feedback for:
- main
- f1
- f2
- f3

Return ONLY JSON:

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
Answer:
${answers.main || ""}

Follow-up 1:
${station.prompts.f1}
Answer:
${answers.f1 || ""}

Follow-up 2:
${station.prompts.f2}
Answer:
${answers.f2 || ""}

Follow-up 3:
${station.prompts.f3}
Answer:
${answers.f3 || ""}
`.trim();
}

function extractText(r) {
  try {
    for (const o of r.output || []) {
      if (o.content) {
        for (const c of o.content) {
          if (c.type === "output_text" && c.text) return c.text;
          if (c.text) return c.text;
        }
      }
    }
  } catch {}
  return "";
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {}

  // If model wraps JSON with other text, salvage it
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(text.slice(s, e + 1));
    } catch {}
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

/**
 * IMPORTANT:
 * These keys MUST match your station.html STATIONS_META keys and index.html openStation('...') ids.
 * Based on your screenshots, you currently have at least:
 * - blood_transfusion_refusal
 * - confidentiality_breach
 * - colleague_error
 * - dnar_conflict
 * - capacity_refusal
 * - breaking_bad_news
 * - team_conflict
 * - cultural_refusal
 * - consent_understanding
 * - relative_requests_information
 */
const STATIONS = {
  blood_transfusion_refusal: {
    title: "Refusal of life-saving blood transfusion",
    prompts: {
      main: "A patient refuses a life-saving blood transfusion for religious reasons. Discuss how you would approach this situation.",
      f1: "What would you do if the patient did not have capacity?",
      f2: "How would you involve the multidisciplinary team or family?",
      f3: "Can you suggest any ethically acceptable alternatives?"
    },
    models: {
      main: {
        bullets:
          "• Stabilise + assess urgency\n• Assess capacity (MCA)\n• Explore reasons/beliefs respectfully\n• Explain risks/benefits + check understanding\n• If capacitous, respect refusal\n• Escalate to senior + document clearly",
        full:
          "I would treat this as an urgent, patient-centred discussion. First I would stabilise the patient and assess time-critical risk. I’d then assess capacity under the Mental Capacity Act: can they understand, retain, weigh the information and communicate a decision? I would explore the patient’s beliefs and concerns respectfully, ensuring privacy and appropriate support (e.g., liaison, chaplaincy if wanted). I’d explain the benefits of transfusion, the likely consequences of refusal, and any alternatives, checking understanding using teach-back. If the patient has capacity and continues to refuse, I would respect their autonomous decision, escalate to a senior clinician, and document the capacity assessment and discussion carefully while continuing supportive care."
      },
      f1: {
        bullets:
          "• Confirm lack of capacity + why\n• Check ADRT / LPA / previously expressed wishes\n• Best-interests decision (least restrictive)\n• In emergency, treat to preserve life while seeking senior advice\n• Consider legal/ethics support if complex\n• Document rationale",
        full:
          "If the patient lacked capacity, I would confirm and document this, then check for an ADRT, an LPA, or any clearly recorded prior wishes. If none exist, I would make a best-interests decision under the MCA, involving seniors and the MDT. In a true emergency, I would act to preserve life while seeking urgent senior input, and I’d consider legal/ethics support if there is disagreement or complexity, documenting the decision-making throughout."
      },
      f2: {
        bullets:
          "• Inform senior/consultant early\n• Involve haematology/anaesthetics as relevant\n• Nursing team for monitoring/support\n• Family only with patient consent (if capacitous)\n• Use interpreter/chaplaincy if helpful\n• Clear shared plan + documentation",
        full:
          "I would involve the senior team early and bring in relevant specialists such as haematology/anaesthetics if needed. The nursing team are crucial for monitoring and ongoing communication. If the patient has capacity, I would involve family only with their consent; otherwise I would involve appropriate decision-makers within MCA frameworks. If language or faith support would help, I’d offer an interpreter or chaplaincy. I’d ensure everyone understands the plan and that it’s documented clearly."
      },
      f3: {
        bullets:
          "• Optimise Hb (iron/folate/B12/EPO where appropriate)\n• Minimise blood loss + meticulous haemostasis\n• Tranexamic acid if indicated\n• Cell salvage / fractionated products if acceptable to patient\n• Volume resuscitation + supportive care\n• Be honest about limits of alternatives",
        full:
          "Alternatives depend on the clinical context and the patient’s beliefs. I would consider optimisation of haemoglobin (e.g., iron and treating reversible causes), minimising blood loss and using haemostatic strategies such as tranexamic acid where appropriate. Some patients may accept cell salvage or certain blood fractions; I would explore this without assumptions. I’d provide supportive care and be clear if alternatives are insufficient to achieve the same life-saving benefit as transfusion."
      }
    }
  },

  confidentiality_breach: {
    title: "Confidentiality breach in a public area",
    prompts: {
      main: "You overhear a medical student discussing an identifiable patient loudly in a corridor. What would you do?",
      f1: "How would you handle it if they become defensive or dismissive?",
      f2: "What steps would you take if you believe members of the public/other patients overheard?",
      f3: "What key points would you include in a reflection about this incident?"
    },
    models: {
      main: {
        bullets:
          "• Stop the breach promptly (politely interrupt)\n• Move to private space\n• Explain why it matters (trust/GDPR/professionalism)\n• Encourage learning + safer behaviour\n• Escalate to supervisor if serious/repeated\n• Document/report via local policy if needed",
        full:
          "I would act promptly to protect patient confidentiality. I’d politely interrupt and suggest we continue the conversation somewhere private, then explain that identifiable information must not be discussed in public areas. I would be respectful and educational rather than accusatory, linking it to patient trust, professional standards, and legal duties. Depending on severity (how identifiable, who overheard, repeated behaviour), I would escalate to a supervising clinician/education lead and follow local reporting policy."
      },
      f1: {
        bullets:
          "• Stay calm, non-confrontational\n• Focus on patient impact, not blame\n• Use ‘I’ statements + standards\n• Offer support/resources\n• If persists, escalate appropriately",
        full:
          "If they became defensive, I’d remain calm and keep the focus on patient safety and trust rather than blame. I’d restate the standard expected and why it matters, and offer support on how to handle discussions safely. If they continued to dismiss the issue or repeated the behaviour, I would escalate to a senior/education lead."
      },
      f2: {
        bullets:
          "• Treat as higher severity\n• Inform senior promptly\n• Follow incident reporting/local policy\n• Consider duty of candour steps if identifiable harm\n• Support patient if concerns raised",
        full:
          "If I believed others overheard, I’d treat it as more serious. I would inform a senior promptly and follow local policy for reporting confidentiality incidents. If there’s a realistic risk of patient identification, I would seek senior guidance on next steps, including whether any duty of candour actions are required."
      },
      f3: {
        bullets:
          "• What happened + why it was a breach\n• Impact on patient trust/safety\n• My actions + what I’d do differently\n• Learning points + prevention (private spaces, de-identify)\n• Professional standards (GMC) + confidentiality law basics",
        full:
          "In reflection I’d describe what happened, why it constituted a confidentiality breach, and the potential impact on patient trust and care. I’d explain what I did to stop and address it, what I would do next time, and concrete prevention strategies (de-identification, private settings, awareness of surroundings). I’d link learning to professional standards and confidentiality principles."
      }
    }
  },

  colleague_error: {
    title: "Medication prescribing error noticed",
    prompts: {
      main: "You notice a junior doctor has prescribed a potentially harmful dose of a medication. Talk through exactly what you would do.",
      f1: "What would you do if the doctor insists the prescription is correct and refuses to change it?",
      f2: "What would you do if you realise the patient has already received the dose?",
      f3: "How would you communicate this to the patient (or family) in line with duty of candour?"
    },
    models: {
      main: {
        bullets:
          "• Patient safety first\n• Check facts (drug, dose, patient factors)\n• Speak to prescriber privately + respectfully\n• Escalate if unresolved (senior/pharmacist)\n• Correct prescription + document\n• Support colleague + learning culture",
        full:
          "I would prioritise patient safety. I’d quickly check the prescription details and relevant patient factors (indication, renal function, weight, allergies, interactions). I would then speak to the prescriber privately and respectfully, explaining my concern and the evidence. If it appears incorrect, I would ensure the prescription is amended and the team is aware. If there is any resistance or uncertainty, I would escalate immediately to a senior clinician and/or pharmacist. I would document the actions taken and support the colleague in a non-blaming learning culture."
      },
      f1: {
        bullets:
          "• Re-state risk clearly\n• Offer to check guideline together / involve pharmacist\n• Escalate immediately to senior\n• Do not allow unsafe administration",
        full:
          "If they insisted it was correct, I’d suggest checking guidance together and involve a pharmacist. If still unresolved, I’d escalate to a senior clinician immediately. Patient safety overrides hierarchy, and I would not allow an unsafe dose to be administered."
      },
      f2: {
        bullets:
          "• Assess patient urgently + observations\n• Inform senior + pharmacist\n• Treat/manage adverse effects\n• Monitor + investigations\n• Document + incident report",
        full:
          "If the dose had already been given, I would assess the patient urgently, inform a senior clinician and pharmacist, and take steps to mitigate harm (appropriate monitoring, investigations and treatment). I would document the event and follow local incident reporting processes."
      },
      f3: {
        bullets:
          "• Be honest + timely\n• Apologise (not blame-shifting)\n• Explain what happened + impact\n• Explain what we’re doing now\n• Offer questions/support + document",
        full:
          "In line with duty of candour, I would ensure a senior clinician leads a clear, honest and timely discussion. We would explain what happened, apologise, outline potential effects, and describe what we are doing to treat and monitor the patient. We would invite questions, provide support, and document the conversation."
      }
    }
  },

  dnar_conflict: {
    title: "DNACPR disagreement with family",
    prompts: {
      main: "A patient has a DNACPR decision documented. The family insists that 'everything must be done' and demand CPR. How would you approach this conversation?",
      f1: "How would you respond if the family becomes angry and accusatory?",
      f2: "Who is involved in DNACPR decisions and what principles guide them?",
      f3: "How would you support the family while maintaining a patient-centred plan?"
    },
    models: {
      main: {
        bullets:
          "• Acknowledge distress + create private space\n• Clarify DNACPR scope (CPR only)\n• Explain reasoning (benefit vs burden / futility)\n• Explore values + patient wishes\n• Involve senior/MDT early\n• Document + safety-net",
        full:
          "I would speak in a private space and acknowledge how distressing this is for the family. I’d clarify that DNACPR relates to CPR specifically and does not mean stopping all treatment. I would explain that CPR decisions are based on clinical judgement about likely benefit versus harm, and whether CPR would be effective. I’d explore the patient’s wishes, values and any prior conversations, and involve a senior clinician and the MDT early. I’d ensure the plan is communicated clearly and documented."
      },
      f1: {
        bullets:
          "• Stay calm + don’t match emotion\n• Validate feelings\n• Re-focus on patient welfare\n• Offer senior support / break\n• Keep boundaries if abusive",
        full:
          "If they were angry, I’d remain calm and validate their emotions without becoming defensive. I’d refocus on the patient’s welfare and offer to bring in a senior clinician. If behaviour became abusive, I would set respectful boundaries while ensuring support continues."
      },
      f2: {
        bullets:
          "• Senior clinician leads; MDT input\n• Consider patient capacity + wishes\n• Best interests if no capacity\n• National/local policy + documentation\n• Review if situation changes",
        full:
          "DNACPR decisions are typically led by a senior clinician with MDT input, guided by likelihood of CPR success, burdens/harms, and the patient’s wishes. If the patient lacks capacity, decisions are made in best interests. The decision should be documented, communicated, and reviewed if circumstances change."
      },
      f3: {
        bullets:
          "• Offer time + clear explanations\n• Signpost support (nurses, palliative care, chaplaincy)\n• Involve family appropriately\n• Agree what ‘everything’ means (comfort, symptom control)\n• Maintain compassionate communication",
        full:
          "I would support the family through clear explanations, time for questions, and signposting to support such as nursing staff, palliative care and chaplaincy if appropriate. I’d explore what they mean by ‘everything’ and emphasise that excellent care continues (comfort, symptom control, dignity) even if CPR is not appropriate."
      }
    }
  },

  capacity_refusal: {
    title: "Refusal of recommended treatment",
    prompts: {
      main: "An elderly patient refuses a recommended operation that clinicians believe is needed. How would you approach this?",
      f1: "How would you assess capacity in this context?",
      f2: "What if capacity is fluctuating?",
      f3: "When can treatment proceed without consent?"
    },
    models: {
      main: {
        bullets:
          "• Explore reasons + concerns\n• Explain risks/benefits/alternatives\n• Assess capacity (MCA)\n• Support shared decision-making\n• Respect capacitous refusal\n• Document + safety-net",
        full:
          "I would explore the patient’s reasons for refusal and address concerns such as fear, misunderstanding, pain, or social factors. I’d explain the risks, benefits and alternatives in clear language and check understanding. I’d assess capacity under the MCA. If the patient has capacity and continues to refuse, I would respect their decision, document the discussion, involve seniors as needed, and provide safety-net advice and ongoing support."
      },
      f1: {
        bullets:
          "• Understand relevant info\n• Retain info\n• Weigh info\n• Communicate decision\n• Optimise capacity (pain, delirium, hearing, interpreter)",
        full:
          "Capacity requires the ability to understand, retain and weigh relevant information and communicate a decision. I’d also optimise capacity by treating reversible factors (pain, delirium), ensuring aids (hearing/vision), and using an interpreter if required."
      },
      f2: {
        bullets:
          "• Reassess at best time of day\n• Treat reversible causes\n• Defer non-urgent decisions until capacitous\n• If urgent + no capacity → best interests",
        full:
          "If capacity fluctuates, I would reassess at a time when the patient is most lucid and treat reversible causes. If not urgent, I’d defer the decision until capacity is present. If urgent and capacity is absent, decisions must be made in best interests with senior/MDT input."
      },
      f3: {
        bullets:
          "• Only if no capacity AND best interests OR emergency\n• Use least restrictive option\n• Senior involvement + document\n• Consider legal framework where contested",
        full:
          "Treatment without consent is only appropriate when the patient lacks capacity and the intervention is in their best interests, or in a genuine emergency. It should be the least restrictive option, with senior involvement and clear documentation, and legal advice if contested."
      }
    }
  },

  breaking_bad_news: {
    title: "Breaking bad news: new cancer diagnosis",
    prompts: {
      main: "You need to explain a new cancer diagnosis to a patient. How would you approach this?",
      f1: "What would you do if the patient becomes very distressed?",
      f2: "What if they say they don’t want details right now?",
      f3: "How would you safety-net and plan next steps?"
    },
    models: {
      main: {
        bullets:
          "• Private setting + time + support\n• Ask what they know/want (SPIKES)\n• Give warning shot\n• Clear, jargon-free information\n• Pause, listen, respond to emotion\n• Summarise + check understanding",
        full:
          "I would use a structured approach such as SPIKES. I’d ensure privacy, sufficient time, and offer a supporter if the patient wants. I’d explore what they already understand and how much detail they would like. I’d give a warning shot, then explain the diagnosis clearly without jargon, pausing to check understanding. I’d respond to emotion with empathy, summarise key points, and ensure the patient knows what will happen next."
      },
      f1: {
        bullets:
          "• Pause and allow silence\n• Validate feelings\n• Offer tissues/water/support person\n• Assess immediate risk (self-harm if relevant)\n• Arrange follow-up + support services",
        full:
          "If distressed, I would pause, allow silence, acknowledge their feelings and offer support. I’d make sure they are safe, offer a support person, and arrange appropriate follow-up and signposting (CNS, GP, support groups) depending on local pathways."
      },
      f2: {
        bullets:
          "• Respect preference\n• Give essential info only\n• Offer written info\n• Arrange follow-up soon\n• Check consent for involving family",
        full:
          "If they don’t want details, I would respect that while ensuring they understand the essential information and immediate implications. I’d offer written information and arrange a follow-up conversation soon, checking whether they’d like a family member or friend involved."
      },
      f3: {
        bullets:
          "• Confirm immediate plan + referrals\n• Red flags / when to seek help\n• Contact points (CNS, clinic)\n• Document discussion\n• Follow-up appointment",
        full:
          "I would outline the immediate plan (investigations, referral, MDT discussion), give clear safety-net advice and contact points, document what was discussed, and ensure a timely follow-up appointment."
      }
    }
  },

  team_conflict: {
    title: "Team conflict affecting patient care",
    prompts: {
      main: "You notice conflict within the team is starting to affect patient care. What would you do?",
      f1: "What if you raise it informally but it gets ignored?",
      f2: "Why is teamwork important in healthcare?",
      f3: "What behaviours make teams work well under pressure?"
    },
    models: {
      main: {
        bullets:
          "• Recognise patient safety risk\n• Address early, respectfully\n• Focus on shared goal (patient)\n• Facilitate calm discussion\n• Escalate to senior if ongoing\n• Reflect + document if needed",
        full:
          "I would treat this as a patient safety issue. I’d address it early and respectfully, focusing on shared goals and patient care rather than blame. If appropriate, I’d facilitate a calm discussion, encourage clear roles and communication, and involve a senior clinician/line manager if the conflict persists or risks harm."
      },
      f1: {
        bullets:
          "• Escalate via appropriate channel\n• Senior/clinical supervisor/ward manager\n• Datix/incident reporting if safety affected\n• Keep objective examples",
        full:
          "If ignored, I would escalate through appropriate channels such as a senior clinician or ward manager, using objective examples of how care is affected. If patient safety is compromised, I would use incident reporting processes."
      },
      f2: {
        bullets:
          "• Coordination + continuity\n• Fewer errors\n• Faster escalation\n• Better outcomes + experience",
        full:
          "Teamwork improves coordination, reduces errors, supports escalation and continuity of care, and improves patient outcomes and experience."
      },
      f3: {
        bullets:
          "• Clear communication (closed-loop)\n• Respect + psychological safety\n• Role clarity + shared plan\n• Debrief + learning\n• Support under pressure",
        full:
          "Effective teams communicate clearly (including closed-loop communication), maintain mutual respect and psychological safety, have role clarity and shared plans, and use debriefs to learn and improve."
      }
    }
  },

  cultural_refusal: {
    title: "Treatment refusal due to cultural/religious beliefs",
    prompts: {
      main: "A patient refuses an important treatment because of cultural or religious beliefs. How would you approach this?",
      f1: "How would you ensure your communication is culturally safe and the patient feels respected?",
      f2: "If the refusal risks significant harm, how would you explore alternatives and shared decisions?",
      f3: "What would you do to avoid stereotyping or assumptions about the patient’s beliefs?"
    },
    models: {
      main: {
        bullets:
          "• Explore beliefs without assumptions\n• Use interpreter if needed\n• Explain risks/benefits clearly\n• Ask what outcomes matter to them\n• Offer acceptable alternatives\n• Document preferences + plan",
        full:
          "I would start with curiosity and respect, exploring the patient’s beliefs and concerns without assumptions. I’d ensure communication is clear and supported (e.g., interpreter) and explain the risks, benefits and alternatives in an understandable way. I’d ask what matters most to the patient and work towards shared decision-making, including exploring acceptable alternatives. I’d document the discussion, preferences and agreed plan."
      },
      f1: {
        bullets:
          "• Ask open questions; listen\n• Use interpreter, not family\n• Acknowledge beliefs respectfully\n• Check understanding (teach-back)\n• Offer chaplaincy/community support if desired",
        full:
          "Culturally safe communication means listening with open questions, using professional interpreters where needed, acknowledging beliefs respectfully, and checking understanding. I would offer chaplaincy or other support if the patient wants."
      },
      f2: {
        bullets:
          "• Clarify severity/urgency\n• Discuss alternatives + compromises\n• Involve senior/MDT early\n• Capacity assessment if needed\n• Respect autonomy if capacitous",
        full:
          "If significant harm is likely, I would clearly explain the seriousness and explore alternatives or compromises aligned with the patient’s values. I’d involve seniors and the MDT early, assess capacity if relevant, and respect the patient’s decision if they have capacity."
      },
      f3: {
        bullets:
          "• Treat patient as individual\n• Ask, don’t assume\n• Reflect on bias\n• Seek cultural advice appropriately\n• Document patient-specific preferences",
        full:
          "To avoid stereotyping, I’d treat the patient as an individual, ask rather than assume, reflect on my own bias, seek appropriate advice if needed, and document the patient’s specific preferences rather than generalisations."
      }
    }
  },

  consent_understanding: {
    title: "Patient lacks understanding during consent",
    prompts: {
      main: "A patient agrees to a procedure but seems not to understand what it involves. How would you handle this?",
      f1: "How do you assess whether consent is valid?",
      f2: "What would you do if they still do not understand after explanation?",
      f3: "Why is informed consent ethically important?"
    },
    models: {
      main: {
        bullets:
          "• Pause the process\n• Re-explain in plain language\n• Use diagrams/leaflets\n• Teach-back to confirm understanding\n• Check capacity + voluntariness\n• Involve senior if complex",
        full:
          "I would pause and ensure consent is truly informed. I’d re-explain the procedure, risks, benefits and alternatives in plain language, using visuals if helpful, and confirm understanding using teach-back. I’d ensure capacity and voluntariness, and involve a senior clinician if the situation is complex or time-critical."
      },
      f1: {
        bullets:
          "• Capacity\n• Adequate information (risks/benefits/alternatives)\n• Voluntary decision\n• Time to consider + opportunity to ask questions",
        full:
          "Valid consent requires capacity, adequate information about risks/benefits/alternatives, and a voluntary decision without coercion, with time and opportunity for questions."
      },
      f2: {
        bullets:
          "• Try different approach (simplify, interpreter, written info)\n• Involve senior/appropriate clinician\n• Defer if not urgent\n• If no capacity → MCA best interests route",
        full:
          "If understanding remains poor, I’d try alternative explanations, use an interpreter or written material, and involve the senior/most appropriate clinician. If not urgent, I’d defer. If there is no capacity, decisions must follow MCA best-interests processes."
      },
      f3: {
        bullets:
          "• Respects autonomy\n• Prevents harm from uninformed decisions\n• Builds trust\n• Legal/professional requirement",
        full:
          "Informed consent respects autonomy, prevents harm from uninformed decisions, builds trust, and is a core legal and professional requirement."
      }
    }
  },

  relative_requests_information: {
    title: "Relative requests patient information",
    prompts: {
      main: "A patient's relative asks you for details about their condition, but the patient has not consented to share information. How would you respond?",
      f1: "What if the relative insists they have a right to know?",
      f2: "When can confidentiality be breached?",
      f3: "How would you handle this sensitively while maintaining trust?"
    },
    models: {
      main: {
        bullets:
          "• Stay empathetic + acknowledge concern\n• Explain duty of confidentiality\n• Check patient capacity + wishes\n• Offer to speak to patient / get consent\n• Share general info only (if appropriate)\n• Escalate to senior if conflict",
        full:
          "I would acknowledge the relative’s worry while explaining that I have a duty to maintain patient confidentiality. I would check whether the patient has capacity and what they want shared. I’d offer to speak with the patient to seek consent and, if appropriate, arrange a joint conversation. Without consent, I would avoid sharing identifiable clinical details, though I may provide general information about processes and support, and I’d involve a senior if the situation is tense or complex."
      },
      f1: {
        bullets:
          "• Calmly restate confidentiality\n• Explain patient autonomy\n• Offer next steps (seek consent, speak to senior)\n• Do not argue; keep boundaries",
        full:
          "If they insist, I’d calmly restate that confidentiality belongs to the patient and I cannot disclose details without consent. I’d offer constructive next steps such as obtaining the patient’s permission or involving a senior clinician."
      },
      f2: {
        bullets:
          "• Serious risk of harm to patient/others\n• Safeguarding (children/vulnerable adults)\n• Legal requirement (court order)\n• Public interest exceptions\n• Minimum necessary disclosure + document",
        full:
          "Confidentiality may be breached when required by law, for safeguarding, or when there is a serious risk of harm and disclosure is in the public interest. Any disclosure should be the minimum necessary, with senior advice, and documented."
      },
      f3: {
        bullets:
          "• Be kind + validate emotions\n• Offer support resources\n• Explain clearly what you can/can’t share\n• Involve patient where possible\n• Maintain professional, calm tone",
        full:
          "I’d handle this sensitively by validating their concern, explaining clearly what I can and can’t share, offering support resources, and involving the patient wherever possible to maintain trust on all sides."
      }
    }
  }
};
