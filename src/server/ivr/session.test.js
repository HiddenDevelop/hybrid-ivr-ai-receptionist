const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../db/index');
const patients = require('../db/patients');
const appointments = require('../db/appointments');
const { CallSession } = require('./session');
const { FLOWS } = require('./menu');
const { PROMPTS } = require('../prompts');
const { isConfident } = require('../extraction/extract');

// Scripted extraction double: pops pre-programmed results in order and
// records every call, so tests can assert the LLM was (or wasn't) invoked.
function fakeExtract(script) {
  const calls = [];
  return {
    calls,
    isConfident,
    async extractField(field, transcript) {
      calls.push({ field, transcript });
      const next = script.shift();
      if (!next) throw new Error(`fakeExtract script exhausted at field ${field}`);
      assert.strictEqual(field, next.field, `expected extraction of ${next.field}, got ${field}`);
      return { ok: next.ok ?? true, value: next.value ?? null, confidence: next.confidence ?? 0.95, latencyMs: 1 };
    },
  };
}

const FIXED_NOW = () => new Date(2026, 6, 24, 8, 0, 0); // Friday 8:00am, local clinic time

let db;
beforeEach(() => {
  db = openDb(':memory:');
});

function playIds(actions) {
  return actions.filter((a) => a.type === 'play').map((a) => a.promptId);
}

function readbackText(actions) {
  return actions.find((a) => a.type === 'playText')?.text;
}

// Every collected field is now read back to the caller and kept only once
// they confirm it. Tests that aren't about the read-back itself answer the
// question and then confirm with the keypad (1 = sí), which — unlike a
// spoken "sí" — costs no extraction call and so leaves the scripted
// fakeExtract sequence untouched.
async function say(session, transcript) {
  const actions = await session.onTranscript(transcript);
  if (session.state !== 'verify') return actions;
  return session.onDtmf(1);
}

test('every promptId referenced by flows and engine exists in PROMPTS (cache coverage)', () => {
  const referenced = new Set([
    'greeting_menu', 'menu_retry', 'reprompt_generic', 'handoff_human',
    'handoff_operator', 'confirm_field', 'retry_field',
    'escalate_red_flag', 'slots_none', 'booking_confirmed_sms', 'goodbye',
    'ask_sched_window', 'ask_preferred_date', 'slots_none_window', 'date_in_past',
    // referenced from step hooks (accept()/after()), not step.promptId
    'clarify_insurance_type', 'vital_referral_reminder',
  ]);
  for (const flow of Object.values(FLOWS)) {
    for (const step of flow.steps) {
      referenced.add(step.promptId);
      if (step.field === 'mrnOrPhone' && flow.patientType === 'follow_up') referenced.add('record_not_found');
    }
  }
  for (const id of referenced) {
    assert.ok(PROMPTS[id], `prompt id "${id}" missing from PROMPTS — cache would have a hole`);
  }
});

// index.js sizes each turn's TurnDetector from this: "open" tolerates a 1.8s
// pause mid-answer (elderly callers pause while recalling names and digits),
// "short" keeps the original 800ms where the answer is one word. Getting a
// collection step marked "short" silently reintroduces the clipping bug.
test('turnProfile: open while collecting or composing a date, short elsewhere', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1985-03-12' } },
    { field: 'phone', value: { phone: '5551234567' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: null } },
    { field: 'insurance', value: { provider: 'Aetna' } },
    { field: 'allergies', value: { allergies: 'ninguna' } },
    { field: 'reason', value: { reason: 'dolor abdominal' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });

  session.start();
  assert.strictEqual(session.turnProfile, 'short', 'menu: one keypress or one word');

  session.onDtmf(1); // new patient -> collect
  assert.strictEqual(session.turnProfile, 'open', 'collect: caller composes the answer aloud');
  await session.onTranscript('me llamo María García'); // -> verify (read-back)
  assert.strictEqual(session.turnProfile, 'short', 'verify: sí/no answer to the read-back');
  session.onDtmf(1); // confirmed -> next field
  assert.strictEqual(session.turnProfile, 'open', 'still collecting after a field lands');

  for (const t of ['doce de marzo del ochenta y cinco', 'cinco cinco cinco', 'es comercial', 'Aetna', 'ninguna']) {
    await say(session, t);
  }
  await say(session, 'dolor abdominal'); // last field -> sched_window
  assert.strictEqual(session.turnProfile, 'short', 'sched_window: menu-shaped answer');

  session.onDtmf(4); // "suggest a date" -> sched_date
  assert.strictEqual(session.turnProfile, 'open', 'sched_date: spoken date, caller may hesitate');
});

test('turnProfile: short at the slot offer and the confirmation', async () => {
  const extract = fakeExtract([
    { field: 'mrnOrPhone', value: { mrn: null, phone: '5559876543' } },
    { field: 'reason', value: { reason: 'revisión' } },
    { field: 'slotChoice', value: { choice: 'first' } },
  ]);
  patients.createPatient(db, { firstName: 'José', lastName: 'Luna', phone: '5559876543' });
  const session = new CallSession({ db, now: FIXED_NOW, extract });

  session.start();
  session.onDtmf(2); // follow-up
  await say(session, 'cinco cinco cinco nueve ocho siete seis cinco cuatro tres');
  await say(session, 'revisión de rutina');
  session.onDtmf(3); // next week -> offer
  assert.strictEqual(session.turnProfile, 'short', 'offer: "la primera"/"la segunda"');

  await session.onTranscript('la primera'); // -> confirm
  assert.strictEqual(session.turnProfile, 'short', 'confirm: sí/no must stay snappy');
});

