// Pure speech-onset detector: feed it caller frames while the
// receptionist's reply is playing, it tells you the moment the caller
// starts talking over it. The mirror image of TurnDetector — that one
// waits for a *sustained pause after speech*, this one waits for
// *sustained speech after silence* and has to fire fast, because every
// frame of lag is the assistant still talking over an interrupting caller.

const { frameRms } = require('./audioCodec');

class SpeechOnsetDetector {
  constructor({ rmsThreshold, voicedFramesToTrigger, graceFrames = 0 }) {
    this.rmsThreshold = rmsThreshold;
    this.voicedFramesToTrigger = voicedFramesToTrigger;
    this.graceFrames = graceFrames;
    this.reset();
  }

  reset() {
    this.framesSeen = 0;
    this.runFrames = []; // the current consecutive-voiced run
  }

  // Returns true on the frame that completes a voiced run long enough to
  // count as the caller interrupting.
  addFrame(mulawFrame) {
    this.framesSeen += 1;
    // Ignore the first frames after playback starts: the caller's own
    // trailing syllables can still be in flight and shouldn't kill the reply.
    if (this.framesSeen <= this.graceFrames) return false;

    if (frameRms(mulawFrame) > this.rmsThreshold) {
      this.runFrames.push(mulawFrame);
    } else {
      this.runFrames = []; // a gap means that wasn't sustained speech — start over
      return false;
    }
    return this.runFrames.length >= this.voicedFramesToTrigger;
  }

  // The frames that triggered detection — the caller's first words. These
  // get seeded into the next turn so nothing they said is lost.
  takeFrames() {
    const frames = this.runFrames;
    this.runFrames = [];
    return frames;
  }
}

module.exports = { SpeechOnsetDetector };
