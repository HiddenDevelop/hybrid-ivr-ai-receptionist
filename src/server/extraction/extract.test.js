const { test } = require('node:test');
const assert = require('node:assert');
const { extractField, isConfident } = require('./extract');

// Ollama double: returns a canned JSON body for whatever prompt arrives.
function fakeOllama(response) {
  return async () => ({
    ok: true,
    json: async () => ({ response: JSON.stringify(response) }),
  });
}

test('a valid extraction below the confidence bar is not accepted', async () => {
  const result = await extractField('insurance', 'triple ese', {
    fetchImpl: fakeOllama({ provider: 'Triple-S', confidence: 0.55 }),
  });
  assert.ok(result.ok);
  assert.ok(!isConfident(result), 'insurance at 0.55 must still re-prompt');
});

test('isConfident: error path rejected, confident result accepted', () => {
  assert.ok(!isConfident({ ok: false, value: null, confidence: 0 }));
  assert.ok(isConfident({ ok: true, value: {}, confidence: 0.9 }));
});