test('new patient: full path lands patient + appointment + Spanish SMS', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1985-03-12' } },
    { field: 'phone', value: { phone: '5551234567' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: null } },
    { field: 'insurance', value: { provider: 'Aetna', policy_number: 'AB123', group_number: null } },
    { field: 'allergies', value: { allergies: 'penicilina' }, confidence: 0.8 },
    // Extracted reason = caller's words minus filler; the verbatim
    // transcript is stored alongside it (asserted on the row below).
    { field: 'reason', value: { reason: 'dolor abdominal leve' } },
    { field: 'slotChoice', value: { choice: 'first' } },
    { field: 'yesNo', value: { answer: 'yes' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });

  assert.deepStrictEqual(playIds(session.start()), ['greeting_menu']);
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_full_name']);

  await say(session, 'me llamo María García');
  await say(session, 'doce de marzo del ochenta y cinco');
  await say(session, 'cinco cinco cinco...');
  const companyQuestion = await say(session, 'es un seguro comercial, del trabajo');
  assert.deepStrictEqual(playIds(companyQuestion), ['ask_insurance'],
    'commercial type -> commercial company question, no Vital detour, no reminder');
  await say(session, 'tengo Aetna');
  await say(session, 'penicilina');

  // after last field: broad "when?" question first
  const windowActions = await say(session, 'eh pues... tengo un dolor abdominal leve');
  assert.deepStrictEqual(playIds(windowActions), ['ask_sched_window']);

  // "next week" narrows to concrete slots, offered in Spanish
  const offerActions = session.onDtmf(3);
  const offer = offerActions.find((a) => a.type === 'playText');
  assert.match(offer.text, /lunes 27 de julio/);

  const confirmActions = await session.onTranscript('la primera');
  assert.match(confirmActions.find((a) => a.type === 'playText').text, /¿Se la confirmo\?/);

  const finalActions = await session.onTranscript('sí, confirmo');
  const sms = finalActions.find((a) => a.type === 'sms');
  assert.strictEqual(sms.to, '5551234567');
  assert.match(sms.text, /cita quedó confirmada/);
  assert.ok(finalActions.some((a) => a.type === 'hangup'));

  const patient = db.prepare("SELECT * FROM patients WHERE first_name = 'María'").get();
  assert.strictEqual(patient.allergies, 'penicilina');
  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.patient_type, 'new');
  assert.strictEqual(appt.mrn, patient.mrn);
  assert.strictEqual(appt.scheduled_date, '2026-07-27');
  assert.strictEqual(appt.extraction_confidence, 0.8, 'stores the MINIMUM field confidence');
  assert.strictEqual(appt.reason, 'dolor abdominal leve', 'clean free-text reason, no category');
  assert.strictEqual(
    appt.reason_transcript, 'eh pues... tengo un dolor abdominal leve',
    'verbatim transcript stored next to the cleaned reason',
  );
});

test('phone with caller ID: "sí" adopts the calling number, read back before kept', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
    { field: 'phone', value: { phone: null, use_caller_id: true } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '+17875550000' });
  session.start();
  session.onDtmf(1);
  await say(session, 'María García');
  const phoneQuestion = await say(session, 'doce de marzo del treinta y ocho');
  assert.deepStrictEqual(playIds(phoneQuestion), ['ask_phone_caller_id'],
    'caller ID present -> the offer variant, not the dictate-a-number question');

  const verify = await session.onTranscript('sí, a este mismo número');
  assert.strictEqual(session.state, 'verify',
    'the caller-ID number still goes through the read-back, never committed unheard');
  assert.match(readbackText(verify), /7 8 7, 5 5 5, 0 0 0 0/,
    'E.164 caller ID read back as 10-digit national, digit by digit');

  session.onDtmf(1); // sí
  assert.strictEqual(session.data.phone.phone, '7875550000');
});

test('phone with caller ID: dictating a different number still works', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
    { field: 'phone', value: { phone: '9395551234', use_caller_id: false } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '+17875550000' });
  session.start();
  session.onDtmf(1);
  await say(session, 'María García');
  await say(session, 'doce de marzo del treinta y ocho');

  const verify = await session.onTranscript('no, mejor al nueve tres nueve...');
  assert.match(readbackText(verify), /9 3 9, 5 5 5, 1 2 3 4/);
  session.onDtmf(1);
  assert.strictEqual(session.data.phone.phone, '9395551234');
});

test('phone without caller ID: plain question, and a bare "sí" re-asks instead of committing nothing', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
    // blocked caller ID, but the model still heard an affirmation
    { field: 'phone', value: { phone: null, use_caller_id: true } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await say(session, 'María García');
  const phoneQuestion = await say(session, 'doce de marzo del treinta y ocho');
  assert.deepStrictEqual(playIds(phoneQuestion), ['ask_phone'],
    'no caller ID -> no offer to use one');

  const actions = await session.onTranscript('sí');
  assert.deepStrictEqual(playIds(actions), ['ask_phone'],
    'nothing to adopt -> ask for a number outright');
  assert.strictEqual(session.state, 'collect', 'no read-back of a nonexistent number');
  assert.strictEqual(session.data.phone, undefined);
  assert.strictEqual(session.attempts, 1, 'counts as a strike so it still ends at a human');
});

