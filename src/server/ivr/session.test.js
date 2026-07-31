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

// Every collected field is read back to the caller and kept only once they
// confirm it with the keypad (1 = sí, the only way to confirm). Tests that
// aren't about the read-back itself answer the question and then press 1.
async function say(session, transcript) {
  const actions = await session.onTranscript(transcript);
  if (session.state !== 'verify') return actions;
  return session.onDtmf(1);
}

// The post-op intake (surgery date -> hospital -> name -> phone) in
// scripted-extraction and spoken form. Post-op is the path many scheduling
// tests ride to reach sched_window, so both halves live here.
function postOpFields() {
  return [
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'hospital', value: { hospital: 'el Hospital Auxilio Mutuo' } },
    { field: 'fullName', value: { first_name: 'Juan', last_name: 'Rivera' } },
    { field: 'phone', value: { phone: '7875559999' } },
  ];
}

async function sayPostOpIntake(session) {
  await say(session, 'me operaron el veinte de julio');
  await say(session, 'en el Auxilio Mutuo');
  await say(session, 'Juan Rivera');
  await say(session, 'siete ocho siete, cinco cinco cinco, nueve nueve nueve nueve');
}

test('every promptId referenced by flows and engine exists in PROMPTS (cache coverage)', () => {
  const referenced = new Set([
    'greeting_menu', 'menu_retry', 'reprompt_generic',
    'handoff_operator', 'confirm_field', 'retry_field',
    'slots_none', 'sched_retry_hint', 'booking_confirmed_sms',
    'ask_sched_window', 'ask_preferred_date', 'slots_none_day', 'slots_none_window', 'date_in_past',
    // referenced from step hooks (accept()/after()), not step.promptId
    'clarify_insurance_type', 'vital_referral_reminder',
  ]);
  for (const flow of Object.values(FLOWS)) {
    for (const step of flow.steps) {
      referenced.add(step.promptId);
    }
  }
  for (const id of referenced) {
    assert.ok(PROMPTS[id], `prompt id "${id}" missing from PROMPTS — cache would have a hole`);
  }
});

// index.js gates the /stt call on this AND sizes each turn's TurnDetector
// from it: "open" tolerates a 1.8s pause mid-answer (elderly callers pause
// while recalling names and digits). A collection step coming back false
// silently drops the caller's answer on the floor; a keypad state coming
// back true silently reintroduces STT where the design says it never runs.
test('expectsSpeech: true only while collecting or composing a date', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1985-03-12' } },
    { field: 'phone', value: { phone: '5551234567' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: null } },
    { field: 'insurance', value: { provider: 'Aetna' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });

  session.start();
  assert.strictEqual(session.expectsSpeech, false, 'menu: keypad only, no STT');

  session.onDtmf(1); // new patient -> collect
  assert.strictEqual(session.expectsSpeech, true, 'collect: caller composes the answer aloud');
  await session.onTranscript('me llamo María García'); // -> verify (read-back)
  assert.strictEqual(session.expectsSpeech, false, 'verify: keys 1/2 only, no STT');
  session.onDtmf(1); // confirmed -> next field
  assert.strictEqual(session.expectsSpeech, true, 'still collecting after a field lands');

  for (const t of ['doce de marzo del ochenta y cinco', 'cinco cinco cinco', 'es comercial']) {
    await say(session, t);
  }
  await say(session, 'Aetna'); // last field -> sched_window
  assert.strictEqual(session.expectsSpeech, false, 'sched_window: keypad menu');

  session.onDtmf(4); // "suggest a date" -> sched_date
  assert.strictEqual(session.expectsSpeech, true, 'sched_date: spoken date, caller may hesitate');
});

test('expectsSpeech: false at the caller-ID offer, the slot offer, and the confirmation', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'José', last_name: 'Luna' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: null } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '+15559876543' });

  session.start();
  session.onDtmf(2); // follow-up
  await say(session, 'José Luna');
  assert.strictEqual(session.state, 'collect_key', 'caller ID present -> keypad phone offer');
  assert.strictEqual(session.expectsSpeech, false, 'collect_key: keypad question, no STT');
  session.onDtmf(1); // use the caller-ID number -> read-back
  session.onDtmf(1); // confirm it
  await say(session, 'es comercial');
  session.onDtmf(3); // next week -> offer
  assert.strictEqual(session.expectsSpeech, false, 'offer: keypad choice');

  session.onDtmf(1); // first slot -> confirm
  assert.strictEqual(session.expectsSpeech, false, 'confirm: keys 1/2 only');
});

