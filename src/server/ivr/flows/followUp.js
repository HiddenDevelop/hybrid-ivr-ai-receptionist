// Follow-up: lightest path — find the existing record, get the reason,
// schedule. The MRN/phone step does a DB lookup inside accept(): an
// extraction can be perfectly confident and still not match a record, and
// that case gets its own prompt (record_not_found), not the generic one.

const patients = require('../../db/patients');
const { askReason } = require('../optionalQuestions');

const steps = [
  {
    field: 'mrnOrPhone',
    promptId: 'ask_mrn_or_phone',
    accept(db, session, value) {
      const found = (value.mrn && patients.findByMrn(db, String(value.mrn).toUpperCase().replace(/\s/g, '')))
        || (value.phone && patients.findByPhone(db, value.phone));
      if (!found) return { ok: false, promptId: 'record_not_found' };
      session.patient = found;
      return { ok: true };
    },
  },
  // Same ASK_REASON switch as the new-patient flow — it controls the
  // "motivo de su cita" question wherever it is asked. With it off, this
  // flow is just the record lookup straight into scheduling.
  { field: 'reason', promptId: 'ask_followup_reason', skip: () => !askReason() },
];

function finalize(db, data, session) {
  return {
    mrn: session.patient.mrn,
    reason: data.reason?.reason ?? null,
    reasonTranscript: session.transcripts.reason ?? null,
    smsPhone: session.patient.phone,
  };
}

module.exports = { patientType: 'follow_up', steps, finalize };
