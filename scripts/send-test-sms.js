#!/usr/bin/env node
// Fire one real confirmation SMS through the configured Twilio account so
// the credentials, from-number, and message copy can be verified without
// placing a full test call. Sends exactly the template a booked call sends.
//
//   node --env-file-if-exists=.env scripts/send-test-sms.js <to-number> [YYYY-MM-DD] [HH:MM]
//
// Defaults to a slot tomorrow at 09:00 if no date/time is given.

const { sendSms } = require('../src/server/index');
const { smsConfirmationText } = require('../src/server/prompts');

const [to, date, time] = process.argv.slice(2);
if (!to) {
  console.error('usage: node --env-file-if-exists=.env scripts/send-test-sms.js <to-number> [YYYY-MM-DD] [HH:MM]');
  process.exit(1);
}
if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`bad date "${date}" — expected YYYY-MM-DD`);
  process.exit(1);
}
if (time && !/^\d{2}:\d{2}$/.test(time)) {
  console.error(`bad time "${time}" — expected HH:MM (24h)`);
  process.exit(1);
}

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

(async () => {
  const slot = { date: date || tomorrow(), time: time || '09:00' };
  const text = smsConfirmationText(slot);
  console.log(`sending to ${to}:\n---\n${text}\n---`);
  const ok = await sendSms(to, text);
  console.log(ok ? 'sent' : 'NOT sent — see the warning/error above');
  process.exit(ok ? 0 : 1);
})();