test('new patient: full path lands patient + appointment + Spanish SMS', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1985-03-12' } },
    { field: 'phone', value: { phone: '5551234567' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: null } },
    { field: 'insurance', value: { provider: 'Aetna' }, confidence: 0.8 },
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

  // after last field: broad "when?" question first
  const windowActions = await say(session, 'tengo Aetna');
  assert.deepStrictEqual(playIds(windowActions), ['ask_sched_window']);

  // "next week" narrows to concrete slots, offered in Spanish
  const offerActions = session.onDtmf(3);
  const offer = offerActions.find((a) => a.type === 'playText');
  assert.match(offer.text, /lunes 27 de julio/);

  const confirmActions = session.onDtmf(1); // first slot
  assert.match(confirmActions.find((a) => a.type === 'playText').text, /¿Se la confirmo\?/);

  const finalActions = session.onDtmf(1); // 1 = sí
  const sms = finalActions.find((a) => a.type === 'sms');
  assert.strictEqual(sms.to, '5551234567');
  assert.match(sms.text, /cita quedó confirmada/);
  assert.ok(finalActions.some((a) => a.type === 'hangup'));

  const patient = db.prepare("SELECT * FROM patients WHERE first_name = 'María'").get();
  assert.strictEqual(patient.insurance_provider, 'Aetna');
  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.patient_type, 'new');
  assert.strictEqual(appt.mrn, patient.mrn);
  assert.strictEqual(appt.scheduled_date, '2026-07-27');
  assert.strictEqual(appt.extraction_confidence, 0.8, 'stores the MINIMUM field confidence');
  assert.strictEqual(appt.reason, null, 'no reason question — column stays NULL');
});

// --- phone: keypad caller-ID offer + dictated variant --------------------

test('phone with caller ID: key 1 adopts the calling number, read back before kept', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '+17875550000' });
  session.start();
  session.onDtmf(1);
  await say(session, 'María García');
  const phoneQuestion = await say(session, 'doce de marzo del treinta y ocho');
  assert.deepStrictEqual(playIds(phoneQuestion), ['ask_phone_caller_id'],
    'caller ID present -> the keypad offer, not the dictate-a-number question');
  assert.strictEqual(session.state, 'collect_key');

  const verify = session.onDtmf(1);
  assert.strictEqual(session.state, 'verify',
    'the caller-ID number still goes through the read-back, never committed unheard');
  assert.match(readbackText(verify), /7 8 7, 5 5 5, 0 0 0 0/,
    'E.164 caller ID read back as 10-digit national, digit by digit');
  assert.strictEqual(extract.calls.length, 2, 'accepting the caller ID costs no extraction call');

  session.onDtmf(1); // sí
  assert.strictEqual(session.data.phone.phone, '7875550000');
  assert.strictEqual(session.minConfidence, 0.95,
    'the keypad-accepted number must not drag minConfidence down');
});

test('phone with caller ID: key 2 moves on to dictating a number', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
    { field: 'phone', value: { phone: '9395551234' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '+17875550000' });
  session.start();
  session.onDtmf(1);
  await say(session, 'María García');
  await say(session, 'doce de marzo del treinta y ocho');

  assert.deepStrictEqual(playIds(session.onDtmf(2)), ['ask_phone'],
    'declining the caller ID asks for a dictated number');
  assert.strictEqual(session.state, 'collect');

  const verify = await session.onTranscript('al nueve tres nueve...');
  assert.match(readbackText(verify), /9 3 9, 5 5 5, 1 2 3 4/);
  session.onDtmf(1);
  assert.strictEqual(session.data.phone.phone, '9395551234');
});

test('an unmapped key at the caller-ID offer replays the question', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '+17875550000' });
  session.start();
  session.onDtmf(1);
  await say(session, 'María García');
  await say(session, 'doce de marzo del treinta y ocho');

  assert.deepStrictEqual(playIds(session.onDtmf(5)), ['ask_phone_caller_id']);
  assert.strictEqual(session.state, 'collect_key', 'still waiting on 1 or 2');
});

test('rejecting the caller-ID read-back returns to the keypad offer, where 2 reaches dictation', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '+17875550000' });
  session.start();
  session.onDtmf(1);
  await say(session, 'María García');
  await say(session, 'doce de marzo del treinta y ocho');

  session.onDtmf(1); // use the caller ID -> read-back
  const retry = session.onDtmf(2); // "no" — that's not the number I want
  assert.deepStrictEqual(playIds(retry), ['retry_field', 'ask_phone_caller_id']);
  assert.strictEqual(session.state, 'collect_key',
    'rejecting the read-back re-asks the KEYPAD question, not a speech listen');

  assert.deepStrictEqual(playIds(session.onDtmf(2)), ['ask_phone'],
    'from there, 2 still reaches the dictated variant');
});

