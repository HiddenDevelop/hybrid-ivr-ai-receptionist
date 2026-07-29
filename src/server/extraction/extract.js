// Thin wrapper around local Ollama for single-shot, JSON-only field
// extraction. Never conversational: one small prompt in, one small JSON
// object out. If a field seems to need back-and-forth, that's a
// human-escalation signal, not a reason to grow this prompt.

const { specs } = require('./schemas');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

const CONFIDENCE_THRESHOLD = 0.7;

function buildPrompt(spec, transcript, today = new Date().toISOString().slice(0, 10)) {
  const dateLine = spec.needsToday ? `Today is ${today}.\n` : '';
  return `${spec.instruction} The caller spoke Spanish. Respond with JSON only, no prose.\n`
    + dateLine
    + `Schema: ${spec.schema}\n`
    + `Include "confidence" 0-1: how sure you are the answer contains this field.\n`
    + `Caller said: "${transcript}"`;
}

// Extracts one field from a Spanish transcript. Always resolves to
//   { ok, value, confidence, latencyMs }
// ok=false covers model errors, unparseable JSON, and shape-validation
// failures — all treated by callers exactly like low confidence (re-prompt,
// then 3-strike bailout to a human).
async function extractField(fieldName, transcript, { fetchImpl = fetch } = {}) {
  const spec = specs[fieldName];
  if (!spec) throw new Error(`unknown extraction field: ${fieldName}`);

  const started = Date.now();
  try {
    const res = await fetchImpl(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: buildPrompt(spec, transcript),
        format: 'json',
        stream: false,
        keep_alive: '30m', // keep the model resident between turns
        options: { temperature: 0, num_predict: 120 },
      }),
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const body = await res.json();
    const value = JSON.parse(body.response);

    const confidence = typeof value.confidence === 'number'
      ? Math.max(0, Math.min(1, value.confidence))
      : 0;
    const shapeOk = spec.validate(value);

    // Logged for every field: without this a re-prompt is indistinguishable
    // from bad STT in the call log, and the transcript above it looks fine.
    console.log(
      `[extract] ${fieldName} ${Date.now() - started}ms conf=${confidence.toFixed(2)}`
      + `${shapeOk ? '' : ' SHAPE-FAIL'} <- "${transcript}" -> ${body.response.replace(/\s+/g, ' ')}`,
    );

    return {
      ok: shapeOk,
      value: shapeOk ? value : null,
      confidence: shapeOk ? confidence : 0,
      latencyMs: Date.now() - started,
      // Fields may lower the global bar (spec.minConfidence) — e.g. the
      // visit reason, where nearly any answer is acceptable and the
      // read-back confirmation catches mistakes anyway.
      threshold: spec.minConfidence ?? CONFIDENCE_THRESHOLD,
    };
  } catch (err) {
    console.log(`[extract] ${fieldName} FAILED after ${Date.now() - started}ms: ${err}`);
    return { ok: false, value: null, confidence: 0, latencyMs: Date.now() - started, error: String(err) };
  }
}

// Pull the model into VRAM at startup. qwen2.5:14b is ~9.5GB and takes
// ~8.5s to load, which otherwise lands on the first caller's first answer
// (and on any caller arriving after the keep_alive window expires on an
// idle line). Non-fatal: a failure here just means that cost comes back.
async function warmUp({ fetchImpl = fetch } = {}) {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: 'ok',
        format: 'json',
        stream: false,
        keep_alive: '30m',
        options: { temperature: 0, num_predict: 1 },
      }),
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    await res.json();
    console.log(`ollama ready (${OLLAMA_MODEL} resident in ${Date.now() - started}ms)`);
    return true;
  } catch (err) {
    console.warn(`ollama warm-up failed (${err}) — the first caller pays the model load`);
    return false;
  }
}

function isConfident(result) {
  return result.ok && result.confidence >= (result.threshold ?? CONFIDENCE_THRESHOLD);
}

module.exports = { extractField, isConfident, buildPrompt, warmUp, CONFIDENCE_THRESHOLD };
