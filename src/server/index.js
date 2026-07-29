// Entrypoint: Express + Twilio Media Streams WebSocket. Twilio is a dumb
// PSTN/SMS bridge — raw mulaw audio in/out and one confirmation SMS. No
// transcript, extracted field, or patient data ever goes to Twilio beyond
// the confirmed slot in that SMS.
//
// Binds 127.0.0.1 ONLY. Internet exposure (for Twilio to reach the TwiML/
// WS endpoints) is a tunnel concern (ngrok or similar), deliberately
// outside this process.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { mulawToPcm16, pcm16ToWav } = require('./audioCodec');
const { TurnDetector } = require('./turnDetector');
const { SpeechOnsetDetector } = require('./speechOnsetDetector');
const { buildPromptCache, FRAME_BYTES } = require('./tts/cache');
const { warmUp } = require('./extraction/extract');
const { openDb } = require('./db/index');
const { CallSession } = require('./ivr/session');

const PORT = Number(process.env.PORT || 3000);
const SPEECH_URL = `http://${process.env.SPEECH_HOST || '127.0.0.1'}:${process.env.SPEECH_PORT || '8081'}`;

// 20ms frames at 8kHz. Turn ends after a silence run following >=200ms of
// speech. How long that silence run has to be depends on what the caller was
// asked (session.turnProfile): an open answer gets 1.8s so a caller pausing
// mid-name or mid-date isn't cut off, a one-word answer keeps the original
// 800ms so "sí"/"no" still feels immediate. Barge-in needs 160ms of
// sustained speech after a 500ms grace period.
const TURN_PROFILES = {
  // names, DOB, phone, insurance, allergies, symptoms, spoken dates
  open: {
    silenceRmsThreshold: 300,
    silenceFramesToEndTurn: 90, // 1.8s
    maxTurnFrames: 1250, // 25s
    minVoicedFramesToEndTurn: 10,
  },
  // menu choices, slot choice, yes/no
  short: {
    silenceRmsThreshold: 300,
    silenceFramesToEndTurn: 40, // 800ms
    maxTurnFrames: 750, // 15s
    minVoicedFramesToEndTurn: 10,
  },
};

// Frames dropped from the END of a turn finished with the # key: Twilio
// delivers the keypress as an event AND as an audible tone in the media
// stream, and the tone's leading edge lands in the frames already buffered.
// (deafUntil only covers audio arriving after the event.)
const TONE_TRIM_FRAMES = 6; // 120ms

// Below this there is nothing worth sending to STT — # pressed before the
// caller said anything, or a turn that was all tone.
const MIN_TURN_FRAMES = 5; // 100ms
const ONSET_DETECTOR_OPTS = {
  rmsThreshold: 500,
  voicedFramesToTrigger: 8,
  graceFrames: 25,
};

async function transcribe(wavBuffer) {
  const res = await fetch(`${SPEECH_URL}/stt`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body: wavBuffer,
  });
  if (!res.ok) throw new Error(`sidecar /stt failed: ${res.status}`);
  return res.json();
}

function twilioCreds() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return {
    sid,
    auth: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
  };
}

async function twilioPost(pathname, params) {
  const creds = twilioCreds();
  if (!creds) return null;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${creds.sid}/${pathname}`, {
    method: 'POST',
    headers: { authorization: creds.auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Twilio ${pathname} failed: ${res.status} ${await res.text()}`);
  return res;
}

async function sendSms(to, text) {
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!twilioCreds() || !from) {
    console.warn(`[sms] Twilio creds not configured — SMS to ${to} skipped: "${text}"`);
    return false;
  }
  try {
    await twilioPost('Messages.json', {
      To: to.startsWith('+') ? to : `+1${to}`,
      From: from,
      Body: text,
    });
    return true;
  } catch (err) {
    console.error(`[sms] ${err.message}`);
    return false;
  }
}