test('follow-up: spoken routing, phone lookup, booking against existing MRN', async () => {
  const mrn = patients.createPatient(db, { firstName: 'José', lastName: 'Luna', phone: '5559876543' });
  const extract = fakeExtract([
    { field: 'patientType', value: { patient_type: 'follow_up' } },
    { field: 'mrnOrPhone', value: { mrn: null, phone: '5559876543' } },
    { field: 'reason', value: { reason: 'revisión de rutina' } },
    { field: 'slotChoice', value: { choice: 'second' } },
    { field: 'yesNo', value: { answer: 'yes' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, menuSpeechEnabled: true });
  session.start();

  assert.deepStrictEqual(playIds(await session.onTranscript('vengo a seguimiento')), ['ask_mrn_or_phone']);
  await say(session, 'mi teléfono es cinco cinco cinco nueve ocho siete seis cinco cuatro tres');
  await say(session, 'revisión de rutina');
  session.onDtmf(3); // next week
  await session.onTranscript('la segunda opción');
  await session.onTranscript('sí');

  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.mrn, mrn);
  assert.strictEqual(appt.patient_type, 'follow_up');
});

test('follow-up: record not found gets its own re-prompt, then human handoff at 3 strikes', async () => {
  const extract = fakeExtract([
    { field: 'mrnOrPhone', value: { mrn: 'P000001', phone: null } },
    { field: 'mrnOrPhone', value: { mrn: 'P000001', phone: null } },
    { field: 'mrnOrPhone', value: { mrn: 'P000001', phone: null } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(2);

  assert.deepStrictEqual(playIds(await session.onTranscript('P cero cero cero cero cero uno')), ['record_not_found']);
  assert.deepStrictEqual(playIds(await session.onTranscript('P cero cero cero cero cero uno')), ['record_not_found']);
  const final = await session.onTranscript('P cero cero cero cero cero uno');
  assert.deepStrictEqual(playIds(final), ['handoff_human']);
  assert.strictEqual(final.find((a) => a.type === 'escalate').reason, 'extraction_failure');
  assert.ok(session.ended);
});

test('post-op benign path books a follow-up', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 3 } },
    { field: 'slotChoice', value: { choice: 'first' } },
    { field: 'yesNo', value: { answer: 'yes' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);

  await say(session, 'me operaron el veinte de julio');
  await say(session, 'me siento bien, el dolor es un tres');
  session.onDtmf(3); // next week
  await session.onTranscript('la primera');
  await session.onTranscript('sí');

  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.patient_type, 'post_op');
  assert.match(appt.reason, /dolor=3/);
});

test('post-op red flag escalates BEFORE any extraction call and skips scheduling', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');

  const callsBefore = extract.calls.length;
  const actions = await session.onTranscript('es que no puedo respirar y estoy sangrando mucho');

  assert.strictEqual(extract.calls.length, callsBefore, 'no LLM call on a red-flag transcript');
  assert.deepStrictEqual(playIds(actions), ['escalate_red_flag']);
  const esc = actions.find((a) => a.type === 'escalate');
  assert.strictEqual(esc.reason, 'red_flag');
  assert.ok(session.ended, 'call ends — no scheduling after a red flag');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 0);
});

test('symptom extraction backstop: bleeding=true escalates even when keywords missed', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    // transcript wording slipped past redFlags.js, but the model still
    // understood it as bleeding — the accept() backstop must catch it
    { field: 'symptoms', value: { fever: false, bleeding: true, drain_concern: false, pain_level: 4 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');

  const actions = await session.onTranscript('se me mancha la venda de rojo todo el tiempo');
  assert.deepStrictEqual(playIds(actions), ['escalate_red_flag']);
  assert.strictEqual(actions.find((a) => a.type === 'escalate').reason, 'symptom_report');
  assert.ok(session.ended);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 0);
});

test('symptom extraction backstop: severe pain (>=8) escalates', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 9 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  const actions = await session.onTranscript('el dolor es un nueve');
  assert.strictEqual(actions.find((a) => a.type === 'escalate').reason, 'symptom_report');
});

test('red flag gate also fires outside the post-op flow', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Ana', last_name: 'Ruiz' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await say(session, 'Ana Ruiz');

  const actions = await session.onTranscript('tengo mucho dolor de pecho desde anoche');
  assert.strictEqual(actions.find((a) => a.type === 'escalate').reason, 'red_flag');
});

test('menu: low-confidence speech re-prompts twice then hands off (speech enabled)', async () => {
  const extract = fakeExtract([
    { field: 'patientType', ok: true, value: { patient_type: 'unknown' }, confidence: 0.3 },
    { field: 'patientType', ok: true, value: { patient_type: 'unknown' }, confidence: 0.3 },
    { field: 'patientType', ok: true, value: { patient_type: 'unknown' }, confidence: 0.3 },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, menuSpeechEnabled: true });
  session.start();

  assert.deepStrictEqual(playIds(await session.onTranscript('eh...')), ['menu_retry']);
  assert.deepStrictEqual(playIds(await session.onTranscript('mmm')), ['menu_retry']);
  const final = await session.onTranscript('...');
  assert.deepStrictEqual(playIds(final), ['handoff_human']);
  assert.ok(session.ended);
});

test('referral: unknown caller creates patient + referral rows', async () => {
  const extract = fakeExtract([
    { field: 'mrnOrPhone', value: { mrn: null, phone: '5551112222' } },
    { field: 'authorization', value: { has_authorization: true, authorization_code: 'AUTH42' } },
    { field: 'referringProvider', value: { provider_name: 'Dr. Soto', fax: '5552223333' } },
    { field: 'procedureType', value: { procedure: 'colecistectomía' } },
    { field: 'slotChoice', value: { choice: 'first' } },
    { field: 'yesNo', value: { answer: 'yes' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(4);

  await say(session, 'no tengo récord aquí, mi teléfono es...');
  await say(session, 'sí, autorización AUTH cuarenta y dos');
  await say(session, 'el doctor Soto');
  await say(session, 'colecistectomía');
  session.onDtmf(3); // next week
  await session.onTranscript('la primera');
  const final = await session.onTranscript('sí');

  const referralRow = db.prepare('SELECT * FROM referrals').get();
  assert.strictEqual(referralRow.authorization_code, 'AUTH42');
  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.patient_type, 'referral');
  assert.strictEqual(referralRow.mrn, appt.mrn);
  assert.strictEqual(final.find((a) => a.type === 'sms').to, '5551112222');
});

test('declining offers three times hands off to a human instead of looping', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 2 } },
    { field: 'yesNo', value: { answer: 'no' } },
    { field: 'yesNo', value: { answer: 'no' } },
    { field: 'yesNo', value: { answer: 'no' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'todo bien, dolor dos');

  // round 1: next week -> first slot -> no
  session.onDtmf(3);
  session.onDtmf(1);
  const round2 = await session.onTranscript('no, no me sirve');
  assert.deepStrictEqual(playIds(round2), ['ask_sched_window'], 'declining re-asks the broad question');

  // round 2
  session.onDtmf(3);
  session.onDtmf(1);
  await session.onTranscript('no');

  // round 3: third decline gives up gracefully — and with the no-slot
  // goodbye, NOT the "couldn't understand you" one: the caller answered
  // clearly every time.
  session.onDtmf(3);
  session.onDtmf(1);
  const final = await session.onTranscript('no');
  assert.deepStrictEqual(playIds(final), ['slots_none']);
  assert.strictEqual(final.find((a) => a.type === 'escalate').reason, 'no_acceptable_slot');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 0);
});

