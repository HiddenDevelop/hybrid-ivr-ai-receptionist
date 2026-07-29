const crypto = require('node:crypto');

// Prototype MRN: random, prefixed, collision-checked. A real MRN scheme is
// an EHR concern — out of scope until that phase.
function generateMrn(db) {
  for (;;) {
    const mrn = `P${crypto.randomInt(100000, 999999)}`;
    const exists = db.prepare('SELECT 1 FROM patients WHERE mrn = ?').get(mrn);
    if (!exists) return mrn;
  }
}

function createPatient(db, fields) {
  const mrn = fields.mrn || generateMrn(db);
  db.prepare(`
    INSERT INTO patients (mrn, first_name, last_name, dob, phone,
      insurance_provider, policy_number, group_number, allergies)
    VALUES (@mrn, @firstName, @lastName, @dob, @phone,
      @insuranceProvider, @policyNumber, @groupNumber, @allergies)
  `).run({
    mrn,
    firstName: fields.firstName ?? null,
    lastName: fields.lastName ?? null,
    dob: fields.dob ?? null,
    phone: fields.phone ?? null,
    insuranceProvider: fields.insuranceProvider ?? null,
    policyNumber: fields.policyNumber ?? null,
    groupNumber: fields.groupNumber ?? null,
    allergies: fields.allergies ?? null,
  });
  return mrn;
}

function findByMrn(db, mrn) {
  return db.prepare('SELECT * FROM patients WHERE mrn = ?').get(mrn) ?? null;
}

// Phone lookup ignores formatting: matches on the last 10 digits so
// "el cinco cinco cinco..." transcribed with spaces/dashes still resolves.
function findByPhone(db, phone) {
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  if (digits.length < 7) return null;
  const rows = db.prepare('SELECT * FROM patients WHERE phone IS NOT NULL').all();
  return rows.find((r) => String(r.phone).replace(/\D/g, '').slice(-10) === digits) ?? null;
}

function createReferral(db, fields) {
  const info = db.prepare(`
    INSERT INTO referrals (mrn, referring_provider, referring_fax, authorization_code, procedure_type)
    VALUES (@mrn, @referringProvider, @referringFax, @authorizationCode, @procedureType)
  `).run({
    mrn: fields.mrn ?? null,
    referringProvider: fields.referringProvider ?? null,
    referringFax: fields.referringFax ?? null,
    authorizationCode: fields.authorizationCode ?? null,
    procedureType: fields.procedureType ?? null,
  });
  return info.lastInsertRowid;
}

module.exports = { createPatient, findByMrn, findByPhone, createReferral, generateMrn };