test('phone without caller ID: plain dictation question, a failed extraction re-asks forever', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
    // a bare "sí" has no digits: the schema rejects it (ok: false)
    { field: 'phone', ok: false, value: null, confidence: 0 },
    { field: 'phone', ok: false, value: null, confidence: 0 },
    { field: 'phone', ok: false, value: null, confidence: 0 },
    { field: 'phone', ok: false, value: null, confidence: 0 },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await say(session, 'María García');
  const phoneQuestion = await say(session, 'doce de marzo del treinta y ocho');
  assert.deepStrictEqual(playIds(phoneQuestion), ['ask_phone'],
    'no caller ID -> no offer to use one');

  for (const t of ['sí', 'sí, a este mismo', 'ese mismo número', 'sí']) {
    const actions = await session.onTranscript(t);
    assert.deepStrictEqual(playIds(actions), ['reprompt_generic'],
      're-prompt every time — there is no attempt cap and no handoff');
  }
  assert.strictEqual(session.state, 'collect', 'still asking, never transferred');
  assert.ok(!session.ended);
  assert.strictEqual(session.data.phone, undefined);
});

// --- follow-up / post-op paths -------------------------------------------

test('follow-up: name/phone/plan type, booking reuses the matching record', async () => {
  const mrn = patients.createPatient(db, { firstName: 'José', lastName: 'Luna', phone: '5559876543' });
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'José', last_name: 'Luna' } },
    { field: 'phone', value: { phone: '5559876543' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: null } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();

  assert.deepStrictEqual(playIds(session.onDtmf(2)), ['ask_full_name']);
  await say(session, 'José Luna');
  const typeQuestion = await say(session, 'cinco cinco cinco nueve ocho siete seis cinco cuatro tres');
  assert.deepStrictEqual(playIds(typeQuestion), ['ask_insurance_type']);
  const sched = await say(session, 'es comercial');
  assert.deepStrictEqual(playIds(sched), ['ask_sched_window'],
    'commercial goes straight to scheduling — no reminder, no company question');
  session.onDtmf(3); // next week
  session.onDtmf(2); // second slot
  const final = session.onDtmf(1); // 1 = sí

  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.mrn, mrn, 'phone match books against the existing record');
  assert.strictEqual(appt.patient_type, 'follow_up');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM patients').get().n, 1, 'no duplicate row');
  assert.strictEqual(final.find((a) => a.type === 'sms').to, '5559876543');
});

test('follow-up Vital caller hears the referido reminder, then scheduling', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Carmen', last_name: 'Vega' } },
    { field: 'phone', value: { phone: '7875551234' } },
    { field: 'insuranceType', value: { insurance_type: 'vital', provider: null } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(2);
  await say(session, 'Carmen Vega');
  await say(session, 'siete ocho siete...');

  const actions = await say(session, 'de la Reforma');
  assert.deepStrictEqual(playIds(actions), ['vital_referral_reminder', 'ask_sched_window'],
    'reminder plays right after the type lands, before the scheduling question');
});

test('follow-up: unknown phone creates a record with the collected name and plan', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Carmen', last_name: 'Vega' } },
    { field: 'phone', value: { phone: '7875551234' } },
    { field: 'insuranceType', value: { insurance_type: 'vital', provider: 'Triple-S Vital' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(2);
  await say(session, 'Carmen Vega');
  await say(session, 'siete ocho siete...');
  await say(session, 'tengo Triple-S Vital');
  session.onDtmf(3); // next week
  session.onDtmf(1); // first slot
  session.onDtmf(1); // sí

  const patient = db.prepare("SELECT * FROM patients WHERE first_name = 'Carmen'").get();
  assert.strictEqual(patient.phone, '7875551234');
  assert.strictEqual(patient.insurance_provider, 'Triple-S Vital',
    'a company named alongside the type lands on the new record');
  assert.strictEqual(db.prepare('SELECT * FROM appointments').get().mrn, patient.mrn);
});

test('post-op path: date, hospital, name, phone, then a booking with SMS', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  assert.deepStrictEqual(playIds(session.onDtmf(3)), ['ask_surgery_date']);

  await say(session, 'me operaron el veinte de julio');
  const nameQuestion = await say(session, 'en el Auxilio Mutuo');
  assert.deepStrictEqual(playIds(nameQuestion), ['ask_postop_full_name']);
  await say(session, 'Juan Rivera');
  await say(session, 'siete ocho siete, cinco cinco cinco, nueve nueve nueve nueve');
  session.onDtmf(3); // next week
  session.onDtmf(1); // first slot
  const final = session.onDtmf(1); // 1 = sí

  const patient = db.prepare("SELECT * FROM patients WHERE first_name = 'Juan'").get();
  assert.strictEqual(patient.phone, '7875559999');
  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.patient_type, 'post_op');
  assert.strictEqual(appt.mrn, patient.mrn);
  assert.match(appt.reason, /cirugía 2026-07-20/);
  assert.match(appt.reason, /Auxilio Mutuo/);
  assert.strictEqual(final.find((a) => a.type === 'sms').to, '7875559999');
});

