// Thin wrapper around local Ollama for single-shot, JSON-only field
// extraction. Never conversational: one small prompt in, one small JSON
// object out. If a field seems to need back-and-forth, that's a sign the
// question needs redesigning, not a reason to grow this prompt.

const { specs } = require('./schemas');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

const CONFIDENCE_THRESHOLD = 0.7;

// Local (clinic wall-clock) date, never UTC: with toISOString() a Puerto
// Rico caller between 8pm and midnight gets "today" anchored to tomorrow,
// shifting every relative date ("mañana", "este viernes") by a day.
function localToday(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildPrompt(spec, transcript, today = localToday()) {
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
// failures — all treated by callers exactly like low confidence (re-prompt
// and re-ask).
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
  return result.ok && result.confidence >= CONFIDENCE_THRESHOLD;
}

module.exports = { extractField, isConfident, warmUp };
