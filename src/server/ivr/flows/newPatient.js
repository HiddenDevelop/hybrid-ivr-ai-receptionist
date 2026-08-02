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
const { phoneSteps } = require('./phoneSteps');
const { acceptInsuranceType } = require('./insuranceTypeStep');

const isVital = (session) => session.data.insuranceType.insurance_type === 'vital';

const steps = [
  { field: 'fullName', promptId: 'ask_full_name' },
  { field: 'dob', promptId: 'ask_dob' },
  // Phone is one question with two variants, like insurance below — see
  // phoneSteps.js (shared with the post-op flow).
  ...phoneSteps,
  {
    field: 'insuranceType',
    promptId: 'ask_insurance_type',
    accept: acceptInsuranceType, // shared with follow-up (insuranceTypeStep.js)
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
];

function finalize(db, data) {
  const mrn = patients.createPatient(db, {
    firstName: data.fullName.first_name,
    lastName: data.fullName.last_name,
    dob: data.dob.dob,
    phone: String(data.phone.phone).replace(/\D/g, ''),
    insuranceProvider: data.insurance?.provider ?? data.insuranceType.provider,
  });
  return {
    mrn,
    smsPhone: String(data.phone.phone).replace(/\D/g, ''),
  };
}

module.exports = { patientType: 'new', steps, finalize };