// Live-transfer the call: redirect its TwiML to <Dial> the target line.
// Twilio tears down the media stream when the redirect takes effect, which
// is why the escalation prompt is always played to the caller first.
async function transferCall(callSid, number) {
  await twilioPost(`Calls/${callSid}.json`, {
    Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${number}</Dial></Response>`,
  });
}

async function endCall(callSid) {
  await twilioPost(`Calls/${callSid}.json`, { Status: 'completed' });
}

// Which line an escalation goes to. Red flags page the on-call MD; every
// other reason (couldn't understand, no slots, caller pressed 0) is a
// scheduling-team matter and must NOT page the surgeon — without a
// scheduling number it stays log-only, exactly the pre-transfer behavior.
function escalationTarget(reason) {
  // red_flag: keyword gate hit. symptom_report: structured extraction
  // reported fever/bleeding/drain/severe pain. Both are clinical.
  if (reason === 'red_flag' || reason === 'symptom_report') {
    return process.env.ESCALATION_NUMBER || null;
  }
  return process.env.SCHEDULING_NUMBER || null;
}

// One per WebSocket connection = one call.
class CallHandler {
  constructor(ws, { db, promptCache }) {
    this.ws = ws;
    this.db = db;
    this.promptCache = promptCache;
    this.streamSid = null;
    this.session = null;
    this.mode = 'idle'; // idle | playing | listening
    // Replaced per turn by beginListening() with a profile-sized detector;
    // this initial one just makes the instance valid before the first listen.
    this.turnDetector = new TurnDetector(TURN_PROFILES.short);
    this.onsetDetector = new SpeechOnsetDetector(ONSET_DETECTOR_OPTS);
    this.playbackToken = 0; // bumped to cancel in-flight playback (barge-in)
    this.pendingListen = false;
    this.turnStartedAt = null;
    // Action batches run strictly one at a time through this chain, and a
    // batch is abandoned when newer caller input arrives (generation bump).
    // Without this, a spurious turn (e.g. a DTMF tone transcribed by STT)
    // queues a re-prompt that plays OVER the prompt the DTMF triggered —
    // the "two voices at once" failure heard on a real call.
    this.runChain = Promise.resolve();
    this.actionGeneration = 0;
    // Twilio delivers the keypress as a dtmf event AND as an audible tone
    // inside the media stream; ignore inbound audio briefly around a
    // keypress so the tone can't fake a barge-in or a caller turn.
    this.deafUntil = 0;
    // Ring of caller frames captured DURING prompt playback. On barge-in
    // the whole last second is seeded into the turn, not just the frames
    // that triggered onset detection — otherwise leading words get clipped
    // ("[es que no] puedo respirar"), which can flip the meaning of a
    // transcript the red-flag gate depends on.
    this.preSpeechRing = [];
  }

  static PRE_SPEECH_RING_FRAMES = 50; // 1s at 20ms/frame

  async handleMessage(raw) {
    const msg = JSON.parse(raw);
    switch (msg.event) {
      case 'start': {
        this.streamSid = msg.start.streamSid;
        this.callSid = msg.start.callSid || null;
        const callerPhone = msg.start.customParameters?.from || null;
        this.session = new CallSession({ db: this.db, callerPhone });
        console.log(`[call ${this.streamSid}] started`);
        this.queueActions(this.session.start(), ++this.actionGeneration);
        break;
      }
      case 'media': {
        const frame = Buffer.from(msg.media.payload, 'base64');
        await this.onFrame(frame);
        break;
      }
      case 'dtmf': {
        const digit = String(msg.dtmf.digit);
        console.log(`[call ${this.streamSid}] dtmf ${digit}`);
        // "#" means "I'm done talking" — the caller ending their own turn
        // instead of waiting out the silence timer. It must NOT fall into the
        // handling below, which resets the turn detector and would throw away
        // the very audio we're being told is complete.
        if (digit === '#') {
          this.deafUntil = Date.now() + 400; // swallow the in-band tone
          // Pressed while a prompt is playing, or while we're already
          // transcribing, it means nothing — ignore it rather than let it
          // reach onDtmf, where an unmapped digit costs the caller a strike.
          if (this.mode === 'listening') {
            await this.finalizeTurn({ trimTrailingFrames: TONE_TRIM_FRAMES });
          }
          break;
        }
        this.deafUntil = Date.now() + 400; // swallow the in-band tone
        this.turnDetector.reset(); // drop any tone audio already captured
        this.stopPlayback();
        this.queueActions(this.session.onDtmf(digit), ++this.actionGeneration);
        break;
      }
      case 'stop':
        console.log(`[call ${this.streamSid}] ended by caller`);
        break;
      default:
        break;
    }
  }

  async onFrame(frame) {
    if (Date.now() < this.deafUntil) return; // DTMF tone window

    if (this.mode === 'playing') {
      // Read-back states suppress voice barge-in (session.bargeInAllowed):
      // cancelling the read-back on a backchannel or STT hallucination
      // discards the very sentence the caller must hear in full. DTMF
      // still interrupts — the dtmf handler stops playback in any mode.
      if (!(this.session?.bargeInAllowed ?? true)) return;
      this.preSpeechRing.push(frame);
      if (this.preSpeechRing.length > CallHandler.PRE_SPEECH_RING_FRAMES) this.preSpeechRing.shift();
      // Barge-in: caller talking over the prompt cancels playback; the
      // buffered second of audio (which contains the triggering frames)
      // seeds the new turn so nothing the caller said is lost.
      if (this.onsetDetector.addFrame(frame)) {
        console.log(`[call ${this.streamSid}] barge-in`);
        this.stopPlayback();
        this.beginListening();
        this.onsetDetector.takeFrames(); // consumed via the ring below
        for (const seeded of this.preSpeechRing) {
          this.turnDetector.addFrame(seeded);
        }
        this.preSpeechRing = [];
      }
      return;
    }
    if (this.mode !== 'listening') return;

    if (this.turnDetector.addFrame(frame)) {
      await this.finalizeTurn();
    }
  }

  // Treat the buffered audio as one complete caller turn: transcribe it, run
  // it through the session, queue whatever comes back. Reached either by the
  // silence timer (onFrame above) or by the caller pressing # to say they're
  // done, which trims the keypress tone off the tail first.
  async finalizeTurn({ trimTrailingFrames = 0 } = {}) {
    this.mode = 'idle';
    this.turnStartedAt = Date.now();
    const generation = ++this.actionGeneration;

    let mulaw = this.turnDetector.concatFrames();
    if (trimTrailingFrames > 0) {
      mulaw = mulaw.subarray(0, Math.max(0, mulaw.length - trimTrailingFrames * FRAME_BYTES));
    }
    // # pressed before saying anything (or a turn that was all tone): no
    // point paying for STT, and no strike — just go back to listening.
    if (mulaw.length < MIN_TURN_FRAMES * FRAME_BYTES) {
      console.log(`[call ${this.streamSid}] turn too short (${mulaw.length} bytes) — ignoring`);
      this.beginListening();
      return;
    }

    const wav = pcm16ToWav(mulawToPcm16(mulaw), 8000);
    try {
      const { text, stt_ms: sttMs } = await transcribe(wav);
      console.log(`[call ${this.streamSid}] stt ${sttMs}ms: "${text}"`);
      // Nothing intelligible (tone remnants, breath, line noise): don't
      // charge the caller a strike or answer it — just keep listening.
      if (!text.trim()) {
        console.log(`[call ${this.streamSid}] empty transcript — ignoring turn`);
        if (generation === this.actionGeneration) this.beginListening();
        return;
      }
      const actions = await this.session.onTranscript(text);
      // Per-turn latency: end of caller speech -> first response action.
      console.log(`[call ${this.streamSid}] turn handled in ${Date.now() - this.turnStartedAt}ms`);
      this.queueActions(actions, generation);
    } catch (err) {
      console.error(`[call ${this.streamSid}] turn failed: ${err}`);
      this.queueActions(
        [{ type: 'play', promptId: 'reprompt_generic' }, { type: 'listen' }],
        generation,
      );
    }
  }

  // Serialize action batches; a batch whose generation is stale (newer
  // caller input arrived while it waited) is dropped before and between
  // actions, so it can never talk over the response to the newer input.
  queueActions(actions, generation) {
    this.runChain = this.runChain
      .then(async () => {
        if (generation !== this.actionGeneration) return;
        await this.runActions(actions, generation);
      })
      .catch((err) => console.error(`[call ${this.streamSid}] action batch failed: ${err}`));
  }

  // A fresh detector per turn, sized for the question just asked. Building a
  // new one is inherently a reset, and it keeps the pause tolerance out of
  // turnDetector.js — that file carries over from the previous project and
  // its interface is shared (CLAUDE.md).
  beginListening() {
    const profile = this.session?.turnProfile ?? 'open';
    this.turnDetector = new TurnDetector(TURN_PROFILES[profile]);
    this.mode = 'listening';
  }

  stopPlayback() {
    this.playbackToken += 1;
    if (this.streamSid && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    }
    this.mode = 'idle';
  }

  // How far ahead of real time to keep Twilio's playout buffer while
  // streaming a prompt. Enough cushion that a timer overshoot, GC pause, or
  // Piper synthesis burst can't starve playback (heard as stuttery, laggy
  // audio); small enough that barge-in stays snappy — stopPlayback()'s
  // "clear" event flushes whatever is buffered ahead anyway.
  static PLAYBACK_LEAD_MS = 200;

  // Stream cached mulaw frames to Twilio against an absolute schedule:
  // frame i is due at start + i*20ms, so a late timer tick is absorbed on
  // the next frame instead of accumulating. A fixed sleep-20ms-per-frame
  // loop drifts (setTimeout only guarantees AT LEAST the delay) and
  // delivers audio slower than real time, which is exactly the laggy
  // playback heard on real calls.
  async playFrames(frames) {
    const token = ++this.playbackToken;
    this.onsetDetector.reset();
    this.preSpeechRing = [];
    this.mode = 'playing';
    const start = Date.now();
    for (let i = 0; i < frames.length; i += 1) {
      if (this.playbackToken !== token || this.ws.readyState !== this.ws.OPEN) return false;
      this.ws.send(JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: frames[i].toString('base64') },
      }));
      const ahead = start + i * 20 - Date.now();
      if (ahead > CallHandler.PLAYBACK_LEAD_MS) {
        await new Promise((resolve) => { setTimeout(resolve, ahead - CallHandler.PLAYBACK_LEAD_MS); });
      }
    }
    // Sleep off the remaining lead so mode transitions (and the hangup
    // grace after a goodbye) still line up with when the audio actually
    // finishes playing, not when we finished sending it.
    const remaining = start + frames.length * 20 - Date.now();
    if (remaining > 0 && this.playbackToken === token) {
      await new Promise((resolve) => { setTimeout(resolve, remaining); });
    }
    if (this.playbackToken !== token) return false;
    if (this.mode === 'playing') this.mode = 'idle';
    return true;
  }

  async runActions(actions, generation = this.actionGeneration) {
    for (const action of actions) {
      if (generation !== this.actionGeneration) return; // superseded mid-batch
      switch (action.type) {
        case 'play':
          await this.playFrames(this.promptCache.getFrames(action.promptId));
          break;
        case 'playText':
          await this.playFrames(await this.promptCache.synthesizeDynamic(action.text));
          break;
        case 'listen':
          if (this.mode !== 'listening') this.beginListening();
          break;
        case 'sms':
          await sendSms(action.to, action.text);
          break;
        case 'escalate': {
          console.error(`[call ${this.streamSid}] ESCALATE (${action.reason})`
            + (action.matched ? ` matched="${action.matched}"` : ''));
          const target = escalationTarget(action.reason);
          if (target && this.callSid && twilioCreds()) {
            try {
              await transferCall(this.callSid, target);
              console.log(`[call ${this.streamSid}] transferred to ${target}`);
            } catch (err) {
              console.error(`[call ${this.streamSid}] transfer failed: ${err.message}`);
            }
          } else {
            console.warn(`[call ${this.streamSid}] no transfer target/creds for "${action.reason}" — log-only`);
          }
          break;
        }
        case 'hangup':
          if (this.callSid && twilioCreds()) {
            // half a second of grace so Twilio finishes playing the goodbye
            await new Promise((resolve) => { setTimeout(resolve, 500); });
            await endCall(this.callSid).catch((err) => console.error(`[call ${this.streamSid}] hangup failed: ${err.message}`));
          }
          if (this.ws.readyState === this.ws.OPEN) this.ws.close();
          break;
        default:
          console.warn(`unknown action type: ${action.type}`);
      }
    }
  }
}

async function waitForSidecar(retries = 60) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(`${SPEECH_URL}/healthz`);
      if (res.ok) {
        const body = await res.json();
        if (!body.tts) {
          throw new Error(
            'sidecar has no TTS voice configured — listen to speech/samples/ and set PIPER_VOICE in .env',
          );
        }
        return body;
      }
    } catch (err) {
      if (String(err).includes('PIPER_VOICE')) throw err;
    }
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  throw new Error(`speech sidecar not reachable at ${SPEECH_URL} — start it first (npm run dev)`);
}

// Tee console output to var/calls.log so calls can be reviewed after the
// terminal scrollback is gone. Contains transcripts — local-only file,
// var/ is gitignored, and it must never leave this machine.
function setupFileLog() {
  const logPath = process.env.CALL_LOG_PATH || 'var/calls.log';
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      stream.write(`${new Date().toISOString()} [${level}] ${args.map(String).join(' ')}\n`);
    };
  }
  console.log(`--- server start (logging to ${logPath}) ---`);
}

async function main() {
  setupFileLog();
  // Catch the classic misconfigurations before the first call does:
  // Twilio silently fails to connect the media stream on a bad wss URL.
  const streamUrl = process.env.TWILIO_STREAM_URL;
  if (streamUrl && !/^wss:\/\/[^/]+\/media$/.test(streamUrl)) {
    throw new Error(
      `TWILIO_STREAM_URL looks wrong: "${streamUrl}" — expected wss://<tunnel-host>/media `
      + '(no http/https, and the path must be /media)',
    );
  }
  if (!streamUrl) {
    console.warn('TWILIO_STREAM_URL is not set — real calls will not connect their media stream');
  }

  console.log('waiting for speech sidecar...');
  const health = await waitForSidecar();
  console.log(`sidecar ready (voice: ${health.tts}, length_scale ${health.tts_length_scale} — 1.0 = native pace)`);

  const db = openDb();
  const promptCache = await buildPromptCache();
  await warmUp();

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // Twilio fetches TwiML here on an inbound call; it points the call's
  // audio at our Media Streams WebSocket (public URL comes from the tunnel).
  // The caller's number rides along as a <Parameter> so the session can
  // fall back to caller-ID for the confirmation SMS.
  app.post('/voice', (req, res) => {
    const streamUrl = process.env.TWILIO_STREAM_URL || `wss://localhost:${PORT}/media`;
    const from = String(req.body.From || '').replace(/[^+\d]/g, '');
    console.log(`[voice] inbound call from ${from || 'unknown'} -> stream ${streamUrl}`);
    res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + `<Response><Connect><Stream url="${streamUrl}">`
      + `<Parameter name="from" value="${from}"/>`
      + '</Stream></Connect></Response>',
    );
  });
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/media' });

  wss.on('connection', (ws) => {
    const handler = new CallHandler(ws, { db, promptCache });
    ws.on('message', (raw) => {
      handler.handleMessage(raw).catch((err) => console.error(`call handler error: ${err}`));
    });
  });

  // 127.0.0.1 is non-negotiable — never make this internet-reachable.
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`receptionist listening on 127.0.0.1:${PORT} (TwiML: POST /voice, media: WS /media)`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { CallHandler, sendSms };
