// Per-call state machine. Transport-agnostic: consumes DTMF digits and
// Spanish transcripts, emits action lists —
//   {type:'play', promptId}     cached prompt
//   {type:'playText', text}     dynamic sentence (live TTS, logged by cache)
//   {type:'listen'}             capture the caller's next turn
//   {type:'escalate', reason}   red flag / human handoff / no slots
//   {type:'sms', to, text}      Spanish confirmation SMS
//   {type:'hangup'}
// index.js maps actions to Twilio Media Streams; tests drive this directly.
//
// Safety property (the point of the whole design): checkRedFlags runs on
// EVERY raw transcript, in every state, before any extraction call. The
// LLM can misbehave arbitrarily and still cannot suppress an escalation.

const { checkRedFlags } = require('../extraction/redFlags');
const defaultExtract = require('../extraction/extract');
const {
  MENU_SPEECH_ENABLED, fieldReadbackText, slotOfferText, confirmSlotText,
} = require('../prompts');
const { FLOWS, DTMF_MAP } = require('./menu');
const scheduling = require('./scheduling');

// 3 failed attempts on the same question -> stop guessing, hand to a human
// (CLAUDE.md extraction contract: accept >=0.7, re-prompt below, bail at 3).
const MAX_ATTEMPTS = 3;

// Pressing this at any point restarts the call at the main menu.
const RETURN_TO_MENU_KEY = '*';

// Pressing this at any point leaves the automated flow entirely and puts
// the caller through to the scheduling team. Checked before every other
// piece of DTMF routing, in every state, so it can never be swallowed by
// the state machine — the same reasoning as the red-flag gate: the way out
// must not depend on the call being in a state that understands it.
const OPERATOR_KEY = '0';

class CallSession {
  constructor({
    db,
    callerPhone = null,
    now = () => new Date(),
    extract = defaultExtract,
    menuSpeechEnabled = MENU_SPEECH_ENABLED,
  } = {}) {
    this.db = db;
    this.callerPhone = callerPhone;
    this.now = now;
    this.extract = extract;
    this.menuSpeechEnabled = menuSpeechEnabled;

    this.turnCount = 0;
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
    this.attempts = 0;
    this.data = {};
    // Verbatim STT transcript each confirmed field was extracted from,
    // keyed like this.data. Kept so free-text fields (the visit reason) can
    // be stored next to the caller's actual words instead of only the
    // model's rendering of them.
    this.transcripts = {};
    // Field extracted but not yet confirmed by the caller (verify state).
    this.pending = null;
    // Company name mentioned before its own question came up (e.g. the
    // caller answered the insurance-TYPE question with "tengo Triple-S").
    // Held by the flow's accept() until the type resolves, then merged into
    // that field's value — never committed on its own.
    this.providerHint = null;
    this.patient = null;
    this.minConfidence = null;
    this.slots = null;
    this.chosenSlot = null;
    this.booking = null;
    this.offerRounds = 0;
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

  // How long a pause the turn detector should tolerate before treating the
  // caller as finished. The clinic's callers are mostly elderly and pause
  // INSIDE open answers while recalling digits ("mil novecientos... treinta
  // y ocho"); closing the turn on that pause hands STT a fragment, and a
  // clipped date still has to produce a YYYY-MM-DD, so the model invents the
  // missing part at high confidence instead of failing. States expecting one
  // word or one keypress have nothing to pause in the middle of, so they stay
  // fast. Consumed by index.js, which sizes the TurnDetector from it.
  // "verify" is a sí/no answer to a read-back, so it stays short.
  get turnProfile() {
    return this.state === 'collect' || this.state === 'sched_date' ? 'open' : 'short';
  }

  // Whether the caller's VOICE may interrupt the prompt now playing.
  // Suppressed in the two read-back states (field verify, slot confirm):
  // the sentence being spoken there is exactly what the caller must catch
  // in full, and this caller base backchannels ("ajá", "sí sí") while
  // listening — a backchannel, a cough, or a Whisper hallucination on
  // near-silence ("Gracias.") would cancel the read-back mid-number and
  // hand the sí/no extraction a garbage transcript. The KEYPAD still
  // interrupts everywhere (index.js handles dtmf regardless of mode), so a
  // caller who already knows their answer is never stuck waiting.
  get bargeInAllowed() {
    return this.state !== 'verify' && this.state !== 'confirm';
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
        { type: 'escalate', reason: 'caller_request' },
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
      return this.strike();
    }
    if (this.state === 'menu') {
      const type = DTMF_MAP[n];
      if (!type) return this.strike('menu_retry');
      return this.enterFlow(type);
    }
    if (this.state === 'sched_window') {
      const window = scheduling.WINDOW_DTMF[n];
      if (!window) return this.strike('ask_sched_window');
      return scheduling.handleWindowSelection(this, window) ?? this.strike('ask_sched_window');
    }
    if (this.state === 'sched_date') {
      // the suggested date has to be spoken; keys don't encode a date
      return this.strike('ask_preferred_date');
    }
    if (this.state === 'offer') {
      const actions = scheduling.handleSlotChoice(this, n);
      return actions ?? this.strike();
    }
    if (this.state === 'confirm') {
      // 1 = sí, 2 = no, anything else is a strike
      if (n === 1 || n === 2) return scheduling.handleConfirmation(this, n === 1);
      return this.strike();
    }
    // DTMF during open-ended data collection isn't meaningful — re-ask.
    return this.strike();
  }