test('post-op booking reuses the record whose phone matches instead of duplicating it', async () => {
  const mrn = patients.createPatient(db, { firstName: 'Juan', lastName: 'Rivera', phone: '7875559999' });
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);
  session.onDtmf(3); // next week
  session.onDtmf(1); // first slot
  session.onDtmf(1); // sí

  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM patients').get().n, 1,
    'no duplicate patient row for a known phone');
  assert.strictEqual(db.prepare('SELECT * FROM appointments').get().mrn, mrn);
});

test('post-op caller accepting the caller-ID number is texted there', async () => {
  const extract = fakeExtract([
    { field: 'surgeryDate', value: { date: '2026-07-20' } },
    { field: 'hospital', value: { hospital: 'el Hospital Auxilio Mutuo' } },
    { field: 'fullName', value: { first_name: 'Juan', last_name: 'Rivera' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '+17875550000' });
  session.start();
  session.onDtmf(3);
  await say(session, 'me operaron el veinte de julio');
  await say(session, 'en el Auxilio Mutuo');
  const phoneQuestion = await say(session, 'Juan Rivera');
  assert.deepStrictEqual(playIds(phoneQuestion), ['ask_phone_caller_id'],
    'caller ID present -> the keypad offer, same as the new-patient flow');
  session.onDtmf(1); // use this number -> read-back
  session.onDtmf(1); // confirm it
  session.onDtmf(3); // next week
  session.onDtmf(1); // first slot

  const final = session.onDtmf(1);
  assert.strictEqual(final.find((a) => a.type === 'sms').to, '7875550000');
  assert.ok(playIds(final).includes('booking_confirmed_sms'));
});

// --- no automatic transfers: failures re-prompt forever -------------------
// The only transfer left in the whole call is the caller pressing 0.

test('menu is DTMF-only: speech replays the retry forever, never reaching the LLM', async () => {
  const extract = fakeExtract([]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();

  for (let i = 0; i < 5; i += 1) {
    const actions = await session.onTranscript('soy paciente nuevo');
    assert.deepStrictEqual(playIds(actions), ['menu_retry']);
    assert.ok(!actions.some((a) => a.type === 'transfer'), 'never transfers on its own');
  }
  assert.ok(!session.ended, 'the call is still live');
  assert.strictEqual(extract.calls.length, 0, 'menu speech is never sent to extraction');

  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_full_name'], 'DTMF still works');
});

test('low-confidence extraction re-prompts indefinitely — no 3-strike bailout', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: '', last_name: '' }, confidence: 0.2 },
    { field: 'fullName', value: { first_name: '', last_name: '' }, confidence: 0.2 },
    { field: 'fullName', value: { first_name: '', last_name: '' }, confidence: 0.2 },
    { field: 'fullName', value: { first_name: '', last_name: '' }, confidence: 0.2 },
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);

  for (let i = 0; i < 4; i += 1) {
    const actions = await session.onTranscript('...');
    assert.deepStrictEqual(playIds(actions), ['reprompt_generic'],
      `attempt ${i + 1}: still re-prompting, no handoff`);
    assert.ok(!session.ended);
  }

  // the fifth try lands and the call proceeds normally
  const verify = await session.onTranscript('me llamo María García');
  assert.strictEqual(readbackText(verify), 'Entendí que su nombre es María García.');
});

test('read-back rejected over and over keeps re-asking, never ends at a human', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Marta', last_name: 'Arce' } },
    { field: 'fullName', value: { first_name: 'Marta', last_name: 'Arce' } },
    { field: 'fullName', value: { first_name: 'Marta', last_name: 'Arce' } },
    { field: 'fullName', value: { first_name: 'Marta', last_name: 'Arce' } },
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);

  for (let i = 0; i < 4; i += 1) {
    await session.onTranscript('me llamo María García'); // misheard every time
    const retry = session.onDtmf(2);
    assert.deepStrictEqual(playIds(retry), ['retry_field', 'ask_full_name'],
      `rejection ${i + 1}: re-asks the same question`);
    assert.ok(!retry.some((a) => a.type === 'transfer'));
    assert.ok(!session.ended);
  }

  await session.onTranscript('María García');
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_dob'], 'the fifth try commits normally');
});

