const { test } = require('node:test');
const assert = require('node:assert');

// Confirmations are keypad-only by design (no FIELD_CONFIRM flags anymore):
// the read-back question and every offer/confirmation sentence must announce
// keys and must NOT invite a spoken answer.
test('confirm_field announces the 1/2 keys and never mentions speaking', () => {
  const { PROMPTS } = require('./prompts');
  assert.match(PROMPTS.confirm_field, /Oprima uno/);
  assert.doesNotMatch(PROMPTS.confirm_field, /[Dd]iga|decir/);
});

test('offer and confirmation sentences are keypad-only too', () => {
  const { slotOfferText, nearestSlotOfferText, confirmSlotText, PROMPTS } = require('./prompts');
  const one = [{ date: '2026-07-27', time: '09:00' }];
  const two = [...one, { date: '2026-07-28', time: '11:00' }];
  for (const text of [
    slotOfferText(one), slotOfferText(two), nearestSlotOfferText(one[0]), confirmSlotText(one[0]),
    PROMPTS.ask_phone_caller_id,
  ]) {
    assert.match(text, /[Oo]prima/);
    assert.doesNotMatch(text, /[Dd]iga|decir/);
  }
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
