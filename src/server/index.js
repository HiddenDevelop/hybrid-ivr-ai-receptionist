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
const { buildPromptCache, FRAME_BYTES } = require('./tts/cache');
const { warmUp } = require('./extraction/extract');
const { openDb } = require('./db/index');
const { CallSession } = require('./ivr/session');
const { createCalendarClient } = require('./calendar/googleClient');
const { startCalendarSync } = require('./calendar/sync');

const PORT = Number(process.env.PORT || 3000);
const SPEECH_URL = `http://${process.env.SPEECH_HOST || '127.0.0.1'}:${process.env.SPEECH_PORT || '8081'}`;

// 20ms frames at 8kHz. Turn ends after a silence run following >=200ms of
// speech. How long that silence run has to be depends on what the caller was
// asked (session.expectsSpeech): an open answer gets 1.8s so a caller pausing
// mid-name or mid-date isn't cut off. Keypad states never send audio to STT
// at all — their detector only decides "the caller is talking at a keypad
// question" so the question can be replayed, and 800ms keeps that reaction
// fast.
const TURN_PROFILES = {
  // names, DOB, phone dictation, insurance, hospital, spoken dates
  open: {
    silenceRmsThreshold: 300,
    silenceFramesToEndTurn: 90, // 1.8s
    maxTurnFrames: 1250, // 25s
    minVoicedFramesToEndTurn: 10,
  },
  // keypad-only states (menu, read-back confirm, window/slot/confirm)
  short: {
    silenceRmsThreshold: 300,
    silenceFramesToEndTurn: 40, // 800ms
    maxTurnFrames: 750, // 15s
    minVoicedFramesToEndTurn: 10,
  },
};

// Below this there is nothing worth sending to STT — a turn that was all
// keypress tone or line noise.
const MIN_TURN_FRAMES = 5; // 100ms

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
// is why the handoff prompt is always played to the caller first.
async function transferCall(callSid, number) {
  await twilioPost(`Calls/${callSid}.json`, {
    Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${number}</Dial></Response>`,
  });
}

async function endCall(callSid) {
  await twilioPost(`Calls/${callSid}.json`, { Status: 'completed' });
}


// One per WebSocket connection = one call.
class CallHandler {
  constructor(ws, { db, promptCache, calendarSync }) {
    this.ws = ws;
    this.db = db;
    this.promptCache = promptCache;
    this.calendarSync = calendarSync ?? null; // null = sync disabled (no token yet)
    this.streamSid = null;
    this.session = null;
    this.mode = 'idle'; // idle | playing | listening
    // Replaced per turn by beginListening() with a profile-sized detector;
    // this initial one just makes the instance valid before the first listen.
    this.turnDetector = new TurnDetector(TURN_PROFILES.short);
    this.playbackToken = 0; // bumped to cancel in-flight playback (DTMF interrupt / supersession)
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
    // keypress so the tone can't fake a caller turn.
    this.deafUntil = 0;
  }

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

    // Audio during playback is ignored — prompts always play to completion.
    // DTMF still interrupts: the dtmf handler stops playback in any mode.
    if (this.mode !== 'listening') return;

    if (this.turnDetector.addFrame(frame)) {
      await this.finalizeTurn();
    }
  }

  // Treat the buffered audio as one complete caller turn: transcribe it, run
  // it through the session, queue whatever comes back. Reached when the
  // silence timer decides the caller is finished (onFrame above).
  async finalizeTurn() {
    this.mode = 'idle';
    this.turnStartedAt = Date.now();
    const generation = ++this.actionGeneration;

    const mulaw = this.turnDetector.concatFrames();
    // A turn that was all tone or noise: no point paying for STT — just go
    // back to listening.
    if (mulaw.length < MIN_TURN_FRAMES * FRAME_BYTES) {
      console.log(`[call ${this.streamSid}] turn too short (${mulaw.length} bytes) — ignoring`);
      this.beginListening();
      return;
    }

    // Keypad-only question: caller speech never reaches /stt or the LLM.
    // The session replays the question (with its key instructions) instead.
    // No STT also means no noise filter here — any sustained voiced turn
    // (TV, speakerphone) replays the question; acceptable for the prototype
    // since the replay includes the 0-for-a-person reminder.
    if (!this.session.expectsSpeech) {
      console.log(`[call ${this.streamSid}] speech at keypad state — replaying question (no STT)`);
      this.queueActions(this.session.onUnexpectedSpeech(), generation);
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
    this.turnDetector = new TurnDetector(
      TURN_PROFILES[(this.session?.expectsSpeech ?? true) ? 'open' : 'short'],
    );
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
  // audio); small enough that a DTMF interrupt stays snappy —
  // stopPlayback()'s "clear" event flushes whatever is buffered ahead anyway.
  static PLAYBACK_LEAD_MS = 200;

  // Stream cached mulaw frames to Twilio against an absolute schedule:
  // frame i is due at start + i*20ms, so a late timer tick is absorbed on
  // the next frame instead of accumulating. A fixed sleep-20ms-per-frame
  // loop drifts (setTimeout only guarantees AT LEAST the delay) and
  // delivers audio slower than real time, which is exactly the laggy
  // playback heard on real calls.
  async playFrames(frames) {
    const token = ++this.playbackToken;
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
        case 'transfer': {
          // The only transfer left is the caller pressing 0 for a person
          // (reason 'caller_request') — without a scheduling number it
          // stays log-only.
          console.log(`[call ${this.streamSid}] TRANSFER (${action.reason})`);
          const target = process.env.SCHEDULING_NUMBER || null;
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
        case 'calendarSync':
          // Fire-and-forget: the booking is already committed, and a Google
          // outage must never delay the goodbye/hangup. Failures are retried
          // by the background reconciler.
          this.calendarSync?.syncNow()
            .catch((err) => console.error(`[calendar] sync after booking failed: ${err.message}`));
          break;
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

  // Google Calendar mirror (recorded exception — see CLAUDE.md). Optional:
  // without the one-time consent token the server runs normally, just
  // without calendar events.
  let calendarSync = null;
  const calendarClient = createCalendarClient({
    credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE || 'credentials.json',
    tokenFile: process.env.GOOGLE_TOKEN_FILE || 'var/google-token.json',
  });
  if (calendarClient) {
    calendarSync = startCalendarSync({
      db,
      client: calendarClient,
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || 'America/Puerto_Rico',
      intervalMs: Number(process.env.CALENDAR_SYNC_INTERVAL_MS || 60000),
    });
    console.log('[calendar] sync enabled — draining any unsynced bookings');
    calendarSync.syncNow().catch((err) => console.error(`[calendar] startup sync failed: ${err.message}`));
  } else {
    console.warn('[calendar] sync disabled — no OAuth token yet; run: node --env-file-if-exists=.env scripts/google-auth.js');
  }

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
    const handler = new CallHandler(ws, { db, promptCache, calendarSync });
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
