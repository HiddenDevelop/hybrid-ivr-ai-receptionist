// Canned-Spanish-transcript harness for the extraction layer. Runs each
// field against realistic caller answers, checks shape + plausibility, and
// prints per-call latency (the number that has to stay inside the
// ~800ms-1.5s per-turn budget together with STT).
//
// Needs Ollama running locally with qwen2.5:14b. Run:
//   node scripts/extract-harness.js

const { extractField, isConfident } = require('../src/server/extraction/extract');

// Bare, unframed answers — how callers actually reply to a direct question
// ("¿su nombre completo?" -> "Michael Santiago", not "me llamo..."). Keep
// these FIRST and keep adding them: every case below used to be a framed
// sentence, so the suite passed 24/24 while a real call re-prompted on a
// bare name. A framed-only harness does not test the prompts you shipped.
const BARE_CASES = [
  ['fullName', 'Michael Santiago', (v) => v.first_name === 'Michael' && /santiago/i.test(v.last_name)],
  ['fullName', 'María Hernández', (v) => /mar/i.test(v.first_name) && /hern/i.test(v.last_name)],
  ['dob', 'doce de marzo de mil novecientos ochenta y cinco', (v) => v.dob === '1985-03-12'],
  ['phone', 'siete ocho siete cuatro cero tres cero uno dos tres', (v) => String(v.phone).replace(/\D/g, '') === '7874030123'],
  ['insurance', 'triple ese', (v) => /triple/i.test(v.provider)],
  ['surgeryDate', 'veinte de julio', (v) => /-07-20$/.test(v.date || '')],
  ['preferredDate', 'cinco de agosto', (v) => /-08-05$/.test(v.date || '')],
];

// Answers that must NOT be accepted. A lone surname is not a full name: it
// must re-prompt, not write a patient row with a blank first name. And a
// bare affirmation is not a phone number: the caller-ID offer is a keypad
// question now, so by the time the phone schema runs the caller is
// dictating digits — the model must never fabricate them from a "sí".
const MUST_REJECT = [
  ['fullName', 'Soto'],
  ['phone', 'sí, a este mismo número'],
];

const CASES = [
  ...BARE_CASES,
  ['fullName', 'me llamo María Guadalupe Hernández', (v) => /mar/i.test(v.first_name)],
  ['dob', 'nací el doce de marzo de mil novecientos ochenta y cinco', (v) => v.dob === '1985-03-12'],
  ['phone', 'mi número es cinco cinco cinco, uno dos tres, cuatro cinco seis siete', (v) => String(v.phone).replace(/\D/g, '').endsWith('5551234567')],
  ['insurance', 'tengo Aetna, la póliza es A B uno dos tres', (v) => /aetna/i.test(v.provider)],
  ['insurance', 'tengo triple ese', (v) => /triple/i.test(v.provider)],
  ['insurance', 'mi plan es MCS, no tengo el número a mano', (v) => /mcs/i.test(v.provider)],
  ['surgeryDate', 'me operaron el veinte de julio de este año',
    (v) => v.date === `${new Date().getFullYear()}-07-20`],
  ['hospital', 'me operaron en el Auxilio Mutuo', (v) => /auxilio/i.test(v.hospital)],
  ['hospital', 'en el Hospital Menonita de Caguas', (v) => /menonita/i.test(v.hospital)],
  ['preferredDate', 'el cinco de agosto', (v) => /-08-05$/.test(v.date || '')],
  ['preferredDate', 'el cinco de agosto, por favor', (v) => /-08-05$/.test(v.date || '')],
];

async function main() {
  let pass = 0;
  const latencies = [];
  for (const [field, transcript, check] of CASES) {
    const result = await extractField(field, transcript);
    latencies.push(result.latencyMs);
    const plausible = result.ok && check(result.value);
    const confident = isConfident(result);
    const status = plausible && confident ? 'PASS' : plausible ? 'LOWCONF' : 'FAIL';
    if (status === 'PASS') pass += 1;
    console.log(
      `${status.padEnd(7)} ${String(result.latencyMs).padStart(5)}ms  conf=${result.confidence.toFixed(2)}  `
      + `${field.padEnd(18)} "${transcript}"  -> ${JSON.stringify(result.value)}${result.error ? ` (${result.error})` : ''}`,
    );
  }
  let rejectPass = 0;
  for (const [field, transcript] of MUST_REJECT) {
    const result = await extractField(field, transcript);
    latencies.push(result.latencyMs);
    const rejected = !isConfident(result);
    if (rejected) rejectPass += 1;
    console.log(
      `${(rejected ? 'REJECT' : 'LEAKED').padEnd(7)} ${String(result.latencyMs).padStart(5)}ms  conf=${result.confidence.toFixed(2)}  `
      + `${field.padEnd(18)} "${transcript}"  -> ${JSON.stringify(result.value)} (must NOT be accepted)`,
    );
  }

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const total = CASES.length + MUST_REJECT.length;
  console.log(`\n${pass + rejectPass}/${total} passed (${pass}/${CASES.length} extracted, ${rejectPass}/${MUST_REJECT.length} correctly rejected)`
    + ` | extraction latency p50=${p50}ms p95=${p95}ms (budget: extraction + STT within ~800-1500ms)`);
  process.exit(pass === CASES.length && rejectPass === MUST_REJECT.length ? 0 : 1);
}

main();
