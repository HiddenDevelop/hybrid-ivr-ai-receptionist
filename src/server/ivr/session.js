// Per-call state machine. Transport-agnostic: consumes DTMF digits and
// Spanish transcripts, emits action lists —
//   {type:'play', promptId}     cached prompt
//   {type:'playText', text}     dynamic sentence (live TTS, logged by cache)
//   {type:'listen'}             capture the caller's next turn
//   {type:'transfer', reason}   hand the call to the scheduling team
//   {type:'sms', to, text}      Spanish confirmation SMS
//   {type:'hangup'}
// index.js maps actions to Twilio Media Streams; tests drive this directly.
//
// Input-mode contract: every state takes EITHER keypad digits OR speech,
// never both. Speech (STT + LLM extraction) exists only for the questions
// whose answer is genuinely open-ended data — the collect steps and the
// spoken specific date (sched_date). Everything else (menu, read-back
// confirmation, scheduling window, slot offer, slot confirmation, the
// caller-ID phone offer) is keypad-only, and speech there never reaches
// STT or the LLM: index.js gates on expectsSpeech and calls
// onUnexpectedSpeech() instead, which replays the question.

const defaultExtract = require('../extraction/extract');
const { fieldReadbackText, slotOfferText, confirmSlotText } = require('../prompts');
const { FLOWS, DTMF_MAP } = require('./menu');
const scheduling = require('./scheduling');

// Pressing this at any point restarts the call at the main menu.
const RETURN_TO_MENU_KEY = '*';

// Pressing this at any point leaves the automated flow entirely and puts
// the caller through to the scheduling team. Checked before every other
// piece of DTMF routing, in every state, so it can never be swallowed by
// the state machine: the way out must not depend on the call being in a
// state that understands it. This is also the ONLY transfer to a human:
// a question that keeps failing re-prompts indefinitely (the re-prompts
// mention this key), it never transfers on its own.
const OPERATOR_KEY = '0';

class CallSession {
  constructor({
    db,
    callerPhone = null,
    now = () => new Date(),
    extract = defaultExtract,
  } = {}) {
    this.db = db;
    this.callerPhone = callerPhone;
    this.now = now;
    this.extract = extract;

    this.resetToMenu();
  }

  // Fresh menu state — used at construction and when the caller presses *.
  // Everything collected so far is discarded on purpose: a caller bailing
  // to the menu is saying "start over", and half-filled data must not leak
  // into whichever path they pick next.
  resetToMenu() {
    this.state = 'menu';
    this.flow = null;
    this.stepIndex = 0;
    this.data = {};
    // Field extracted but not yet confirmed by the caller (verify state).
    this.pending = null;
    // Company name mentioned before its own question came up (e.g. the
    // caller answered the insurance-TYPE question with "tengo Triple-S").
    // Held by the flow's accept() until the type resolves, then merged into
    // that field's value — never committed on its own.
    this.providerHint = null;
    this.minConfidence = null;
    this.slots = null;
    this.chosenSlot = null;
    this.booking = null;
  }

  start() {
    return [{ type: 'play', promptId: 'greeting_menu' }, { type: 'listen' }];
  }

  end() {
    this.state = 'ended';
  }

  get ended() {
    return this.state === 'ended';
  }

  // The only two states whose caller turn is transcribed and extracted.
  // index.js gates the /stt call on this AND sizes the TurnDetector from
  // it: open answers tolerate the long mid-answer pauses of elderly callers
  // recalling digits ("mil novecientos... treinta y ocho"), while keypad
  // states only need fast "someone is talking" detection to replay the
  // question — there is nothing to transcribe there.
  get expectsSpeech() {
    return this.state === 'collect' || this.state === 'sched_date';
  }

  // --- input: DTMF -------------------------------------------------------