test('declining both offered slots ("ninguna") re-asks the window instead of striking', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
    { field: 'slotChoice', value: { choice: 'neither' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');
  session.onDtmf(3); // next week -> two-slot offer

  const back = await session.onTranscript('ninguna me sirve');
  assert.deepStrictEqual(playIds(back), ['ask_sched_window'], 'a decline is an answer, not a misfire');
  assert.strictEqual(session.state, 'sched_window');
});

test('DTMF 3 declines a two-slot offer, as the offer copy announces', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  const offer = session.onDtmf(3);
  assert.match(offer.find((a) => a.type === 'playText').text, /Si ninguna le conviene, oprima tres/);
  assert.deepStrictEqual(playIds(session.onDtmf(3)), ['ask_sched_window']);
});

test('single-slot offer is a yes/no: spoken "no" and DTMF 2 both decline it', async () => {
  // leave exactly one slot open next week
  for (const date of ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31']) {
    for (const time of appointments.SLOT_TIMES) {
      if (date === '2026-07-29' && time === '11:00') continue;
      appointments.bookAppointment(db, { patientType: 'new', date, time });
    }
  }
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
    // the spoken decline goes through yesNo, NOT slotChoice — fakeExtract
    // asserts the field name, so this line is the proof
    { field: 'yesNo', value: { answer: 'no' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  const offer = session.onDtmf(3); // next week -> exactly one slot
  const text = offer.find((a) => a.type === 'playText').text;
  assert.match(text, /una cita disponible/);
  assert.match(text, /Si no le conviene, oprima dos o diga no/);

  const declined = await session.onTranscript('no, ese día no puedo');
  assert.deepStrictEqual(playIds(declined), ['ask_sched_window']);

  // second round: same single slot, decline with the keypad this time
  session.onDtmf(3);
  assert.deepStrictEqual(playIds(session.onDtmf(2)), ['ask_sched_window'],
    'DTMF 2 declines a single-slot offer');
});

test('one stray keypress per scheduling question never adds up to a handoff', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  session.onDtmf(9); // fumble at the window question -> strike 1 there
  session.onDtmf(3); // answered -> counter resets

  session.onDtmf(9); // fumble at the offer -> strike 1 there
  session.onDtmf(1); // pick the first slot

  const replay = session.onDtmf(9); // fumble at the confirmation
  assert.match(replay.find((a) => a.type === 'playText').text, /¿Se la confirmo\?/,
    'confirmation strike replays the slot, not "¿podría repetirlo?"');
  assert.ok(!session.ended, 'three separate one-off fumbles must not end the call');

  const final = session.onDtmf(1);
  assert.ok(final.some((a) => a.type === 'hangup'), 'the booking still lands');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 1);
});

test('a suggested date in the past explains itself and re-asks for a date', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
    { field: 'preferredDate', value: { date: '2026-07-01' } },
    { field: 'preferredDate', value: { date: '2026-07-29' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  session.onDtmf(4);
  const past = await session.onTranscript('el primero de julio');
  assert.deepStrictEqual(playIds(past), ['date_in_past', 'ask_preferred_date']);

  const offer = await session.onTranscript('el veintinueve');
  assert.match(offer.find((a) => a.type === 'playText').text, /miércoles 29 de julio/);
});

test('a week-wide window offers two different days, not two times the same morning', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  const text = session.onDtmf(3).find((a) => a.type === 'playText').text;
  assert.match(text, /lunes 27 de julio/);
  assert.match(text, /martes 28 de julio/, 'second option comes from a different day');
});

test('booking with no number to text says the slot aloud instead of promising an SMS', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  // post-op finalize sets smsPhone: null, and no callerPhone here either
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');
  session.onDtmf(3);
  session.onDtmf(1);

  const final = session.onDtmf(1);
  assert.ok(!final.some((a) => a.type === 'sms'), 'no number, no SMS action');
  assert.ok(!playIds(final).includes('booking_confirmed_sms'), 'and no SMS promise');
  assert.match(final.find((a) => a.type === 'playText').text,
    /quedó confirmada para el lunes 27 de julio a las nueve de la mañana/);
  assert.ok(final.some((a) => a.type === 'hangup'));
});

test('post-op booking texts the caller-ID number when there is one', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '7875550000' });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');
  session.onDtmf(3);
  session.onDtmf(1);

  const final = session.onDtmf(1);
  assert.strictEqual(final.find((a) => a.type === 'sms').to, '7875550000');
  assert.ok(playIds(final).includes('booking_confirmed_sms'));
});

test('DTMF works end-to-end in scheduling: window, slot, confirmation', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  session.onDtmf(3); // window: next week
  session.onDtmf(2); // second slot
  const final = session.onDtmf(1); // 1 = sí
  assert.ok(final.some((a) => a.type === 'hangup'));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 1);
});

test('window with no availability re-asks instead of dead-ending', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  // Friday caller asking for "esta semana": only Sat/Sun remain -> nothing
  const noSlots = session.onDtmf(2);
  assert.deepStrictEqual(playIds(noSlots), ['slots_none_window', 'ask_sched_window']);

  const offer = session.onDtmf(3); // next week works
  assert.ok(offer.some((a) => a.type === 'playText'));
});

test('"today" window offers same-day slots', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  const offer = session.onDtmf(1); // hoy (Friday, 8am -> 09:00 and 11:00 offered)
  assert.match(offer.find((a) => a.type === 'playText').text, /viernes 24 de julio/);
});

test('spoken window choice works via schedWindow extraction', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
    { field: 'schedWindow', value: { window: 'next_week', date: null } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  const offer = await session.onTranscript('mejor la semana que viene');
  assert.match(offer.find((a) => a.type === 'playText').text, /lunes 27 de julio/);
});

