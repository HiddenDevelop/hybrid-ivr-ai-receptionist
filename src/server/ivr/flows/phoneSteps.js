// Shared phone-collection step pair, used by every flow that asks for a
// contact number. With a Twilio caller ID the first step is a keypad
// question — 1 uses the number the caller is calling from, 2 moves on to
// dictating one; without a caller ID the flow goes straight to dictation.

// "+17875550000" (TwiML caller ID is E.164) -> "7875550000": the DB, the
// digit-group read-back, and sendSms's +1 prefix all expect the 10-digit
// national form.
const nationalDigits = (number) => String(number).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

const phoneSteps = [
  {
    field: 'phone',
    promptId: 'ask_phone_caller_id',
    skip: (s) => !s.callerPhone,
    keys: (session, n) => {
      // 1 = use the caller-ID number. Still read back digit by digit for
      // the 1/2 confirmation: a caller ID can be an office line or a
      // relative's phone, so it is never committed unheard. Confidence 1 —
      // no extraction happened, so it must not drag minConfidence down.
      if (n === 1) {
        return session.stageForVerify('phone', { phone: nationalDigits(session.callerPhone) }, 1);
      }
      // 2 = dictate a number: skip ahead to the spoken variant without
      // committing anything.
      if (n === 2) {
        session.stepIndex += 1;
        return session.advanceStep();
      }
      return null; // engine replays the question
    },
  },
  {
    field: 'phone',
    promptId: 'ask_phone',
    // Skipped only once a phone committed (the press-1 path); when the
    // caller pressed 2 — or there was no caller ID — it must still be asked.
    skip: (s) => Boolean(s.data.phone),
  },
];

module.exports = { phoneSteps };
