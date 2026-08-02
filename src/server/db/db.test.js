const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('./index');
const patients = require('./patients');
const appointments = require('./appointments');

let db;
beforeEach(() => {
  db = openDb(':memory:');
});

test('create + lookup patient by MRN', () => {
  const mrn = patients.createPatient(db, {
    firstName: 'María', lastName: 'García', dob: '1985-03-12',
    phone: '555-123-4567', insuranceProvider: 'Aetna',
  });
  const row = patients.findByMrn(db, mrn);
  assert.strictEqual(row.first_name, 'María');
  assert.strictEqual(row.insurance_provider, 'Aetna');
  assert.match(mrn, /^P\d{6}$/);
});

test('lookup by phone ignores formatting differences', () => {
  patients.createPatient(db, { firstName: 'José', lastName: 'Luna', phone: '(555) 987-6543' });
  const row = patients.findByPhone(db, '5559876543');
  assert.strictEqual(row.first_name, 'José');
  assert.strictEqual(patients.findByPhone(db, '5550000000'), null);
  assert.strictEqual(patients.findByPhone(db, '123'), null, 'too-short numbers never match');
});

test('findOpenSlotsBetween: same-day slots respect the lead-time cutoff', () => {
  const friday8am = new Date(2026, 6, 24, 8, 0); // Friday, local
  let slots = appointments.findOpenSlotsBetween(db, {
    from: friday8am, to: friday8am, now: friday8am, count: 3,
  });
  assert.deepStrictEqual(slots.map((s) => s.time), ['09:00', '11:00', '14:00']);
  assert.ok(slots.every((s) => s.date === '2026-07-24'));

  // at 10:30, the 11:00 slot is under an hour away — only 14:00 remains
  const friday1030 = new Date(2026, 6, 24, 10, 30);
  slots = appointments.findOpenSlotsBetween(db, {
    from: friday1030, to: friday1030, now: friday1030, count: 3,
  });
  assert.deepStrictEqual(slots.map((s) => s.time), ['14:00']);
});

test('findOpenSlotsBetween: weekends yield nothing, booked slots are skipped', () => {
  const now = new Date(2026, 6, 24, 8, 0);
  const sat = new Date(2026, 6, 25);
  const sun = new Date(2026, 6, 26);
  assert.deepStrictEqual(
    appointments.findOpenSlotsBetween(db, { from: sat, to: sun, now, count: 3 }), [],
  );

  for (const time of appointments.SLOT_TIMES) {
    appointments.bookAppointment(db, { patientType: 'new', date: '2026-07-27', time });
  }
  const week = appointments.findOpenSlotsBetween(db, {
    from: new Date(2026, 6, 27), to: new Date(2026, 6, 31), now, count: 2,
  });
  assert.ok(week.every((s) => s.date !== '2026-07-27'), 'fully booked Monday is skipped');
  // distinct days preferred: Tuesday + Wednesday, not two Tuesday times
  assert.deepStrictEqual(week.map((s) => s.date), ['2026-07-28', '2026-07-29']);
});

test('bookAppointment stores confidence, patient type, and the reason', () => {
  const mrn = patients.createPatient(db, { firstName: 'Luz' });
  const id = appointments.bookAppointment(db, {
    mrn, patientType: 'follow_up', date: '2026-08-03', time: '09:00',
    reason: 'revisión de rutina',
    extractionConfidence: 0.91,
  });
  const row = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
  assert.strictEqual(row.patient_type, 'follow_up');
  assert.strictEqual(row.extraction_confidence, 0.91);
  assert.strictEqual(row.reason, 'revisión de rutina');
});

test('patient_type CHECK constraint rejects unknown types', () => {
  assert.throws(() => appointments.bookAppointment(db, {
    patientType: 'walk_in', date: '2026-08-03', time: '09:00',
  }));
});
