// New patient: heaviest path — full demographic + insurance intake, then
// the shared scheduling step. Each step = one cached prompt + one
// extraction field.
//
// Insurance is a two-turn sub-flow: coverage TYPE first (comercial vs.
// Reforma / Plan Vital), then the company — the type decides which company
// question is asked and whether the caller gets the "traiga un referido
// vigente de su médico primario" reminder (Plan Vital only, never
// commercial). Callers often name the company while answering the type
// question ("es MCS ClassiCare"); when that happens the company question is
// skipped — the type read-back confirmed both in one turn.

const patients = require('../../db/patients');
const { askAllergies, askReason } = require('../optionalQuestions');

const isVital = (session) => session.data.insuranceType.insurance_type === 'vital';

// "+17875550000" (TwiML caller ID is E.164) -> "7875550000": the DB, the
// digit-group read-back, and sendSms's +1 prefix all expect the 10-digit
// national form.
const nationalDigits = (number) => String(number).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

// Resolve the phone answer to actual digits BEFORE the read-back, so the
// caller always hears the number that will be stored — including the
// caller-ID number they accepted with a bare "sí". A caller ID can be an
// office line or a relative's phone, so it is never committed unheard.
function acceptPhone(db, session, value) {
  if (String(value.phone ?? '').replace(/\D/g, '')) return { ok: true };
  if (value.use_caller_id && session.callerPhone) {
    value.phone = nationalDigits(session.callerPhone);
    return { ok: true };
  }
  // An affirmation with no caller ID to fall back on (blocked caller ID):
  // there is no number to accept, so ask for one outright.
  return { ok: false, promptId: 'ask_phone' };
}

const steps = [
  { field: 'fullName', promptId: 'ask_full_name' },
  { field: 'dob', promptId: 'ask_dob' },
  // Phone is one question with two variants, like insurance below: with a
  // caller ID the caller may just say "sí" to be called at the number
  // they're calling from; without one they have to dictate a number.
  {
    field: 'phone',
    promptId: 'ask_phone_caller_id',
    skip: (s) => !s.callerPhone,
    accept: acceptPhone,
  },
  {
    field: 'phone',
    promptId: 'ask_phone',
    skip: (s) => Boolean(s.callerPhone),
    accept: acceptPhone,
  },
  {
    field: 'insuranceType',
    promptId: 'ask_insurance_type',
    accept(db, session, value) {
      // Carrier that sells both products, no comercial/Vital wording:
      // ask which one instead of guessing (strike-limited like any
      // re-prompt, so a caller who can't say ends at a human). The company
      // name is kept so they don't have to repeat it after clarifying.
      if (value.insurance_type === 'unclear') {
        if (value.provider) session.providerHint = value.provider;
        return { ok: false, promptId: 'clarify_insurance_type' };
      }
      // Merge a company named on the ambiguous first pass into the resolved
      // answer — the read-back then confirms company + type together.
      // Consumed once: if the caller rejects that read-back, the hint is
      // gone and the company gets its own question again.
      if (!value.provider && session.providerHint) {
        value.provider = session.providerHint;
        session.providerHint = null;
      }
      return { ok: true };
    },
    // Company captured here means the company steps below are skipped, so
    // the Vital reminder must play now or never.
    after: (s) => (isVital(s) && s.data.insuranceType.provider ? 'vital_referral_reminder' : null),
  },
  // One company question per coverage type — same field, mutually exclusive
  // skip(), both skipped when the type answer already named the company.
  {
    field: 'insurance',
    promptId: 'ask_insurance',
    skip: (s) => Boolean(s.data.insuranceType.provider) || isVital(s),
  },
  {
    field: 'insurance',
    promptId: 'ask_insurance_vital',
    skip: (s) => Boolean(s.data.insuranceType.provider) || !isVital(s),
    after: () => 'vital_referral_reminder',
  },
  // Optional per deployment (ASK_ALLERGIES / ASK_REASON in .env). A skipped
  // question leaves its column NULL — finalize below must not assume the
  // field exists.
  { field: 'allergies', promptId: 'ask_allergies', skip: () => !askAllergies() },
  { field: 'reason', promptId: 'ask_reason', skip: () => !askReason() },
];

function finalize(db, data, session) {
  const mrn = patients.createPatient(db, {
    firstName: data.fullName.first_name,
    lastName: data.fullName.last_name,
    dob: data.dob.dob,
    phone: String(data.phone.phone).replace(/\D/g, ''),
    insuranceProvider: data.insurance?.provider ?? data.insuranceType.provider,
    policyNumber: data.insurance?.policy_number,
    groupNumber: data.insurance?.group_number,
    allergies: data.allergies?.allergies ?? null,
  });
  return {
    mrn,
    reason: data.reason?.reason ?? null,
    reasonTranscript: session.transcripts.reason ?? null,
    smsPhone: String(data.phone.phone).replace(/\D/g, ''),
  };
}

module.exports = { patientType: 'new', steps, finalize };