test('declining offers keeps looping back to the window question, never transfers', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  for (let round = 0; round < 4; round += 1) {
    session.onDtmf(3); // next week -> two-slot offer
    const back = session.onDtmf(3); // decline both
    assert.deepStrictEqual(playIds(back), ['sched_retry_hint', 'ask_sched_window'],
      `round ${round + 1}: decline loops to the window menu with the 0 reminder`);
    assert.ok(!back.some((a) => a.type === 'transfer'), 'no transfer, ever');
    assert.ok(!session.ended);
  }
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 0);
});

test('nothing bookable anywhere: says so, returns to the window menu, no transfer', async () => {
  // Book out every slot from tomorrow through far past the 60-day nearest
  // search, so a "next week" request finds nothing at all.
  for (let d = new Date(2026, 6, 25); d <= new Date(2026, 9, 15); d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (const time of appointments.SLOT_TIMES) {
      appointments.bookAppointment(db, { patientType: 'new', date: iso, time });
    }
  }
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  const actions = session.onDtmf(3); // next week: empty, and no nearest slot either
  assert.deepStrictEqual(playIds(actions), ['slots_none', 'ask_sched_window']);
  assert.ok(!actions.some((a) => a.type === 'transfer'));
  assert.strictEqual(session.state, 'sched_window');
  assert.ok(!session.ended);
});

// --- speech at keypad-only states: replayed, never extracted --------------
// index.js never calls /stt in these states; the session holds the same
// contract anyway — a transcript landing here replays the question and
// costs zero extraction calls (fakeExtract.calls is the proof).

test('speech at the scheduling window replays the keypad menu, no extraction', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);
  const callsBefore = extract.calls.length;

  const actions = await session.onTranscript('mejor la semana que viene');
  assert.deepStrictEqual(playIds(actions), ['ask_sched_window']);
  assert.strictEqual(extract.calls.length, callsBefore, 'no schedWindow extraction exists anymore');
  assert.strictEqual(session.state, 'sched_window');
});

test('speech at the slot offer and the confirmation replays them, no extraction', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);
  session.onDtmf(3); // next week -> offer
  const callsBefore = extract.calls.length;

  const offerReplay = await session.onTranscript('la primera');
  assert.match(offerReplay.find((a) => a.type === 'playText').text, /Tengo dos opciones/,
    'the (dynamic) offer itself replays, not a generic re-prompt');
  assert.strictEqual(session.state, 'offer');

  session.onDtmf(1); // pick the first slot -> confirm
  const confirmReplay = await session.onTranscript('sí, confirmo');
  assert.match(confirmReplay.find((a) => a.type === 'playText').text, /¿Se la confirmo\?/,
    'the slot + question replay so the caller hears the date again');
  assert.strictEqual(session.state, 'confirm');
  assert.strictEqual(extract.calls.length, callsBefore, 'no yesNo/slotChoice extraction exists anymore');

  const final = session.onDtmf(1);
  assert.ok(final.some((a) => a.type === 'hangup'), 'the booking still lands afterwards');
});

test('speech at the caller-ID offer replays it, no extraction', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1938-03-12' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract, callerPhone: '+17875550000' });
  session.start();
  session.onDtmf(1);
  await say(session, 'María García');
  await say(session, 'doce de marzo del treinta y ocho');
  assert.strictEqual(session.state, 'collect_key');
  const callsBefore = extract.calls.length;

  const actions = await session.onTranscript('sí, a este mismo número');
  assert.deepStrictEqual(playIds(actions), ['ask_phone_caller_id']);
  assert.strictEqual(extract.calls.length, callsBefore, 'a spoken "sí" is not an answer here');
  assert.strictEqual(session.state, 'collect_key');
});

test('onUnexpectedSpeech after the session ended is inert', () => {
  const session = new CallSession({ db, now: FIXED_NOW, extract: fakeExtract([]) });
  session.start();
  session.onDtmf(0);
  assert.deepStrictEqual(session.onUnexpectedSpeech(), []);
});

// --- scheduling (keypad) ---------------------------------------------------