test('suggesting a date: DTMF 4 asks for it, spoken date narrows to that day', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
    { field: 'preferredDate', value: { date: '2026-07-29' } },
    { field: 'yesNo', value: { answer: 'yes' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');

  assert.deepStrictEqual(playIds(session.onDtmf(4)), ['ask_preferred_date']);
  const offer = await session.onTranscript('el miércoles que viene');
  assert.match(offer.find((a) => a.type === 'playText').text, /miércoles 29 de julio/);

  session.onDtmf(1); // first slot that day
  const final = await session.onTranscript('sí, confirmo');
  assert.ok(final.some((a) => a.type === 'hangup'));
  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.scheduled_date, '2026-07-29');
});

test('menu speech disabled (default): spoken choice never reaches the LLM, DTMF still works', async () => {
  const extract = fakeExtract([]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();

  const actions = await session.onTranscript('soy paciente nuevo');
  assert.deepStrictEqual(playIds(actions), ['menu_retry']);
  assert.strictEqual(extract.calls.length, 0, 'no extraction call at a DTMF-only menu');

  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_full_name']);
});

test('menu speech disabled: red-flag gate still runs on menu speech', async () => {
  const extract = fakeExtract([]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();

  const actions = await session.onTranscript('me duele el pecho muy fuerte');
  assert.strictEqual(actions.find((a) => a.type === 'escalate').reason, 'red_flag');
  assert.strictEqual(extract.calls.length, 0);
});

test('* returns to the main menu mid-flow and clears everything collected', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Ana', last_name: 'Ruiz' } },
    // after the reset: post-op path
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 2 } },
    { field: 'slotChoice', value: { choice: 'first' } },
    { field: 'yesNo', value: { answer: 'yes' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1); // new patient
  await session.onTranscript('Ana Ruiz'); // sitting at the read-back

  const menuActions = session.onDtmf('*');
  assert.deepStrictEqual(playIds(menuActions), ['greeting_menu']);
  assert.strictEqual(session.state, 'menu');
  assert.deepStrictEqual(session.data, {}, 'partial data discarded');
  assert.strictEqual(session.pending, null, 'unconfirmed answer discarded too');

  session.onDtmf(3); // switch to post-op
  await say(session, 'el veinte de julio');
  await say(session, 'todo bien, dolor dos');
  session.onDtmf(3); // next week
  await session.onTranscript('la primera');
  await session.onTranscript('sí');

  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.patient_type, 'post_op');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM patients').get().n, 0,
    'abandoned new-patient path created no record');
});

test('* works from anywhere in scheduling too', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await say(session, 'el veinte de julio');
  await say(session, 'sin síntomas, dolor uno');
  assert.strictEqual(session.state, 'sched_window');

  session.onDtmf(3); // into the concrete offer
  assert.strictEqual(session.state, 'offer');
  assert.deepStrictEqual(playIds(session.onDtmf('*')), ['greeting_menu']);
  assert.strictEqual(session.state, 'menu');
});

// --- 0 = a human -------------------------------------------------------
// The clinic's callers are mostly elderly; a caller who wants a person must
// be able to get one from any point in the call, without having to work out
// which state the IVR thinks it's in.

test('0 hands off to the scheduling team from the main menu', () => {
  const session = new CallSession({ db, now: FIXED_NOW, extract: fakeExtract([]) });
  session.start();

  const actions = session.onDtmf(0);
  assert.deepStrictEqual(playIds(actions), ['handoff_operator']);
  assert.strictEqual(actions.find((a) => a.type === 'escalate').reason, 'caller_request');
  assert.ok(session.ended);
});

test('0 works mid-collection, at a read-back, and inside scheduling — and books nothing', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Ana', last_name: 'Ruiz' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);

  // mid-collection (waiting on an answer)
  const midCollect = new CallSession({ db, now: FIXED_NOW, extract: fakeExtract([]) });
  midCollect.start();
  midCollect.onDtmf(1);
  assert.deepStrictEqual(playIds(midCollect.onDtmf(0)), ['handoff_operator']);

  // at a read-back: the unconfirmed answer must not be kept
  await session.onTranscript('Ana Ruiz');
  assert.strictEqual(session.state, 'verify');
  const actions = session.onDtmf(0);
  assert.deepStrictEqual(playIds(actions), ['handoff_operator']);
  assert.strictEqual(actions.find((a) => a.type === 'escalate').reason, 'caller_request');
  assert.ok(session.ended);
  assert.deepStrictEqual(session.data, {}, 'nothing collected is stored on a bail-out');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM patients').get().n, 0);

  // inside scheduling
  const sched = new CallSession({
    db,
    now: FIXED_NOW,
    extract: fakeExtract([
      { field: 'surgeryDate', value: { date: '2026-07-20' } },
      { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
    ]),
  });
  sched.start();
  sched.onDtmf(3);
  await say(sched, 'el veinte de julio');
  await say(sched, 'sin síntomas, dolor uno');
  sched.onDtmf(3); // at the slot offer
  assert.deepStrictEqual(playIds(sched.onDtmf(0)), ['handoff_operator']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 0);
});

test('0 after the session ended is inert', () => {
  const session = new CallSession({ db, now: FIXED_NOW, extract: fakeExtract([]) });
  session.start();
  session.onDtmf(0);
  assert.deepStrictEqual(session.onDtmf(0), []);
});

// --- field read-back ---------------------------------------------------

test('each answer is read back in Spanish and only stored once confirmed', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);

  const nameReadback = await session.onTranscript('me llamo María García');
  assert.strictEqual(readbackText(nameReadback), 'Entendí que su nombre es María García.');
  assert.deepStrictEqual(playIds(nameReadback), ['confirm_field']);
  assert.ok(nameReadback.some((a) => a.type === 'listen'));
  assert.deepStrictEqual(session.data, {}, 'not stored until the caller agrees');

  // 1 = sí -> next question
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_dob']);
  assert.deepStrictEqual(session.data.fullName, { first_name: 'María', last_name: 'García' });

  // dates are read back with the year, no weekday
  const dobReadback = await session.onTranscript('doce de marzo del treinta y ocho');
  assert.strictEqual(readbackText(dobReadback), 'Entendí que nació el 12 de marzo de 1938.');
});