  // --- input: transcript --------------------------------------------------

  async onTranscript(transcript) {
    if (this.ended) return [];
    this.turnCount += 1;

    // Red-flag gate FIRST, plain code, every state, every flow.
    const matched = checkRedFlags(transcript);
    if (matched) {
      this.end();
      return [
        { type: 'play', promptId: 'escalate_red_flag' },
        { type: 'escalate', reason: 'red_flag', matched },
      ];
    }

    if (this.state === 'menu') {
      // Menu is DTMF-only unless MENU_SPEECH_ENABLED — speech here goes
      // straight to a "please press a key" retry (still strike-limited so
      // a noisy line ends at a human, not an infinite loop). The red-flag
      // gate above already ran regardless.
      if (!this.menuSpeechEnabled) return this.strike('menu_retry');
      const result = await this.extract.extractField('patientType', transcript);
      if (!this.extract.isConfident(result) || result.value.patient_type === 'unknown') {
        return this.strike('menu_retry');
      }
      return this.enterFlow(result.value.patient_type);
    }

    if (this.state === 'collect') {
      return this.collectStep(transcript);
    }

    if (this.state === 'verify') {
      const result = await this.extract.extractField('yesNo', transcript);
      // "unknown" (not an answer: a fragment, "Gracias.", line noise) is a
      // strike, which replays the read-back — never a guessed no, which
      // would discard a value the caller may have confirmed correct.
      if (!this.extract.isConfident(result) || result.value.answer === 'unknown') {
        return this.strike();
      }
      return result.value.answer === 'yes' ? this.commitPending() : this.rejectPending();
    }

    if (this.state === 'sched_window') {
      const result = await this.extract.extractField('schedWindow', transcript);
      if (!this.extract.isConfident(result) || result.value.window === 'unknown') {
        return this.strike('ask_sched_window');
      }
      const actions = scheduling.handleWindowSelection(this, result.value.window, result.value.date);
      return actions ?? this.strike('ask_sched_window');
    }

    if (this.state === 'sched_date') {
      const result = await this.extract.extractField('preferredDate', transcript);
      if (!this.extract.isConfident(result)) return this.strike('ask_preferred_date');
      const actions = scheduling.handleWindowSelection(this, 'specific', result.value.date);
      return actions ?? this.strike('ask_preferred_date');
    }

    if (this.state === 'offer') {
      // A single-slot offer is a yes/no question ("si le sirve... diga
      // sí"), not a pick-one — asking the model which of "option 1 and
      // option 2" a lone "sí" refers to invites a misfire.
      if (this.slots.length === 1) {
        const result = await this.extract.extractField('yesNo', transcript);
        if (!this.extract.isConfident(result) || result.value.answer === 'unknown') {
          return this.strike();
        }
        return scheduling.handleSlotChoice(this, result.value.answer === 'yes' ? 1 : 0) ?? this.strike();
      }
      const result = await this.extract.extractField('slotChoice', transcript);
      if (!this.extract.isConfident(result) || result.value.choice === 'unknown') {
        return this.strike();
      }
      const choice = { first: 1, second: 2, neither: 0 }[result.value.choice];
      const actions = scheduling.handleSlotChoice(this, choice);
      return actions ?? this.strike();
    }

    if (this.state === 'confirm') {
      const result = await this.extract.extractField('yesNo', transcript);
      if (!this.extract.isConfident(result) || result.value.answer === 'unknown') {
        return this.strike();
      }
      return scheduling.handleConfirmation(this, result.value.answer === 'yes');
    }

    return [];
  }

  // --- internals ----------------------------------------------------------