test('DTMF 3 declines a two-slot offer, as the offer copy announces', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  const offer = session.onDtmf(3);
  assert.match(offer.find((a) => a.type === 'playText').text, /Si ninguna le conviene, oprima tres/);
  assert.deepStrictEqual(playIds(session.onDtmf(3)), ['sched_retry_hint', 'ask_sched_window']);
});

test('single-slot offer is keypad-only: 1 accepts, 2 declines', async () => {
  // leave exactly one slot open next week
  for (const date of ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31']) {
    for (const time of appointments.SLOT_TIMES) {
      if (date === '2026-07-29' && time === '11:00') continue;
      appointments.bookAppointment(db, { patientType: 'new', date, time });
    }
  }
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  const offer = session.onDtmf(3); // next week -> exactly one slot
  const text = offer.find((a) => a.type === 'playText').text;
  assert.match(text, /una cita disponible/);
  assert.match(text, /Si no le conviene, oprima dos\./);
  assert.doesNotMatch(text, /diga/, 'no spoken alternative announced');

  assert.deepStrictEqual(playIds(session.onDtmf(2)), ['sched_retry_hint', 'ask_sched_window'],
    'DTMF 2 declines a single-slot offer');
});

test('a stray keypress replays the question it landed on', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  assert.deepStrictEqual(playIds(session.onDtmf(9)), ['ask_sched_window'], 'fumble at the window question');
  session.onDtmf(3); // answered

  session.onDtmf(9); // fumble at the offer — replays the offer text
  session.onDtmf(1); // pick the first slot

  const replay = session.onDtmf(9); // fumble at the confirmation
  assert.match(replay.find((a) => a.type === 'playText').text, /¿Se la confirmo\?/,
    'confirmation fumble replays the slot, not "¿podría repetirlo?"');
  assert.ok(!session.ended, 'fumbles never end the call');

  const final = session.onDtmf(1);
  assert.ok(final.some((a) => a.type === 'hangup'), 'the booking still lands');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 1);
});

test('a suggested date in the past explains itself and re-asks for a date', async () => {
  const extract = fakeExtract([
    ...postOpFields(),
    { field: 'preferredDate', value: { date: '2026-07-01' } },
    { field: 'preferredDate', value: { date: '2026-07-29' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  session.onDtmf(4);
  const past = await session.onTranscript('el primero de julio');
  assert.deepStrictEqual(playIds(past), ['date_in_past', 'ask_preferred_date']);

  const offer = await session.onTranscript('el veintinueve');
  assert.match(offer.find((a) => a.type === 'playText').text, /miércoles 29 de julio/);
});

test('a week-wide window offers two different days, not two times the same morning', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  const text = session.onDtmf(3).find((a) => a.type === 'playText').text;
  assert.match(text, /lunes 27 de julio/);
  assert.match(text, /martes 28 de julio/, 'second option comes from a different day');
});

test('DTMF works end-to-end in scheduling: window, slot, confirmation', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  session.onDtmf(3); // window: next week
  session.onDtmf(2); // second slot
  const final = session.onDtmf(1); // 1 = sí
  assert.ok(final.some((a) => a.type === 'hangup'));
  assert.ok(final.some((a) => a.type === 'calendarSync'),
    'a booking nudges the calendar mirror');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 1);
});

test('window with no availability proposes the next available slot', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  // Friday caller asking for "esta semana": only Sat/Sun remain -> nothing
  // in the window, so the nearest slot after it (Monday) is offered.
  const noSlots = session.onDtmf(2);
  assert.deepStrictEqual(playIds(noSlots), ['slots_none_window'],
    'a multi-day window keeps the plural "esas fechas" prompt');
  assert.match(noSlots.find((a) => a.type === 'playText').text,
    /La próxima cita disponible es el lunes 27 de julio/);

  // Declining the proposal goes back to the window question.
  assert.deepStrictEqual(playIds(session.onDtmf(2)), ['sched_retry_hint', 'ask_sched_window']);
});

test('fully-booked single day says "ese día" and books the proposed nearest slot', async () => {
  // Book out today (Friday) entirely; Monday 9:00 becomes the nearest slot.
  for (const time of appointments.SLOT_TIMES) {
    appointments.bookAppointment(db, { patientType: 'new', date: '2026-07-24', time });
  }
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  const noSlots = session.onDtmf(1); // hoy -> fully booked
  assert.deepStrictEqual(playIds(noSlots), ['slots_none_day'],
    'a single day gets the singular "ese día" prompt, not "esas fechas"');
  assert.match(noSlots.find((a) => a.type === 'playText').text,
    /La próxima cita disponible es el lunes 27 de julio a las nueve de la mañana/);

  // Accepting the proposal runs through the normal confirm -> book path.
  session.onDtmf(1);
  const final = session.onDtmf(1);
  assert.ok(final.some((a) => a.type === 'hangup'));
  const appt = db.prepare("SELECT * FROM appointments WHERE patient_type = 'post_op'").get();
  assert.strictEqual(appt.scheduled_date, '2026-07-27');
  assert.strictEqual(appt.scheduled_time, '09:00');
});