test('a spoken "sí" confirms the read-back the same way the keypad does', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'yesNo', value: { answer: 'yes' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await session.onTranscript('me llamo María García');

  assert.deepStrictEqual(playIds(await session.onTranscript('sí, correcto')), ['ask_dob']);
  assert.strictEqual(session.data.fullName.last_name, 'García');
});

test('rejecting a read-back re-asks the same question and drops the wrong value', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Marta', last_name: 'Arce' } },
    { field: 'yesNo', value: { answer: 'no' } },
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await session.onTranscript('me llamo María García'); // misheard

  const retry = await session.onTranscript('no, así no es');
  assert.deepStrictEqual(playIds(retry), ['retry_field', 'ask_full_name']);
  assert.strictEqual(session.state, 'collect');
  assert.deepStrictEqual(session.data, {}, 'the rejected value is gone');

  const secondTry = await session.onTranscript('María García');
  assert.strictEqual(readbackText(secondTry), 'Entendí que su nombre es María García.');
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_dob']);
});

test('read-back rejected three times ends at a human, not a loop', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Marta', last_name: 'Arce' } },
    { field: 'fullName', value: { first_name: 'Marta', last_name: 'Arce' } },
    { field: 'fullName', value: { first_name: 'Marta', last_name: 'Arce' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);

  await session.onTranscript('me llamo María García');
  assert.deepStrictEqual(playIds(session.onDtmf(2)), ['retry_field', 'ask_full_name']);
  await session.onTranscript('me llamo María García');
  assert.deepStrictEqual(playIds(session.onDtmf(2)), ['retry_field', 'ask_full_name']);
  await session.onTranscript('me llamo María García');

  const final = session.onDtmf(2);
  assert.deepStrictEqual(playIds(final), ['handoff_human']);
  assert.strictEqual(final.find((a) => a.type === 'escalate').reason, 'extraction_failure');
  assert.ok(session.ended);
});

test('an unintelligible answer at a read-back replays it instead of re-asking the question', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'yesNo', ok: true, value: { answer: 'yes' }, confidence: 0.2 },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await session.onTranscript('me llamo María García');

  const replay = await session.onTranscript('mmm...');
  assert.strictEqual(readbackText(replay), 'Entendí que su nombre es María García.');
  assert.deepStrictEqual(playIds(replay), ['confirm_field']);
  assert.strictEqual(session.state, 'verify', 'still waiting on the same sí/no');
});

// Regression: a barge-in fragment transcribed as "Gracias." used to come
// back {yes: false} at high confidence — the forced boolean made the model
// guess — silently discarding a phone number the caller had gotten right.
test('a confident non-answer at a read-back ("Gracias.") replays it instead of guessing no', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'José', last_name: 'González' } },
    { field: 'dob', value: { dob: '1973-09-08' } },
    { field: 'phone', value: { phone: '7874030123' } },
    { field: 'yesNo', value: { answer: 'unknown' }, confidence: 0.95 },
    { field: 'yesNo', value: { answer: 'yes' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1); // new patient
  await say(session, 'José González');
  await say(session, 'septiembre 8 del 73');
  await session.onTranscript('al 787-403-0123');
  assert.strictEqual(session.state, 'verify');

  const replay = await session.onTranscript('Gracias.');
  assert.match(readbackText(replay), /su teléfono es 7 8 7, 4 0 3, 0 1 2 3/,
    'the read-back is replayed — the value is neither committed nor discarded');
  assert.strictEqual(session.state, 'verify');
  assert.strictEqual(session.data.phone, undefined, 'not committed yet');
  assert.ok(session.pending, 'not discarded either');

  // a real "sí" then commits the value that nearly got thrown away
  await session.onTranscript('Sí, estaba bien.');
  assert.strictEqual(session.data.phone.phone, '7874030123');
});

// Voice barge-in must stay off while a read-back or the slot confirmation
// is playing: this caller base backchannels over prompts, and cancelling
// the read-back mid-number defeats its purpose. index.js consults this
// before running onset detection. (The keypad still interrupts — the dtmf
// event path doesn't check it.)
test('bargeInAllowed: off in verify and confirm, on everywhere else', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'symptoms', value: { fever: false, bleeding: false, drain_concern: false, pain_level: 1 } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  assert.strictEqual(session.bargeInAllowed, true, 'menu: greeting is skippable');

  session.onDtmf(3);
  assert.strictEqual(session.bargeInAllowed, true, 'collect: questions are skippable');
  await session.onTranscript('el veinte de julio');
  assert.strictEqual(session.bargeInAllowed, false, 'verify: the read-back must play out');
  session.onDtmf(1);
  await say(session, 'sin síntomas, dolor uno');

  session.onDtmf(3); // window -> offer
  assert.strictEqual(session.bargeInAllowed, true, 'offer: slot menu is skippable');
  session.onDtmf(1); // -> confirm
  assert.strictEqual(session.bargeInAllowed, false, 'confirm: the slot sentence must play out');
});

test('red-flag gate still runs while a read-back is pending', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await session.onTranscript('el veinte de julio');
  assert.strictEqual(session.state, 'verify');

  const callsBefore = extract.calls.length;
  const actions = await session.onTranscript('sí, pero es que no puedo respirar');
  assert.strictEqual(extract.calls.length, callsBefore, 'no LLM call on a red-flag transcript');
  assert.strictEqual(actions.find((a) => a.type === 'escalate').reason, 'red_flag');
});

