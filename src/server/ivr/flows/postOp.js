// Post-op: administrative rebooking only — date of the operation, the
// hospital where it was done, name, phone, then the shared scheduling step.
// No symptom check on this path (clinic decision, 2026-07-30): a post-op
// caller is booking a follow-up visit, not being screened.
//
// Prototype note: there's no procedures table yet, so the surgery date and
// hospital are recorded in the appointment reason rather than used for a
// lookup.

const patients = require('../../db/patients');
const { phoneSteps } = require('./phoneSteps');

const steps = [
  { field: 'surgeryDate', promptId: 'ask_surgery_date' },
  { field: 'hospital', promptId: 'ask_hospital' },
  { field: 'fullName', promptId: 'ask_postop_full_name' },
  ...phoneSteps,
];

function finalize(db, data) {
  const phone = String(data.phone.phone).replace(/\D/g, '');
  // A post-op caller usually already has a record from their surgery
  // work-up — book against it when the phone matches instead of minting
  // a duplicate row.
  const existing = patients.findByPhone(db, phone);
  const mrn = existing ? existing.mrn : patients.createPatient(db, {
    firstName: data.fullName.first_name,
    lastName: data.fullName.last_name,
    phone,
  });
  return {
    mrn,
    reason: `control postoperatorio (cirugía ${data.surgeryDate.date}, ${data.hospital.hospital})`,
    smsPhone: phone,
  };
}

module.exports = { patientType: 'post_op', steps, finalize };
