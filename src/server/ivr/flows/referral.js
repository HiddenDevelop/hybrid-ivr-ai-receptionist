// Referral: check for an existing MRN first (per CLAUDE.md — don't treat a
// known patient as brand-new), then authorization, referring provider, and
// procedure. Unlike follow-up, a missed lookup is fine: the caller may
// genuinely be new to the clinic, so accept() never rejects.

const patients = require('../../db/patients');

const steps = [
  {
    field: 'mrnOrPhone',
    promptId: 'ask_mrn_or_phone',
    accept(db, session, value) {
      session.patient = (value.mrn && patients.findByMrn(db, String(value.mrn).toUpperCase().replace(/\s/g, '')))
        || (value.phone && patients.findByPhone(db, value.phone))
        || null;
      return { ok: true };
    },
  },
  { field: 'authorization', promptId: 'ask_authorization' },
  { field: 'referringProvider', promptId: 'ask_referring_provider' },
  { field: 'procedureType', promptId: 'ask_procedure' },
];

function finalize(db, data, session) {
  const mrn = session.patient
    ? session.patient.mrn
    : patients.createPatient(db, {
      phone: data.mrnOrPhone.phone ? String(data.mrnOrPhone.phone).replace(/\D/g, '') : null,
    });
  patients.createReferral(db, {
    mrn,
    referringProvider: data.referringProvider.provider_name,
    referringFax: data.referringProvider.fax,
    authorizationCode: data.authorization.authorization_code,
    procedureType: data.procedureType.procedure,
  });
  return {
    mrn,
    reason: `referencia: ${data.procedureType.procedure}`,
    smsPhone: session.patient ? session.patient.phone : data.mrnOrPhone.phone,
  };
}

module.exports = { patientType: 'referral', steps, finalize };
