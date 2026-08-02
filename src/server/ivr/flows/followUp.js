// Follow-up: name, phone, and plan type (comercial vs. Reforma / Plan
// Vital), then the shared scheduling step. No record lookup and no reason
// question (clinic decision, 2026-07-30) — the booking reuses the record
// whose phone matches, like the post-op flow, else creates one. Vital
// callers get the referido reminder right after the type lands; there is
// no company question on this path, so the reminder never defers.

const patients = require('../../db/patients');
const { phoneSteps } = require('./phoneSteps');
const { acceptInsuranceType } = require('./insuranceTypeStep');

const steps = [
  { field: 'fullName', promptId: 'ask_full_name' },
  ...phoneSteps,
  {
    field: 'insuranceType',
    promptId: 'ask_insurance_type',
    accept: acceptInsuranceType, // shared with new patient (insuranceTypeStep.js)
    after: (s) => (s.data.insuranceType.insurance_type === 'vital' ? 'vital_referral_reminder' : null),
  },
];

function finalize(db, data) {
  const phone = String(data.phone.phone).replace(/\D/g, '');
  const existing = patients.findByPhone(db, phone);
  const mrn = existing ? existing.mrn : patients.createPatient(db, {
    firstName: data.fullName.first_name,
    lastName: data.fullName.last_name,
    phone,
    // Only lands when the caller named the company alongside the type
    // ("tengo Triple-S Vital") — there's no dedicated company question.
    insuranceProvider: data.insuranceType.provider ?? null,
  });
  return { mrn, reason: null, smsPhone: phone };
}

module.exports = { patientType: 'follow_up', steps, finalize };