  onDtmf(digit) {
    if (this.ended) return [];

    // 0 hands the caller to the scheduling team from anywhere, at any step.
    // Checked first: no state may reinterpret it, and nothing collected so
    // far is written — a caller asking for a person is not a booking.
    if (String(digit) === OPERATOR_KEY) {
      this.end();
      return [
        { type: 'play', promptId: 'handoff_operator' },
        { type: 'transfer', reason: 'caller_request' },
      ];
    }

    // * returns to the main menu from anywhere, at any step.
    if (String(digit) === RETURN_TO_MENU_KEY) {
      this.resetToMenu();
      return [{ type: 'play', promptId: 'greeting_menu' }, { type: 'listen' }];
    }

    const n = Number(digit);

    if (this.state === 'verify') {
      // 1 = sí, keep it; 2 = no, ask again. Anything else is a misfire.
      if (n === 1) return this.commitPending();
      if (n === 2) return this.rejectPending();
      return this.reprompt();
    }
    if (this.state === 'menu') {
      const type = DTMF_MAP[n];
      if (!type) return this.reprompt('menu_retry');
      return this.enterFlow(type);
    }
    if (this.state === 'collect_key') {
      // A flow step answered by keypad (the caller-ID phone offer). The
      // step's keys() handler owns the digit; an unmapped key replays the
      // question.
      const step = this.flow.steps[this.stepIndex];
      return step.keys(this, n) ?? this.reprompt(step.promptId);
    }
    if (this.state === 'sched_window') {
      const window = scheduling.WINDOW_DTMF[n];
      if (!window) return this.reprompt('ask_sched_window');
      return scheduling.handleWindowSelection(this, window) ?? this.reprompt('ask_sched_window');
    }
    if (this.state === 'sched_date') {
      // the suggested date has to be spoken; keys don't encode a date
      return this.reprompt('ask_preferred_date');
    }
    if (this.state === 'offer') {
      const actions = scheduling.handleSlotChoice(this, n);
      return actions ?? this.reprompt();
    }
    if (this.state === 'confirm') {
      // 1 = sí, 2 = no, anything else replays the slot + question
      if (n === 1 || n === 2) return scheduling.handleConfirmation(this, n === 1);
      return this.reprompt();
    }
    // DTMF during open-ended data collection isn't meaningful — re-ask.
    return this.reprompt();
  }

  // --- input: transcript --------------------------------------------------

  async onTranscript(transcript) {
    if (this.ended) return [];

    if (this.state === 'collect') {
      return this.collectStep(transcript);
    }

    if (this.state === 'sched_date') {
      const result = await this.extract.extractField('preferredDate', transcript);
      if (!this.extract.isConfident(result)) return this.reprompt('ask_preferred_date');
      const actions = scheduling.handleWindowSelection(this, 'specific', result.value.date);
      return actions ?? this.reprompt('ask_preferred_date');
    }

    // Every other state is keypad-only. index.js already avoids calling
    // STT there, but the contract holds here too: a transcript landing at
    // a keypad question replays it and never reaches the LLM.
    return this.onUnexpectedSpeech();
  }

  // Caller spoke at a keypad-only question. No STT or LLM is spent on it —
  // index.js calls this instead of transcribing. Replay the question with
  // its key instructions (menu_retry / reprompt_generic remind about 0).
  onUnexpectedSpeech() {
    if (this.ended) return [];
    return this.reprompt(this.stateRepromptId());
  }

  // The cached prompt that re-asks the current keypad question, for the
  // states whose question isn't dynamic. verify/offer/confirm replay their
  // dynamic sentence inside reprompt() instead.
  stateRepromptId() {
    if (this.state === 'menu') return 'menu_retry';
    if (this.state === 'sched_window') return 'ask_sched_window';
    if (this.state === 'collect_key') return this.flow.steps[this.stepIndex].promptId;
    return null;
  }

  // --- internals ----------------------------------------------------------

  enterFlow(type) {
    this.flow = FLOWS[type];
    this.stepIndex = 0;
    return this.advanceStep();
  }

  // Play the current step's question. Keypad steps (step.keys) wait for a
  // digit in 'collect_key'; everything else listens for speech in 'collect'.
  askStep(prefix = []) {
    const step = this.flow.steps[this.stepIndex];
    this.state = step.keys ? 'collect_key' : 'collect';
    return [...prefix, { type: 'play', promptId: step.promptId }, { type: 'listen' }];
  }

