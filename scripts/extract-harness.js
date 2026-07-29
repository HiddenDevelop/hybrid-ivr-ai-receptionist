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
  ['allergies', 'penicilina', (v) => /penicilina/i.test(v.allergies)],
  ['reason', 'dolor en el abdomen', (v) => v.reason.length > 0],
  ['surgeryDate', 'veinte de julio', (v) => /-07-20$/.test(v.date || '')],
  ['schedWindow', 'la semana que viene', (v) => v.window === 'next_week'],
  ['preferredDate', 'cinco de agosto', (v) => /-08-05$/.test(v.date || '')],
  ['slotChoice', 'la segunda', (v) => v.choice === 'second'],
  ['yesNo', 'sí', (v) => v.answer === 'yes'],
  ['referringProvider', 'doctor Soto', (v) => /soto/i.test(v.provider_name)],
];

// A lone surname is NOT a full name: it must re-prompt, not write a patient
// row with a blank first name. Expected to come back not-confident/invalid.
const MUST_REJECT = [
  ['fullName', 'Soto'],
];

const CASES = [
  ...BARE_CASES,
  ['patientType', 'soy paciente nuevo, nunca he venido', (v) => v.patient_type === 'new'],
  ['patientType', 'me operaron la semana pasada aquí', (v) => v.patient_type === 'post_op'],
  ['fullName', 'me llamo María Guadalupe Hernández', (v) => /mar/i.test(v.first_name)],
  ['dob', 'nací el doce de marzo de mil novecientos ochenta y cinco', (v) => v.dob === '1985-03-12'],
  ['phone', 'mi número es cinco cinco cinco, uno dos tres, cuatro cinco seis siete', (v) => String(v.phone).replace(/\D/g, '').endsWith('5551234567')],
  ['insurance', 'tengo Aetna, la póliza es A B uno dos tres', (v) => /aetna/i.test(v.provider)],
  ['insurance', 'tengo triple ese', (v) => /triple/i.test(v.provider)],
  ['insurance', 'mi plan es MCS, no tengo el número a mano', (v) => /mcs/i.test(v.provider)],
  ['allergies', 'soy alérgica a la penicilina', (v) => /penicilina/i.test(v.allergies)],
  ['allergies', 'no, ninguna que yo sepa', (v) => /ningun/i.test(v.allergies)],
  ['reason', 'es una revisión de rutina después de mi consulta', (v) => /revisión de rutina/i.test(v.reason)],
  ['mrnOrPhone', 'mi expediente es P cuatro cinco seis siete ocho nueve', (v) => Boolean(v.mrn)],
  ['surgeryDate', 'me operaron el veinte de julio de este año',
    (v) => v.date === `${new Date().getFullYear()}-07-20`],
  ['symptoms', 'no tengo fiebre, la herida está bien, el dolor es como un tres', (v) => v.fever === false && v.pain_level === 3],
  ['authorization', 'sí, el número de autorización es A U T H cuatro dos', (v) => v.has_authorization === true],
  ['referringProvider', 'me manda el doctor Soto, su fax es cinco cinco cinco dos dos dos', (v) => /soto/i.test(v.provider_name)],
  ['procedureType', 'es para una consulta de vesícula, posible colecistectomía', (v) => v.procedure.length > 0],
  ['schedWindow', 'para hoy, si se puede', (v) => v.window === 'today'],
  ['schedWindow', 'mejor la semana que viene', (v) => v.window === 'next_week'],
  ['schedWindow', 'el cinco de agosto', (v) => v.window === 'specific' && /-08-05$/.test(v.date || '')],
  ['preferredDate', 'el cinco de agosto, por favor', (v) => /-08-05$/.test(v.date || '')],
  ['slotChoice', 'la segunda opción está mejor', (v) => v.choice === 'second'],
  ['yesNo', 'sí, está bien, confirmo', (v) => v.answer === 'yes'],
  ['yesNo', 'no, esa hora no me sirve', (v) => v.answer === 'no'],
  // barge-in fragment / Whisper near-silence hallucination: NOT an answer —
  // a guessed "no" here discards a value the caller had confirmed correct
  ['yesNo', 'Gracias.', (v) => v.answer === 'unknown'],
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