test('"today" window offers same-day slots', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  const offer = session.onDtmf(1); // hoy (Friday, 8am -> 09:00 and 11:00 offered)
  assert.match(offer.find((a) => a.type === 'playText').text, /viernes 24 de julio/);
});

test('suggesting a date: DTMF 4 asks for it, spoken date narrows to that day', async () => {
  const extract = fakeExtract([
    ...postOpFields(),
    { field: 'preferredDate', value: { date: '2026-07-29' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);

  assert.deepStrictEqual(playIds(session.onDtmf(4)), ['ask_preferred_date']);
  const offer = await session.onTranscript('el miércoles que viene');
  assert.match(offer.find((a) => a.type === 'playText').text, /miércoles 29 de julio/);

  session.onDtmf(1); // first slot that day
  const final = session.onDtmf(1); // 1 = sí
  assert.ok(final.some((a) => a.type === 'hangup'));
  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.scheduled_date, '2026-07-29');
});

test('keys at the spoken-date question replay it — keys do not encode a date', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);
  session.onDtmf(4); // -> sched_date

  assert.deepStrictEqual(playIds(session.onDtmf(7)), ['ask_preferred_date']);
  assert.strictEqual(session.state, 'sched_date', 'still waiting on the spoken date');
});

// --- * = start over --------------------------------------------------------

test('* returns to the main menu mid-flow and clears everything collected', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Ana', last_name: 'Ruiz' } },
    // after the reset: post-op path
    ...postOpFields(),
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
  await sayPostOpIntake(session);
  session.onDtmf(3); // next week
  session.onDtmf(1); // first slot
  session.onDtmf(1); // sí

  const appt = db.prepare('SELECT * FROM appointments').get();
  assert.strictEqual(appt.patient_type, 'post_op');
  // The completed post-op booking creates its own patient row (Juan); the
  // abandoned new-patient path must have left nothing behind.
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM patients WHERE first_name = 'Ana'").get().n, 0,
    'abandoned new-patient path created no record');
});

test('* works from anywhere in scheduling too', async () => {
  const extract = fakeExtract(postOpFields());
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(3);
  await sayPostOpIntake(session);
  assert.strictEqual(session.state, 'sched_window');

  session.onDtmf(3); // into the concrete offer
  assert.strictEqual(session.state, 'offer');
  assert.deepStrictEqual(playIds(session.onDtmf('*')), ['greeting_menu']);
  assert.strictEqual(session.state, 'menu');
});

// --- 0 = a human -------------------------------------------------------
// The clinic's callers are mostly elderly; a caller who wants a person must
// be able to get one from any point in the call, without having to work out
// which state the IVR thinks it's in. This is the ONLY transfer in the call.

test('0 hands off to the scheduling team from the main menu', () => {
  const session = new CallSession({ db, now: FIXED_NOW, extract: fakeExtract([]) });
  session.start();

  const actions = session.onDtmf(0);
  assert.deepStrictEqual(playIds(actions), ['handoff_operator']);
  assert.strictEqual(actions.find((a) => a.type === 'transfer').reason, 'caller_request');
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
  assert.strictEqual(actions.find((a) => a.type === 'transfer').reason, 'caller_request');
  assert.ok(session.ended);
  assert.deepStrictEqual(session.data, {}, 'nothing collected is stored on a bail-out');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM patients').get().n, 0);

  // inside scheduling
  const sched = new CallSession({ db, now: FIXED_NOW, extract: fakeExtract(postOpFields()) });
  sched.start();
  sched.onDtmf(3);
  await sayPostOpIntake(sched);
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

// Reaches the first read-back of the new-patient flow: "Entendí que su
// nombre es María García. ¿Es correcto?" now playing.
async function sessionAtNameReadback(extraScript = []) {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    ...extraScript,
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1); // new patient
  await session.onTranscript('me llamo María García');
  assert.strictEqual(session.state, 'verify');
  return { session, extract };
}

test('a spoken sí/no at the read-back replays it — confirmations are keypad-only', async () => {
  const { session, extract } = await sessionAtNameReadback();
  const callsBefore = extract.calls.length;

  for (const t of ['sí, es correcto', 'no, está mal', 'Gracias.']) {
    const actions = await session.onTranscript(t);
    assert.strictEqual(readbackText(actions), 'Entendí que su nombre es María García.',
      'the read-back sentence itself replays');
    assert.deepStrictEqual(playIds(actions), ['confirm_field'], 'key instructions replay too');
    assert.strictEqual(session.state, 'verify', 'still waiting on a keypress');
  }
  assert.strictEqual(extract.calls.length, callsBefore,
    'no extraction spent on speech that cannot be accepted');
  assert.strictEqual(session.data.fullName, undefined, 'nothing committed');
  assert.ok(session.pending, 'nothing discarded either — a spoken "no" must not guess');

  // the keys still do their job
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_dob']);
  assert.deepStrictEqual(session.data.fullName, { first_name: 'María', last_name: 'García' });
});

test('rejecting a read-back (key 2) re-asks the same question and drops the wrong value', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'Marta', last_name: 'Arce' } },
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);
  await session.onTranscript('me llamo María García'); // misheard

  const retry = session.onDtmf(2);
  assert.deepStrictEqual(playIds(retry), ['retry_field', 'ask_full_name']);
  assert.strictEqual(session.state, 'collect');
  assert.deepStrictEqual(session.data, {}, 'the rejected value is gone');

  const secondTry = await session.onTranscript('María García');
  assert.strictEqual(readbackText(secondTry), 'Entendí que su nombre es María García.');
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_dob']);
});