test('read-backs are Spanish and speak digits one at a time', () => {
  const { fieldReadbackText } = require('../prompts');

  assert.strictEqual(
    fieldReadbackText('phone', { phone: '7874902081' }),
    'Entendí que su teléfono es 7 8 7, 4 9 0, 2 0 8 1.',
  );
  assert.strictEqual(
    fieldReadbackText('mrnOrPhone', { mrn: 'p000123', phone: null }),
    'Entendí que su número de récord es P 0 0 0 1 2 3.',
  );
  assert.strictEqual(
    fieldReadbackText('allergies', { allergies: 'ninguna' }),
    'Entendí que no tiene alergia a ningún medicamento.',
  );
  assert.strictEqual(
    fieldReadbackText('allergies', { allergies: 'penicilina' }),
    'Entendí que tiene alergia a penicilina.',
  );
  assert.strictEqual(
    fieldReadbackText('surgeryDate', { date: '2026-07-20' }),
    'Entendí que su operación fue el 20 de julio de 2026.',
  );
  assert.match(
    fieldReadbackText('symptoms', { fever: false, bleeding: false, drain_concern: false, pain_level: 3 }),
    /no tiene fiebre, no tiene sangrado, .* dolor es de 3 de diez\.$/,
  );
  assert.strictEqual(
    fieldReadbackText('authorization', { has_authorization: false, authorization_code: null }),
    'Entendí que todavía no tiene la autorización de su plan médico.',
  );
  assert.match(
    fieldReadbackText('authorization', { has_authorization: true, authorization_code: 'AUTH42' }),
    /número A U T H 4 2\.$/,
  );

  // A field with no formatter, or a value that can't be formatted, yields
  // null — the session then keeps the answer instead of asking a question
  // the caller never heard.
  assert.strictEqual(fieldReadbackText('slotChoice', { choice: 1 }), null);
  assert.strictEqual(fieldReadbackText('fullName', {}), null);
});

test('every collected field has a read-back — a silent field is a silent mis-transcription', () => {
  const { fieldReadbackText } = require('../prompts');
  const samples = {
    fullName: { first_name: 'Ana', last_name: 'Ruiz' },
    dob: { dob: '1940-01-05' },
    phone: { phone: '7875551234' },
    insuranceType: { insurance_type: 'vital', provider: null },
    insurance: { provider: 'Triple-S' },
    allergies: { allergies: 'ninguna' },
    reason: { reason: 'dolor abdominal' },
    mrnOrPhone: { mrn: 'P000001', phone: null },
    surgeryDate: { date: '2026-07-20' },
    symptoms: { fever: false, bleeding: false, drain_concern: false, pain_level: 2 },
    authorization: { has_authorization: true, authorization_code: 'AUTH42' },
    referringProvider: { provider_name: 'el doctor Soto' },
    procedureType: { procedure: 'colecistectomía' },
  };
  for (const flow of Object.values(FLOWS)) {
    for (const step of flow.steps) {
      assert.ok(samples[step.field], `test sample missing for field "${step.field}"`);
      assert.ok(
        fieldReadbackText(step.field, samples[step.field]),
        `field "${step.field}" has no read-back — it would be stored without the caller hearing it`,
      );
    }
  }
});

// --- insurance type: comercial vs. Reforma / Plan Vital -----------------
// Plan Vital patients must be reminded to bring a referido vigente from
// their médico primario; commercial patients must NEVER hear that reminder.

test('Plan Vital path: Vital company question, then the referral reminder', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Carmen', last_name: 'Vega' } },
    { field: 'dob', value: { dob: '1950-02-01' } },
    { field: 'phone', value: { phone: '7875551234' } },
    { field: 'insuranceType', value: { insurance_type: 'vital', provider: null } },
    { field: 'insurance', value: { provider: 'Triple-S' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await say(session, 'Carmen Vega');
  await say(session, 'primero de febrero del cincuenta');
  await say(session, 'siete ocho siete...');

  // "tengo la Reforma" -> read-back of the type, then the VITAL company question
  const typeReadback = await session.onTranscript('tengo la Reforma');
  assert.strictEqual(readbackText(typeReadback), 'Entendí que su plan médico es del Plan Vital.');
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_insurance_vital'],
    'vital type skips the commercial company question');

  // company confirmed -> reminder plays BEFORE the next question
  await session.onTranscript('Triple-S');
  const afterCompany = session.onDtmf(1);
  assert.deepStrictEqual(playIds(afterCompany), ['vital_referral_reminder', 'ask_allergies']);
});

test('commercial full call never plays the Vital referral reminder', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1985-03-12' } },
    { field: 'phone', value: { phone: '5551234567' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: null } },
    { field: 'insurance', value: { provider: 'MCS' } },
    { field: 'allergies', value: { allergies: 'ninguna' } },
    { field: 'reason', value: { reason: 'consulta' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);

  const played = [];
  for (const t of ['María García', 'doce de marzo del ochenta y cinco', 'cinco cinco cinco',
    'es comercial', 'MCS', 'ninguna', 'una consulta']) {
    played.push(...playIds(await say(session, t)));
  }
  assert.ok(!played.includes('vital_referral_reminder'),
    'commercial coverage must never trigger the referido reminder');
  assert.ok(played.includes('ask_insurance'), 'commercial company question asked');
  assert.ok(!played.includes('ask_insurance_vital'));
});

