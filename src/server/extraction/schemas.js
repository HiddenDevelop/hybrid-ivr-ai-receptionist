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
    // Digits only: the caller-ID offer is a separate keypad question
    // (flows/phoneSteps.js), so by the time this runs the caller is
    // dictating an actual number. An affirmation with no digits ("sí, a
    // este mismo") must fail validation and re-prompt, never fabricate.
    instruction: 'The caller was asked for a contact phone number and dictated one. '
      + 'Extract it digits-only.',
    schema: '{"phone": string, "confidence": number}',
    validate: (v) => /^\d{7,15}$/.test(String(v.phone || '').replace(/\D/g, '')),
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
  surgeryDate: {
    instruction: "Extract the date of the caller's surgery as an ISO date.",
    schema: '{"date": "YYYY-MM-DD", "confidence": number}',
    validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v.date || ''),
    needsToday: true, // "la semana pasada"/"este año" are relative — anchor them
  },
  hospital: {
    // Same "was asked ... and answered" framing as fullName: the answer is
    // usually just the bare hospital name.
    instruction: 'The caller was asked at which hospital their surgery was performed and answered. '
      + "Extract the hospital name in the caller's Spanish words — never translate it. "
      + 'The transcript is often just the bare name, with no sentence around it.',
    schema: '{"hospital": string, "confidence": number}',
    validate: (v) => typeof v.hospital === 'string' && v.hospital.trim().length > 0,
  },
  preferredDate: {
    instruction: 'Extract the appointment date the caller wants as an ISO date.',
    schema: '{"date": "YYYY-MM-DD", "confidence": number}',
    validate: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v.date || ''),
    needsToday: true,
  },
};

module.exports = { specs };
