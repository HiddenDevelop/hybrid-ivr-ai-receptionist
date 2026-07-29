// Post-op: surgery date + symptom check, then a follow-up booking.
//
// The red-flag gate does NOT live here — the session engine runs
// checkRedFlags() on every raw transcript in every flow before any
// extraction call (see session.js). By the time the symptoms extraction
// runs, the transcript has already been declared non-emergency by plain
// code; the extraction below only fills in the structured symptom row.
//
// Prototype note: there's no procedures table yet, so the surgery date is
// recorded in the appointment reason rather than used for a lookup.

const steps = [
  { field: 'surgeryDate', promptId: 'ask_surgery_date' },
  {
    field: 'symptoms',
    promptId: 'ask_symptoms',
    // Backstop behind the keyword gate: if the STRUCTURED extraction says
    // fever/bleeding/drain trouble/severe pain, that's an on-call matter,
    // not a booking — even though the raw transcript slipped past
    // redFlags.js. Two independent nets, both outside the model's control.
    accept(db, session, value) {
      if (value.fever || value.bleeding || value.drain_concern || value.pain_level >= 8) {
        return { escalate: 'symptom_report' };
      }
      return { ok: true };
    },
  },
];

function finalize(db, data) {
  const s = data.symptoms;
  return {
    mrn: null, // no identifying field collected on this path yet (prototype)
    reason: `control postoperatorio (cirugía ${data.surgeryDate.date}); `
      + `fiebre=${s.fever} sangrado=${s.bleeding} drenaje=${s.drain_concern} dolor=${s.pain_level}`,
    smsPhone: null,
  };
}

module.exports = { patientType: 'post_op', steps, finalize };