test('company named with the type ("MCS ClassiCare") skips the company question', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Luis', last_name: 'Ortiz' } },
    { field: 'dob', value: { dob: '1948-11-30' } },
    { field: 'phone', value: { phone: '7875550000' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: 'MCS ClassiCare' } },
    { field: 'allergies', value: { allergies: 'ninguna' } },
    { field: 'reason', value: { reason: 'consulta' } },
    { field: 'slotChoice', value: { choice: 'first' } },
    { field: 'yesNo', value: { answer: 'yes' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await say(session, 'Luis Ortiz');
  await say(session, 'treinta de noviembre del cuarenta y ocho');
  await say(session, 'siete ocho siete...');

  // read-back confirms company AND type in one turn...
  const typeReadback = await session.onTranscript('es MCS ClassiCare');
  assert.strictEqual(readbackText(typeReadback),
    'Entendí que su plan médico es MCS ClassiCare, un plan comercial.');
  // ...and confirming it jumps straight to allergies, no company question
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_allergies']);

  await say(session, 'ninguna');
  await say(session, 'una consulta');
  session.onDtmf(3);
  await session.onTranscript('la primera');
  await session.onTranscript('sí');

  const patient = db.prepare("SELECT * FROM patients WHERE first_name = 'Luis'").get();
  assert.strictEqual(patient.insurance_provider, 'MCS ClassiCare',
    'provider captured at the type step still lands in the patient row');
});

test('Vital company named with the type: reminder plays, company question skipped', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Rosa', last_name: 'Nieves' } },
    { field: 'dob', value: { dob: '1942-06-15' } },
    { field: 'phone', value: { phone: '7875551111' } },
    { field: 'insuranceType', value: { insurance_type: 'vital', provider: 'Triple-S Vital' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await say(session, 'Rosa Nieves');
  await say(session, 'quince de junio del cuarenta y dos');
  await say(session, 'siete ocho siete...');

  const typeReadback = await session.onTranscript('tengo Triple-S Vital');
  assert.strictEqual(readbackText(typeReadback),
    'Entendí que su plan médico es Triple-S Vital, del Plan Vital.');
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['vital_referral_reminder', 'ask_allergies']);
});

test('ambiguous carrier ("Triple-S") gets a clarification, and the company is not re-asked', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Pedro', last_name: 'Ríos' } },
    { field: 'dob', value: { dob: '1955-09-09' } },
    { field: 'phone', value: { phone: '7875552222' } },
    // bare carrier name — sells both commercial and Vital products
    { field: 'insuranceType', value: { insurance_type: 'unclear', provider: 'Triple-S' } },
    // caller clarifies with just the type; the earlier company must carry over
    { field: 'insuranceType', value: { insurance_type: 'vital', provider: null } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await say(session, 'Pedro Ríos');
  await say(session, 'nueve de septiembre del cincuenta y cinco');
  await say(session, 'siete ocho siete...');

  const clarify = await session.onTranscript('tengo Triple-S');
  assert.deepStrictEqual(playIds(clarify), ['clarify_insurance_type'],
    'a carrier that sells both products is never assumed to be either');

  const typeReadback = await session.onTranscript('es de la Reforma');
  assert.strictEqual(readbackText(typeReadback),
    'Entendí que su plan médico es Triple-S, del Plan Vital.',
    'the company said before the clarification carries over');
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['vital_referral_reminder', 'ask_allergies']);
});

// --- optional intake questions (ASK_ALLERGIES / ASK_REASON) -------------
// Deployment switches, read at call time — no module reload needed, but
// each test must restore the env so the rest of the suite runs with the
// questions on (the default).

test('ASK_ALLERGIES=false and ASK_REASON=false skip both questions and book with NULLs', async () => {
  process.env.ASK_ALLERGIES = 'false';
  process.env.ASK_REASON = 'false';
  try {
    const extract = fakeExtract([
      { field: 'fullName', value: { first_name: 'Elena', last_name: 'Cruz' } },
      { field: 'dob', value: { dob: '1946-04-02' } },
      { field: 'phone', value: { phone: '7875553333' } },
      { field: 'insuranceType', value: { insurance_type: 'commercial', provider: null } },
      { field: 'insurance', value: { provider: 'Humana' } },
      { field: 'slotChoice', value: { choice: 'first' } },
      { field: 'yesNo', value: { answer: 'yes' } },
    ]);
    const session = new CallSession({ db, now: FIXED_NOW, extract });
    session.start();
    session.onDtmf(1);
    await say(session, 'Elena Cruz');
    await say(session, 'dos de abril del cuarenta y seis');
    await say(session, 'siete ocho siete...');
    await say(session, 'comercial');

    // company confirmed -> straight to scheduling, no allergies/reason turns
    await session.onTranscript('Humana');
    assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_sched_window']);

    session.onDtmf(3); // next week
    await session.onTranscript('la primera');
    await session.onTranscript('sí');

    const patient = db.prepare("SELECT * FROM patients WHERE first_name = 'Elena'").get();
    assert.strictEqual(patient.allergies, null, 'skipped question stores NULL, not a stub');
    const appt = db.prepare('SELECT * FROM appointments').get();
    assert.strictEqual(appt.reason, null);
    assert.strictEqual(appt.reason_transcript, null);
  } finally {
    delete process.env.ASK_ALLERGIES;
    delete process.env.ASK_REASON;
  }
});

test('ASK_REASON=false also skips the follow-up reason question', async () => {
  process.env.ASK_REASON = 'false';
  try {
    const mrn = patients.createPatient(db, { firstName: 'José', lastName: 'Luna', phone: '5559876543' });
    const extract = fakeExtract([
      { field: 'mrnOrPhone', value: { mrn: null, phone: '5559876543' } },
    ]);
    const session = new CallSession({ db, now: FIXED_NOW, extract });
    session.start();
    session.onDtmf(2);

    // record found + confirmed -> scheduling directly, no reason question
    await session.onTranscript('cinco cinco cinco nueve ocho siete seis cinco cuatro tres');
    assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_sched_window']);

    session.onDtmf(3);
    session.onDtmf(1);
    session.onDtmf(1);
    const appt = db.prepare('SELECT * FROM appointments').get();
    assert.strictEqual(appt.mrn, mrn);
    assert.strictEqual(appt.reason, null);
  } finally {
    delete process.env.ASK_REASON;
  }
});

test('the switches default to asking (no env var set)', async () => {
  assert.strictEqual(process.env.ASK_ALLERGIES, undefined);
  assert.strictEqual(process.env.ASK_REASON, undefined);
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Iris', last_name: 'Colón' } },
    { field: 'dob', value: { dob: '1953-08-21' } },
    { field: 'phone', value: { phone: '7875554444' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: 'Humana' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await say(session, 'Iris Colón');
  await say(session, 'veintiuno de agosto del cincuenta y tres');
  await say(session, 'siete ocho siete...');

  await session.onTranscript('Humana, comercial');
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_allergies'],
    'with nothing set in .env the allergies question is still asked');
});

test('spanishDate formatting used in offers is correct Spanish', () => {
  const { spanishDate, spanishTime } = require('../prompts');
  assert.strictEqual(spanishDate('2026-07-27'), 'el lunes 27 de julio');
  assert.strictEqual(spanishDate('2026-08-01'), 'el sábado 1 de agosto');
  assert.strictEqual(spanishTime('14:00'), 'a las dos de la tarde');
});
