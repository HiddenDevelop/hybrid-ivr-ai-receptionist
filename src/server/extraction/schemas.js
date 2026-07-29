// Per-field extraction specs. Each spec is one short instruction line plus
// a JSON schema sketch — the ENTIRE prompt stays ~50 tokens in / ~10 out;
// that's the latency win the whole design rests on. Instructions are in
// English (internal, never heard by the caller); transcripts are Spanish;
// values read back to the caller get formatted in Spanish by the flow layer.
//
// `validate` is a cheap sanity check on the parsed JSON (shape, ranges).
// It does NOT judge transcription quality — that's what the model's
// self-reported confidence is for.

const specs = {
  patientType: {
    instruction: "Classify the caller's answer as a clinic patient type.",
    schema: '{"patient_type": "new"|"follow_up"|"post_op"|"referral"|"unknown", "confidence": number}',
    validate: (v) => ['new', 'follow_up', 'post_op', 'referral', 'unknown'].includes(v.patient_type),
  },
  fullName: {
    // The "was asked ... and answered" framing is load-bearing: callers
    // answer "¿su nombre completo?" with the bare name and nothing else,
    // and without this the model reads a bare name as a fragment that
    // contains no answer and returns empty strings at confidence 0.
    instruction: 'The caller was asked for their full name and answered. Extract it. '
      + 'The transcript is often just the bare name, with no sentence around it.',
    schema: '{"first_name": string, "last_name": string, "confidence": number}',
    // Both parts must be non-empty: a lone surname ("Soto") otherwise
    // passes shape validation at high confidence and writes a patient row
    // with a blank first name instead of re-prompting.
    validate: (v) => typeof v.first_name === 'string' && v.first_name.trim().length > 0
      && typeof v.last_name === 'string' && v.last_name.trim().length > 0,
  },
  dob: {
    instruction: "Extract the caller's date of birth as an ISO date.",
    schema: '{"dob": "YYYY-MM-DD", "confidence": number}',
    validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v.dob || ''),
  },
  phone: {
    // When Twilio delivered a caller ID, the prompt offers the number the
    // caller is calling from — so an affirmation ("sí", "ese mismo", "a
    // este mismo") is a valid answer with no digits in it. The flow's
    // accept() resolves use_caller_id into the actual caller-ID digits
    // (flows/newPatient.js) before the read-back.
    instruction: 'The caller was asked for a contact phone number, or to say yes to be called '
      + 'at the number they are calling from. If they said a number, extract it digits-only '
      + 'with use_caller_id false. If they agreed to use the number they are calling from '
      + '("sí", "ese mismo", "a este mismo número"), set use_caller_id true and phone null.',
    schema: '{"phone": string|null, "use_caller_id": boolean, "confidence": number}',
    validate: (v) => v.use_caller_id === true
      || /^\d{7,15}$/.test(String(v.phone || '').replace(/\D/g, '')),
  },
  insuranceType: {
    // Intent classification, not string matching: Puerto Rico callers
    // answer this dozens of ways ("privado", "del trabajo", "mi plan del
    // gobierno", a bare product name). The one trap is carriers that sell
    // BOTH commercial and Vital products — a bare carrier name must come
    // back "unclear" so the flow asks a clarification question instead of
    // guessing (a wrong guess either skips or wrongly adds the referral
    // reminder). MMM/Humana note: per the clinic's rule MMM classifies as
    // vital; plain Humana is commercial.
    instruction: 'The caller was asked if their Puerto Rico health plan is commercial insurance '
      + 'or Reforma / Plan Vital (government Medicaid). Classify the answer. '
      + '"commercial": comercial, privado, del trabajo/patrono, or a commercial product '
      + '(e.g. Triple-S Advantage, MCS ClassiCare, Humana). '
      + '"vital": Reforma, (Plan) Vital, Medicaid, plan del gobierno, MMM, or a Vital/Reforma product '
      + '(e.g. Triple-S Vital, MCS Vital, First Medical Vital, Menonita Reforma). '
      + '"unclear": ONLY a carrier that sells both (Triple-S, MCS, First Medical, IMC, Menonita) '
      + 'with no commercial/Vital wording. '
      + "Set provider to the company name if one was said (normalize 'triple ese' to Triple-S), else null.",
    schema: '{"insurance_type": "commercial"|"vital"|"unclear", "provider": string|null, "confidence": number}',
    validate: (v) => ['commercial', 'vital', 'unclear'].includes(v.insurance_type),
  },
  insurance: {
    // Plan NAME only — the clinic decided not to collect policy/group
    // numbers over the phone. The caller base is Puerto Rico — help the
    // model normalize plan names it hears phonetically ("triple ese").
    // Asked only when insuranceType above didn't already capture the name.
    instruction: "Extract the caller's health plan name (any insurer counts). "
      + "Frequent Puerto Rico plans, for normalizing what you hear: Triple-S (spoken 'triple ese'), MCS, First Medical, Plan Vital, MMM, Humana, Molina.",
    schema: '{"provider": string, "confidence": number}',
    validate: (v) => typeof v.provider === 'string' && v.provider.length > 0,
  },
  allergies: {
    instruction: 'Extract any medication allergies; use "ninguna" if the caller has none.',
    schema: '{"allergies": string, "confidence": number}',
    validate: (v) => typeof v.allergies === 'string' && v.allergies.length > 0,
  },
  reason: {
    // The extracted reason is read straight back to the caller by the
    // Spanish TTS voice, so it must stay in the caller's own Spanish words
    // — without the "never translate" clause qwen returns it in English
    // ("hernia check-up"), which the Spanish voice mangles mid-sentence.
    // This is also the most permissive field in the call: any stated reason
    // is a valid answer, so the model is told to accept vague/brief ones
    // and the confidence bar is lowered (minConfidence below).
    //
    // Deliberately free text, no categories: the reason is the caller's own
    // words minus filler, nothing more. The verbatim transcript it came from
    // is stored alongside it (appointments.reason_transcript), so staff can
    // always see exactly what was said — which is why no routine/concerning
    // or category field belongs here.
    instruction: 'Extract the reason for the visit. '
      + "Quote it in Spanish, using the caller's own words with filler removed — never translate it to English, "
      + 'and never reduce it to a category. '
      + 'Any stated reason counts, even a brief or vague one ("una consulta", "me duele el estómago").',
    schema: '{"reason": string, "confidence": number}',
    validate: (v) => typeof v.reason === 'string' && v.reason.trim().length > 0,
    minConfidence: 0.5,
  },
  mrnOrPhone: {
    instruction: 'Extract the medical record number (MRN) or phone number the caller gave; leave the other null.',
    schema: '{"mrn": string|null, "phone": string|null, "confidence": number}',
    validate: (v) => Boolean(v.mrn) || /^\d{7,15}$/.test(String(v.phone || '').replace(/\D/g, '')),
  },
  surgeryDate: {
    instruction: "Extract the date of the caller's surgery as an ISO date.",
    schema: '{"date": "YYYY-MM-DD", "confidence": number}',
    validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v.date || ''),
    needsToday: true, // "la semana pasada"/"este año" are relative — anchor them
  },
  symptoms: {
    instruction: 'Extract the post-op symptom report: fever, bleeding, drain concerns, pain level 0-10. Use false for anything not mentioned.',
    schema: '{"fever": boolean, "bleeding": boolean, "drain_concern": boolean, "pain_level": number, "confidence": number}',
    validate: (v) => [v.fever, v.bleeding, v.drain_concern].every((b) => typeof b === 'boolean')
      && typeof v.pain_level === 'number' && v.pain_level >= 0 && v.pain_level <= 10,
  },
  authorization: {
    instruction: 'Extract whether the caller has an insurance authorization and its code if given.',
    schema: '{"has_authorization": boolean, "authorization_code": string|null, "confidence": number}',
    validate: (v) => typeof v.has_authorization === 'boolean',
  },
  referringProvider: {
    // Name only — fax is no longer collected over the phone.
    instruction: "Extract the referring provider's name.",
    schema: '{"provider_name": string, "confidence": number}',
    validate: (v) => typeof v.provider_name === 'string' && v.provider_name.length > 0,
  },
  schedWindow: {
    instruction: 'The caller was asked when they want their appointment: today, this week, next week, or a specific date. Classify the answer; include the date only if they named one.',
    schema: '{"window": "today"|"this_week"|"next_week"|"specific"|"unknown", "date": "YYYY-MM-DD"|null, "confidence": number}',
    validate: (v) => ['today', 'this_week', 'next_week', 'specific', 'unknown'].includes(v.window),
    needsToday: true,
  },
  preferredDate: {
    instruction: 'Extract the appointment date the caller wants as an ISO date.',
    schema: '{"date": "YYYY-MM-DD", "confidence": number}',
    validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v.date || ''),
    needsToday: true,
  },
  procedureType: {
    instruction: 'Extract the procedure or consultation type being referred for.',
    schema: '{"procedure": string, "confidence": number}',
    validate: (v) => typeof v.procedure === 'string' && v.procedure.length > 0,
  },
  slotChoice: {
    // "neither" is a real answer (the caller declines both slots and gets
    // re-asked for a window), distinct from "unknown" (unclear, costs a
    // strike) — conflating them either punishes a clear decline or sends a
    // garbled answer down the decline path. Used only for TWO-slot offers;
    // a single-slot offer is a yes/no question and uses yesNo instead.
    instruction: 'The caller was offered appointment option 1 and option 2 and asked to choose. '
      + 'Classify the answer: "first", "second", "neither" if they decline both, or "unknown" if unclear.',
    schema: '{"choice": "first"|"second"|"neither"|"unknown", "confidence": number}',
    validate: (v) => ['first', 'second', 'neither', 'unknown'].includes(v.choice),
  },
  yesNo: {
    // "unknown" is load-bearing: with a bare boolean the model HAS to pick
    // a side on non-answers — a barge-in fragment, a cough, or the Whisper
    // near-silence hallucination "Gracias." — and a fabricated "no" at a
    // read-back silently discards a value the caller had gotten right.
    // Unknown costs a strike, which replays the read-back: self-healing.
    instruction: 'Did the caller answer yes or no? Use "unknown" unless they clearly '
      + 'affirmed ("sí", "correcto", "está bien") or denied ("no", "está mal", "no es así").',
    schema: '{"answer": "yes"|"no"|"unknown", "confidence": number}',
    validate: (v) => ['yes', 'no', 'unknown'].includes(v.answer),
  },
};

module.exports = { specs };
