// Pre-synthesizes every fixed Spanish prompt at startup via the speech
// sidecar and holds them in memory as 20ms mulaw frames, ready to stream
// straight to Twilio. Per-call TTS only ever happens for the few dynamic
// sentences (slot offers / confirmations) — and those go through
// synthesizeDynamic() below, which logs, so a latency regression to live
// synthesis is visible instead of silent.

const { wavToPcm16, pcm16ToMulaw, chunkIntoFrames } = require('../audioCodec');
const { PROMPTS } = require('../prompts');

const FRAME_BYTES = 160; // 20ms of 8kHz mulaw — Twilio Media Streams framing

function speechBaseUrl() {
  const host = process.env.SPEECH_HOST || '127.0.0.1';
  const port = process.env.SPEECH_PORT || '8081';
  return `http://${host}:${port}`;
}

async function synthesizeToFrames(text, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${speechBaseUrl()}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, sample_rate: 8000 }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`sidecar /tts failed (${res.status}): ${detail}`);
  }
  const wav = Buffer.from(await res.arrayBuffer());
  const { pcm16, sampleRate } = wavToPcm16(wav);
  if (sampleRate !== 8000) throw new Error(`expected 8kHz WAV from sidecar, got ${sampleRate}`);
  return chunkIntoFrames(pcm16ToMulaw(pcm16), FRAME_BYTES);
}

// Builds the full cache. Fails loudly if any prompt can't be synthesized —
// the server must not take calls with holes in its prompt set.
async function buildPromptCache({ fetchImpl = fetch, log = console.log } = {}) {
  const cache = new Map();
  const started = Date.now();
  for (const [id, text] of Object.entries(PROMPTS)) {
    cache.set(id, await synthesizeToFrames(text, { fetchImpl }));
  }
  log(`tts cache: ${cache.size} prompts pre-synthesized in ${Date.now() - started}ms`);

  return {
    getFrames(id) {
      const frames = cache.get(id);
      if (!frames) throw new Error(`prompt not in cache: ${id}`);
      return frames;
    },
    has(id) {
      return cache.has(id);
    },
    // Dynamic sentences only (slot offer / confirmation). Logged so any
    // unexpected live-TTS use shows up in per-turn latency review.
    async synthesizeDynamic(text) {
      const t0 = Date.now();
      const frames = await synthesizeToFrames(text, { fetchImpl });
      log(`tts live synthesis (${Date.now() - t0}ms): "${text.slice(0, 60)}..."`);
      return frames;
    },
  };
}

module.exports = { buildPromptCache, synthesizeToFrames, FRAME_BYTES };