test('an unmapped key at the read-back replays it instead of guessing', async () => {
  const { session } = await sessionAtNameReadback();
  const replay = session.onDtmf(7);
  assert.strictEqual(readbackText(replay), 'Entendí que su nombre es María García.');
  assert.deepStrictEqual(playIds(replay), ['confirm_field']);
  assert.strictEqual(session.state, 'verify', 'still waiting on 1 or 2');
});

test('read-backs are Spanish and speak digits one at a time', () => {
  const { fieldReadbackText } = require('../prompts');

  assert.strictEqual(
    fieldReadbackText('phone', { phone: '7874902081' }),
    'Entendí que su teléfono es 7 8 7, 4 9 0, 2 0 8 1.',
  );
  assert.strictEqual(
    fieldReadbackText('surgeryDate', { date: '2026-07-20' }),
    'Entendí que su operación fue el 20 de julio de 2026.',
  );
  assert.strictEqual(
    fieldReadbackText('hospital', { hospital: 'el Hospital Auxilio Mutuo' }),
    'Entendí que su operación fue en el Hospital Auxilio Mutuo.',
  );

  // A field with no formatter, or a value that can't be formatted, yields
  // null — the session then keeps the answer instead of asking a question
  // the caller never heard.
  assert.strictEqual(fieldReadbackText('unknownField', { anything: 1 }), null);
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
    surgeryDate: { date: '2026-07-20' },
    hospital: { hospital: 'el Hospital Auxilio Mutuo' },
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
  assert.deepStrictEqual(playIds(afterCompany), ['vital_referral_reminder', 'ask_sched_window']);
});

test('commercial full call never plays the Vital referral reminder', async () => {
  const extract = fakeExtract([
    { field: 'fullName', value: { first_name: 'María', last_name: 'García' } },
    { field: 'dob', value: { dob: '1985-03-12' } },
    { field: 'phone', value: { phone: '5551234567' } },
    { field: 'insuranceType', value: { insurance_type: 'commercial', provider: null } },
    { field: 'insurance', value: { provider: 'MCS' } },
  ]);
  const session = new CallSession({ db, now: FIXED_NOW, extract });
  session.start();
  session.onDtmf(1);

  const played = [];
  for (const t of ['María García', 'doce de marzo del ochenta y cinco', 'cinco cinco cinco',
    'es comercial', 'MCS']) {
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
  // ...and confirming it jumps straight to scheduling, no company question
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['ask_sched_window']);

  session.onDtmf(3); // next week
  session.onDtmf(1); // first slot
  session.onDtmf(1); // sí

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
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['vital_referral_reminder', 'ask_sched_window']);
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
  assert.deepStrictEqual(playIds(session.onDtmf(1)), ['vital_referral_reminder', 'ask_sched_window']);
});

test('spanishDate formatting used in offers is correct Spanish', () => {
  const { spanishDate, spanishTime } = require('../prompts');
  assert.strictEqual(spanishDate('2026-07-27'), 'el lunes 27 de julio');
  assert.strictEqual(spanishDate('2026-08-01'), 'el sábado 1 de agosto');
  assert.strictEqual(spanishTime('14:00'), 'a las dos de la tarde');
});
