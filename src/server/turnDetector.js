// Pure silence-based turn detector: feed it decoded caller frames one at a
// time, it tells you when the caller has paused long enough (or talked too
// long) to treat the buffered audio as one complete turn. No I/O, no
// Twilio/WebSocket knowledge — kept separate from mediaStream.js so the
// detection logic can be unit tested without a live connection.

const { frameRms } = require('./audioCodec');

class TurnDetector {
  constructor({ silenceRmsThreshold, silenceFramesToEndTurn, maxTurnFrames, minVoicedFramesToEndTurn }) {
    this.silenceRmsThreshold = silenceRmsThreshold;
    this.silenceFramesToEndTurn = silenceFramesToEndTurn;
    this.maxTurnFrames = maxTurnFrames;
    this.minVoicedFramesToEndTurn = minVoicedFramesToEndTurn;
    this.reset();
  }

  reset() {
    this.frames = [];
    this.voicedFrameCount = 0;
    this.consecutiveSilenceFrames = 0;
  }

  // Returns true once this frame completes the turn (caller paused after
  // speaking, or the turn hit its hard length cap).
  addFrame(mulawFrame) {
    this.frames.push(mulawFrame);

    if (frameRms(mulawFrame) > this.silenceRmsThreshold) {
      this.voicedFrameCount += 1;
      this.consecutiveSilenceFrames = 0;
    } else {
      this.consecutiveSilenceFrames += 1;
    }

    const callerPaused = this.voicedFrameCount >= this.minVoicedFramesToEndTurn
      && this.consecutiveSilenceFrames >= this.silenceFramesToEndTurn;
    const turnTooLong = this.frames.length >= this.maxTurnFrames;

    return callerPaused || turnTooLong;
  }

  concatFrames() {
    return Buffer.concat(this.frames);
  }
}

module.exports = { TurnDetector };
