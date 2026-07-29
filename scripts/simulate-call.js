// Simulated end-to-end call — everything real except Twilio: the "caller"
// is Piper-generated Spanish speech streamed as 8kHz mulaw frames into the
// Media Streams WebSocket, so STT, extraction (Ollama), flows, red-flag
// gate, scheduling, and SQLite all run exactly as they would on a phone
// call. Run with the sidecar up and the server started (or let this start
// the server via `node scripts/simulate-call.js`).
//
// Scenario: post-op caller, benign first answer, then a red-flag phrase —
// asserts the call escalates without booking.

// The simulator wipes its database on every run, so it gets its OWN file —
// and takes it by force, because the usual way to run this is with .env
// sourced, and .env sets DB_PATH to the real prototype DB. Honoring that
// here means a simulated call deletes the data from your live test calls
// (and fights the running server for the same SQLite WAL). Override only
// via SIM_DB_PATH, which can't be set by accident.
process.env.DB_PATH = process.env.SIM_DB_PATH || 'var/simulate.db';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { wavToPcm16, pcm16ToMulaw, chunkIntoFrames, MULAW_SILENCE_BYTE } = require('../src/server/audioCodec');

const SPEECH_URL = `http://${process.env.SPEECH_HOST || '127.0.0.1'}:${process.env.SPEECH_PORT || '8081'}`;
const PORT = Number(process.env.SIM_PORT || 3100); // avoid whatever occupies 3000

async function callerAudioFrames(text) {
  const res = await fetch(`${SPEECH_URL}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, sample_rate: 8000 }),
  });
  if (!res.ok) throw new Error(`tts failed: ${res.status}`);
  const { pcm16 } = wavToPcm16(Buffer.from(await res.arrayBuffer()));
  return chunkIntoFrames(pcm16ToMulaw(pcm16), 160);
}

const silenceFrame = Buffer.alloc(160, MULAW_SILENCE_BYTE);

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function main() {
  // -wal/-shm too: deleting the database file alone leaves SQLite side
  // files describing pages that no longer exist, and the next open dies
  // with "disk I/O error" instead of starting clean.
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${process.env.DB_PATH}${suffix}`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  // Start the real server as a child process (index.js only boots when it
  // is the main module), on a port of our own.
  const server = spawn('node', [path.join(__dirname, '../src/server/index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  process.on('exit', () => server.kill());

  // wait for it to come up (it waits for sidecar + builds the cache)
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      up = res.ok;
    } catch { /* not up yet */ }
    if (!up) await sleep(1000);
  }
  if (!up) throw new Error('server did not come up');

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/media`);
  let receivedMediaFrames = 0;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.event === 'media') receivedMediaFrames += 1;
  });
  await new Promise((resolve) => { ws.on('open', resolve); });

  const send = (obj) => ws.send(JSON.stringify(obj));
  send({ event: 'start', start: { streamSid: 'SIM1', customParameters: { from: '5550001111' } } });

  // let the greeting play a moment, then choose post-op via DTMF
  await sleep(3000);
  console.log(`[sim] greeting frames received so far: ${receivedMediaFrames}`);
  if (receivedMediaFrames === 0) throw new Error('no greeting audio received');
  send({ event: 'dtmf', dtmf: { digit: '3' } });
  await sleep(4000); // ask_surgery_date prompt plays

  // finishKey=true ends the turn the way a caller who doesn't want to wait
  // does: a short pause, then #. Otherwise the turn ends on silence alone.
  async function speakAsCaller(text, { finishKey = false } = {}) {
    console.log(`[sim] caller says: "${text}"${finishKey ? ' (then presses #)' : ''}`);
    const frames = await callerAudioFrames(text);
    for (const frame of frames) {
      send({ event: 'media', media: { payload: frame.toString('base64') } });
      await sleep(5); // faster than real time; turn detector only counts frames
    }
    // Data-collection states use the "open" turn profile
    // (silenceFramesToEndTurn=90, i.e. 1.8s), so the silence tail has to
    // clear that or the turn hangs until the 25s cap. Keep this above the
    // largest silenceFramesToEndTurn in index.js TURN_PROFILES.
    const tailFrames = finishKey ? 10 : 100;
    for (let i = 0; i < tailFrames; i += 1) {
      send({ event: 'media', media: { payload: silenceFrame.toString('base64') } });
      await sleep(5);
    }
    if (finishKey) send({ event: 'dtmf', dtmf: { digit: '#' } });
  }

  const turnStart = Date.now();
  await speakAsCaller('Me operaron el veinte de julio de este año.');
  await sleep(8000); // STT + extraction + the read-back of the date
  console.log(`[sim] first turn round-trip window: ${Date.now() - turnStart}ms (includes prompt playback)`);

  // Every collected field is now read back ("Entendí que su operación fue
  // el 20 de julio de 2026. ¿Es correcto?") and kept only once the caller
  // confirms. 1 = sí; the symptom question follows.
  console.log('[sim] caller confirms the read-back (presses 1)');
  send({ event: 'dtmf', dtmf: { digit: '1' } });
  await sleep(9000); // ask_symptoms prompt

  // Finished with # rather than silence: exercises the finish-key path AND
  // confirms the red-flag gate still fires on a turn finalized that way.
  await speakAsCaller('Es que no puedo respirar y estoy sangrando mucho.', { finishKey: true });
  await sleep(6000);

  // Verify: no appointment booked (red flag skips scheduling)
  const { openDb } = require('../src/server/db/index');
  const db = openDb(process.env.DB_PATH);
  const count = db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n;
  console.log(`[sim] appointments booked: ${count} (expected 0 — red flag escalated)`);

  ws.close();
  if (count !== 0) {
    console.error('[sim] FAIL: appointment was booked after a red-flag phrase');
    process.exit(1);
  }
  console.log('[sim] PASS: red-flag call escalated, nothing was scheduled');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
