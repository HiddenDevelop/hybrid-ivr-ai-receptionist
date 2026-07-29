const { test } = require('node:test');
const assert = require('node:assert');
const { checkRedFlags, normalize } = require('./redFlags');

test('normalize strips diacritics, lowercases, marks clause boundaries', () => {
  assert.strictEqual(normalize('Presión en el PECHO'), 'presion en el pecho');
  assert.strictEqual(normalize('Fíebre'), 'fiebre');
  assert.strictEqual(normalize('No, estoy sangrando.'), 'no | estoy sangrando |');
});

test('direct trigger phrases match', () => {
  assert.ok(checkRedFlags('tengo fiebre'));
  assert.ok(checkRedFlags('hay sangrado abundante en la herida'));
  assert.ok(checkRedFlags('siento dolor de pecho'));
  assert.ok(checkRedFlags('no puedo respirar bien'));
  assert.ok(checkRedFlags('mi esposo está inconsciente'));
});

test('plain first-person bleeding matches (real-call regression)', () => {
  assert.ok(checkRedFlags('estoy sangrando'));
  assert.ok(checkRedFlags('es que estoy sangrando un poquito'));
  assert.ok(checkRedFlags('estoy botando sangre'));
  assert.ok(checkRedFlags('me sale sangre de la herida'));
  assert.ok(checkRedFlags('tengo sangrado'));
});

test('denials of symptoms do NOT trigger (negation awareness)', () => {
  assert.strictEqual(checkRedFlags('no tengo fiebre'), null);
  assert.strictEqual(checkRedFlags('no tengo fiebre ni sangrado'), null);
  assert.strictEqual(checkRedFlags('sin sangrado, la herida está bien'), null);
  assert.strictEqual(checkRedFlags('no estoy sangrando'), null);
  assert.strictEqual(checkRedFlags('nada de fiebre, me siento bien'), null);
});

test('a standalone "no" answering a prior question does not negate the next clause', () => {
  assert.ok(checkRedFlags('no, estoy sangrando'));
  assert.ok(checkRedFlags('no. tengo mucha fiebre'));
});

test('phrases that contain their own negation always match', () => {
  assert.ok(checkRedFlags('no puedo respirar'));
  assert.ok(checkRedFlags('es que no para de sangrar'));
  // even with a stray negator before them
  assert.ok(checkRedFlags('no no puedo respirar'));
});

test('triggers survive surrounding filler speech', () => {
  assert.ok(checkRedFlags('pues es que desde ayer tengo mucha fiebre y escalofríos'));
  assert.ok(checkRedFlags('la verdad no para de sangrar aunque le puse una venda'));
  assert.ok(checkRedFlags('mi mamá dice que le falta el aire cuando camina'));
});

test('triggers match regardless of accents or casing in the transcript', () => {
  assert.ok(checkRedFlags('SE DESMAYÓ en el baño'));
  assert.ok(checkRedFlags('tiene presión en el pecho'));
  assert.ok(checkRedFlags('perdió el conocimiento un momento'));
  // Whisper sometimes drops accents entirely
  assert.ok(checkRedFlags('se desmayo en el bano'));
});

test('post-op wound emergencies match', () => {
  assert.ok(checkRedFlags('creo que se me abrió la herida'));
  assert.ok(checkRedFlags('sale pus en la herida'));
});

test('benign post-op answers do NOT trigger', () => {
  assert.strictEqual(checkRedFlags('me siento bien, solo un poco de dolor'), null);
  assert.strictEqual(checkRedFlags('la herida se ve bien, sin problemas'), null);
  assert.strictEqual(checkRedFlags('quiero una cita para la próxima semana'), null);
  assert.strictEqual(checkRedFlags('el drenaje tiene poco líquido'), null);
});

test('near-misses do not trigger', () => {
  // mentions blood/chest but not an emergency phrase
  assert.strictEqual(checkRedFlags('me sacaron sangre para los análisis'), null);
  assert.strictEqual(checkRedFlags('la cirugía fue en el pecho'), null);
  assert.strictEqual(checkRedFlags('respirar profundo me molesta un poquito'), null);
});

test('word-boundary matching: "sangrado" does not match inside other words', () => {
  assert.strictEqual(checkRedFlags('el consangrado...'), null);
});

test('empty or missing transcript is not a trigger', () => {
  assert.strictEqual(checkRedFlags(''), null);
  assert.strictEqual(checkRedFlags(null), null);
  assert.strictEqual(checkRedFlags(undefined), null);
});