  // Move to the next step the flow doesn't skip, or — past the last one —
  // finalize the flow and hand over to scheduling. Steps may branch lightly
  // without leaving the linear array: a step whose skip(session) returns
  // true is passed over (e.g. the insurance-company question variant for
  // the coverage type the caller does NOT have).
  advanceStep(announce = []) {
    while (this.stepIndex < this.flow.steps.length
      && this.flow.steps[this.stepIndex].skip?.(this)) {
      this.stepIndex += 1;
    }

    if (this.stepIndex < this.flow.steps.length) {
      return this.askStep(announce);
    }

    this.booking = this.flow.finalize(this.db, this.data, this);
    return [...announce, ...scheduling.startScheduling(this)];
  }

  async collectStep(transcript) {
    const step = this.flow.steps[this.stepIndex];
    const result = await this.extract.extractField(step.field, transcript);

    if (!this.extract.isConfident(result)) return this.reprompt();

    if (step.accept) {
      const verdict = step.accept(this.db, this, result.value);
      if (!verdict.ok) return this.reprompt(verdict.promptId);
    }

    return this.stageForVerify(step.field, result.value, result.confidence);
  }

  // Nothing is stored until the caller hears it back and agrees. A
  // confident extraction is not the same as a correct one — STT on an
  // elderly caller over a phone line mishears digits and surnames, and a
  // wrong DOB or phone number is invisible until the day of the visit.
  // Also the entry point for keypad steps that stage a known value (the
  // accepted caller-ID number), which is why confidence defaults to 1.
  stageForVerify(field, value, confidence = 1) {
    this.pending = {
      field,
      value,
      confidence,
      readback: fieldReadbackText(field, value),
    };
    // No read-back available for this field (or an unformattable value):
    // keep the answer as before rather than asking a question the caller
    // can't have heard.
    if (!this.pending.readback) return this.commitPending();

    this.state = 'verify';
    return this.verifyActions();
  }

  // "Entendí que ... ¿Es correcto?" — one short live-synthesized sentence
  // (the value) plus the cached keypad question.
  verifyActions() {
    return [
      { type: 'playText', text: this.pending.readback },
      { type: 'play', promptId: 'confirm_field' },
      { type: 'listen' },
    ];
  }

  // Caller confirmed the read-back (or the field had none): store it and
  // move on. A committed step's after(session) may name one cached prompt
  // to play before the next question (the Plan Vital referral reminder).
  commitPending() {
    const committedStep = this.flow.steps[this.stepIndex];
    const { field, value, confidence } = this.pending;
    this.data[field] = value;
    this.minConfidence = this.minConfidence === null
      ? confidence
      : Math.min(this.minConfidence, confidence);
    this.pending = null;
    this.stepIndex += 1;

    const announceId = committedStep.after?.(this) ?? null;
    const announce = announceId ? [{ type: 'play', promptId: announceId }] : [];

    return this.advanceStep(announce);
  }

  // Caller said the read-back was wrong: discard it and ask the same
  // question again — as many times as it takes. Routed through askStep so
  // a rejected keypad-step read-back (the caller-ID number) returns to the
  // keypad question, not to a speech listen.
  rejectPending() {
    this.pending = null;
    return this.askStep([{ type: 'play', promptId: 'retry_field' }]);
  }

  // Replay the current question after an unusable answer — indefinitely.
  // There is no attempt cap and no automatic transfer: the caller's ways
  // out are answering, 0 (a person, checked first in onDtmf), * (start
  // over), or hanging up, and menu_retry / reprompt_generic remind them
  // that 0 exists.
  reprompt(repromptId = null) {
    if (this.state === 'offer') {
      // replay the (dynamic) slot offer rather than a generic re-prompt
      return [{ type: 'playText', text: slotOfferText(this.slots) }, { type: 'listen' }];
    }
    if (this.state === 'confirm' && this.chosenSlot) {
      // replay the slot + question: what a caller who fumbled the keypress
      // needs is the date and time again — "¿podría repetirlo?" asks them
      // to repeat an answer while withholding the thing they'd answer about
      return [{ type: 'playText', text: confirmSlotText(this.chosenSlot) }, { type: 'listen' }];
    }
    if (this.state === 'verify' && this.pending) {
      // replay the read-back itself — a generic "¿podría repetirlo?" here
      // asks the caller to repeat an answer they were never re-asked for
      return this.verifyActions();
    }
    return [{ type: 'play', promptId: repromptId || 'reprompt_generic' }, { type: 'listen' }];
  }
}

module.exports = { CallSession };
