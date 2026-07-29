const { test } = require('node:test');
const assert = require('node:assert');

// PROMPTS is built once at module load from process.env, so each case sets
// the flag and re-requires a fresh copy of the module.
function loadPrompts(env) {
  const prev = process.env.FIELD_CONFIRM_DTMF;
  if (env === undefined) delete process.env.FIELD_CONFIRM_DTMF;
  else process.env.FIELD_CONFIRM_DTMF = env;
  delete require.cache[require.resolve('./prompts')];
  const { PROMPTS } = require('./prompts');
  if (prev === undefined) delete process.env.FIELD_CONFIRM_DTMF;
  else process.env.FIELD_CONFIRM_DTMF = prev;
  delete require.cache[require.resolve('./prompts')];
  return PROMPTS;
}

test('confirm_field defaults to voice-only sí/no', () => {
  const PROMPTS = loadPrompts(undefined);
  assert.match(PROMPTS.confirm_field, /Diga sí o no/);
  assert.doesNotMatch(PROMPTS.confirm_field, /[Oo]prima/);
});

test('FIELD_CONFIRM_DTMF=true reverts to announcing the 1/2 keys', () => {
  const PROMPTS = loadPrompts('true');
  assert.match(PROMPTS.confirm_field, /Oprima uno/);
  assert.match(PROMPTS.confirm_field, /decir sí o no/);
});

// smsConfirmationText reads CLINIC_NAME/CLINIC_ADDRESS at call time, so no
// module reload is needed — just set/clear the env around the call.
test('SMS carries the slot in written form: weekday, full date, numeric time', () => {
  delete process.env.CLINIC_NAME;
  delete process.env.CLINIC_ADDRESS;
  const { smsConfirmationText } = require('./prompts');
  const text = smsConfirmationText({ date: '2026-07-27', time: '14:00' });
  assert.match(text, /^Clínica de Cirugía General:/);
  assert.match(text, /cita quedó confirmada/);
  assert.match(text, /lunes 27 de julio de 2026, 2:00 p\. m\./);
  assert.doesNotMatch(text, /Dirección/);
  assert.match(text, /llame a este mismo número/);
  assert.doesNotMatch(text, /\b(undefined|null|NaN)\b/);
});

test('SMS uses CLINIC_NAME and adds the address line when configured', () => {
  process.env.CLINIC_NAME = 'Clínica Vista del Mar';
  process.env.CLINIC_ADDRESS = 'Ave. Principal 123, Mayagüez, PR 00680';
  try {
    const { smsConfirmationText } = require('./prompts');
    const text = smsConfirmationText({ date: '2026-07-28', time: '09:00' });
    assert.match(text, /^Clínica Vista del Mar:/);
    assert.match(text, /Dirección: Ave\. Principal 123, Mayagüez, PR 00680\./);
    assert.match(text, /martes 28 de julio de 2026, 9:00 a\. m\./);
  } finally {
    delete process.env.CLINIC_NAME;
    delete process.env.CLINIC_ADDRESS;
  }
});