  enterFlow(type) {
    this.flow = FLOWS[type];
    this.state = 'collect';
    this.stepIndex = 0;
    this.attempts = 0;
    return [{ type: 'play', promptId: this.flow.steps[0].promptId }, { type: 'listen' }];
  }

  async collectStep(transcript) {
    const step = this.flow.steps[this.stepIndex];
    const result = await this.extract.extractField(step.field, transcript);

    if (!this.extract.isConfident(result)) return this.strike();

    if (step.accept) {
      const verdict = step.accept(this.db, this, result.value);
      if (verdict.escalate) {
        this.end();
        return [
          { type: 'play', promptId: 'escalate_red_flag' },
          { type: 'escalate', reason: verdict.escalate },
        ];
      }
      if (!verdict.ok) return this.strike(verdict.promptId);
    }

    // Nothing is stored until the caller hears it back and agrees. A
    // confident extraction is not the same as a correct one — STT on an
    // elderly caller over a phone line mishears digits and surnames, and a
    // wrong DOB or phone number is invisible until the day of the visit.
    this.pending = {
      field: step.field,
      value: result.value,
      transcript,
      confidence: result.confidence,
      readback: fieldReadbackText(step.field, result.value),
    };
    // No read-back available for this field (or an unformattable value):
    // keep the answer as before rather than asking a question the caller
    // can't have heard.
    if (!this.pending.readback) return this.commitPending();

    this.state = 'verify';
    return this.verifyActions();
  }

  // "Entendí que ... ¿Es correcto?" — one short live-synthesized sentence
  // (the value) plus the cached question.
  verifyActions() {
    return [
      { type: 'playText', text: this.pending.readback },
      { type: 'play', promptId: 'confirm_field' },
      { type: 'listen' },
    ];
  }

  // Caller confirmed the read-back (or the field had none): store it and
  // move to the next question, or to scheduling if that was the last one.
  // Steps may branch lightly without leaving the linear array: a step whose
  // skip(session) returns true is passed over (e.g. the insurance-company
  // question variant for the coverage type the caller does NOT have), and a
  // committed step's after(session) may name one cached prompt to play
  // before the next question (the Plan Vital referral reminder).
  commitPending() {
    const committedStep = this.flow.steps[this.stepIndex];
    const { field, value, transcript, confidence } = this.pending;
    this.data[field] = value;
    this.transcripts[field] = transcript ?? null;
    this.minConfidence = this.minConfidence === null
      ? confidence
      : Math.min(this.minConfidence, confidence);
    this.pending = null;
    this.attempts = 0;
    this.stepIndex += 1;
    while (this.stepIndex < this.flow.steps.length
      && this.flow.steps[this.stepIndex].skip?.(this)) {
      this.stepIndex += 1;
    }
    this.state = 'collect';

    const announceId = committedStep.after?.(this) ?? null;
    const announce = announceId ? [{ type: 'play', promptId: announceId }] : [];

    if (this.stepIndex < this.flow.steps.length) {
      return [...announce, { type: 'play', promptId: this.flow.steps[this.stepIndex].promptId }, { type: 'listen' }];
    }

    this.booking = this.flow.finalize(this.db, this.data, this);
    return [...announce, ...scheduling.startScheduling(this)];
  }

  // Caller said the read-back was wrong: discard it and ask the same
  // question again. Counted as an attempt, so a field that keeps coming
  // back wrong ends at a human instead of looping forever.
  rejectPending() {
    this.pending = null;
    this.attempts += 1;
    if (this.attempts >= MAX_ATTEMPTS) return this.handoffToHuman();
    this.state = 'collect';
    return [
      { type: 'play', promptId: 'retry_field' },
      { type: 'play', promptId: this.flow.steps[this.stepIndex].promptId },
      { type: 'listen' },
    ];
  }

  // One failed attempt at the current question. Re-prompt (optionally with
  // a state-specific prompt) until the 3rd failure, then hand off.
  strike(repromptId = null) {
    this.attempts += 1;
    if (this.attempts >= MAX_ATTEMPTS) return this.handoffToHuman();
    if (this.state === 'offer') {
      // replay the (dynamic) slot offer rather than a generic re-prompt
      return [{ type: 'playText', text: slotOfferText(this.slots) }, { type: 'listen' }];
    }
    if (this.state === 'confirm' && this.chosenSlot) {
      // replay the slot + question: what a caller who fumbled the sí/no
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

  handoffToHuman() {
    this.end();
    return [
      { type: 'play', promptId: 'handoff_human' },
      { type: 'escalate', reason: 'extraction_failure' },
    ];
  }
}

module.exports = { CallSession, MAX_ATTEMPTS };
