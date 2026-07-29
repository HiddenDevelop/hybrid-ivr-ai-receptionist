const { test } = require('node:test');
const assert = require('node:assert');
const { extractField, isConfident, buildPrompt, CONFIDENCE_THRESHOLD } = require('./extract');
const { specs } = require('./schemas');

// Ollama double: returns a canned JSON body for whatever prompt arrives.
function fakeOllama(response) {
  return async () => ({
    ok: true,
    json: async () => ({ response: JSON.stringify(response) }),
  });
}

test('reason accepts below the global bar (per-field minConfidence)', async () => {
  const result = await extractField('reason', 'una consulta', {
    fetchImpl: fakeOllama({ reason: 'una consulta', confidence: 0.55 }),
  });
  assert.ok(result.ok);
  assert.ok(result.confidence < CONFIDENCE_THRESHOLD, 'test premise: below the global bar');
  assert.ok(isConfident(result), 'reason at 0.55 should pass its lowered bar');
});

test('fields without minConfidence still use the global bar', async () => {
  const result = await extractField('insurance', 'triple ese', {
    fetchImpl: fakeOllama({ provider: 'Triple-S', confidence: 0.55 }),
  });
  assert.ok(result.ok);
  assert.ok(!isConfident(result), 'insurance at 0.55 must still re-prompt');
});

test('results with no threshold (e.g. error path) fall back to the global bar', () => {
  assert.ok(!isConfident({ ok: false, value: null, confidence: 0 }));
  assert.ok(isConfident({ ok: true, value: {}, confidence: 0.9 }));
});

test('reason spec rejects an empty extracted reason', () => {
  assert.ok(!specs.reason.validate({ reason: '   ' }));
  assert.ok(specs.reason.validate({ reason: 'dolor abdominal' }));
});

test('reason is free text — no category/classification field in the schema', () => {
  assert.ok(!specs.reason.schema.includes('concerning'), 'reason must not be boxed into routine/concerning');
  assert.match(specs.reason.instruction, /never reduce it to a category/i);
});

test('reason prompt forbids translating the value out of Spanish', () => {
  const prompt = buildPrompt(specs.reason, 'me duele el estómago');
  assert.match(prompt, /never translate/i);
  assert.match(prompt, /in Spanish/);
});
