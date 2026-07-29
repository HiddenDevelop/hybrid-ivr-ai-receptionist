// Shared scheduling step: all four patient paths converge here.
// Broad-to-narrow: first ask WHEN roughly (hoy / esta semana / la próxima
// semana / una fecha que el paciente sugiera), then offer up to two
// concrete slots inside that window, then yes/no confirm -> book + SMS.
// Pure state handlers; the session engine owns strike counting, but every
// handler resets the counter when it accepts an answer — a strike means
// "this question failed", so a fumble at the window question must not
// count against the slot offer or the confirmation later.

const { findOpenSlotsBetween, bookAppointment } = require('../db/appointments');
const {
  slotOfferText, confirmSlotText, smsConfirmationText,
  bookingConfirmedNoSmsText, PROMPTS,
} = require('../prompts');

// Total rounds of window-picking a caller gets (empty windows, past dates,
// and declined offers all consume a round) before we hand them to a human.
const MAX_OFFER_ROUNDS = 3;

const WINDOW_DTMF = { 1: 'today', 2: 'this_week', 3: 'next_week', 4: 'specific' };

function localMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function plusDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Maps a window choice to a local date range. Returns 'past' for a
// well-formed specific date that already went by — the caller gets told
// that instead of a generic "no le entendí" — and null for anything else
// unusable (bad window name, unparseable date).
function windowRange(window, now, specificDate = null) {
  const today = localMidnight(now);
  switch (window) {
    case 'today':
      return { from: today, to: today };
    case 'this_week': {
      // tomorrow through Sunday; if that's empty (Sat/Sun call), the
      // empty-slot path re-asks rather than silently bleeding into next week
      const sunday = plusDays(today, (7 - today.getDay()) % 7);
      return { from: plusDays(today, 1), to: sunday };
    }
    case 'next_week': {
      const nextMonday = plusDays(today, ((8 - today.getDay()) % 7) || 7);
      return { from: nextMonday, to: plusDays(nextMonday, 6) };
    }
    case 'specific': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(specificDate || '')) return null;
      const [y, m, d] = specificDate.split('-').map(Number);
      const day = new Date(y, m - 1, d);
      if (Number.isNaN(day.getTime())) return null;
      if (day.getTime() < today.getTime()) return 'past';
      return { from: day, to: day };
    }
    default:
      return null;
  }
}

// Entry point from the flows: ask the broad "when?" question.
function startScheduling(session) {
  session.state = 'sched_window';
  session.attempts = 0;
  session.offerRounds = (session.offerRounds || 0) + 1;
  return [
    { type: 'play', promptId: 'ask_sched_window' },
    { type: 'listen' },
  ];
}

// Out of rounds without a slot the caller could take. NOT the "couldn't
// understand you" handoff — this caller answered fine every time, so the
// goodbye must not sound like it was their fault.
function noSlotHandoff(session) {
  session.end();
  return [
    { type: 'play', promptId: 'slots_none' },
    { type: 'escalate', reason: 'no_acceptable_slot' },
  ];
}

// The caller understood an offer and turned it down — an answer, not a
// misfire. Back to the broad question, or a warm handoff once the rounds
// run out.
function declineSlots(session) {
  if (session.offerRounds >= MAX_OFFER_ROUNDS) return noSlotHandoff(session);
  return startScheduling(session);
}

// A window (or a specific date) was chosen. Returns null when the choice
// is unusable — the engine treats that as a strike on the current question.
function handleWindowSelection(session, window, specificDate = null) {
  if (window === 'specific' && !specificDate) {
    session.state = 'sched_date';
    session.attempts = 0;
    return [
      { type: 'play', promptId: 'ask_preferred_date' },
      { type: 'listen' },
    ];
  }

  const range = windowRange(window, session.now(), specificDate);
  if (range === 'past') {
    if (session.offerRounds >= MAX_OFFER_ROUNDS) return noSlotHandoff(session);
    session.attempts = 0;
    session.offerRounds += 1;
    session.state = 'sched_date';
    return [
      { type: 'play', promptId: 'date_in_past' },
      { type: 'play', promptId: 'ask_preferred_date' },
      { type: 'listen' },
    ];
  }
  if (!range) return null;

  const slots = findOpenSlotsBetween(session.db, { ...range, now: session.now(), count: 2 });
  if (slots.length === 0) {
    if (session.offerRounds >= MAX_OFFER_ROUNDS) return noSlotHandoff(session);
    session.attempts = 0;
    session.offerRounds += 1;
    session.state = 'sched_window';
    return [
      { type: 'play', promptId: 'slots_none_window' },
      { type: 'play', promptId: 'ask_sched_window' },
      { type: 'listen' },
    ];
  }

  session.attempts = 0;
  session.slots = slots;
  session.state = 'offer';
  return [
    { type: 'playText', text: slotOfferText(slots) },
    { type: 'listen' },
  ];
}

// 1 or 2 picks a slot; 0 declines the offer outright (spoken "ninguna" /
// "no"). The decline KEY matches what the offer copy announces: 2 on a
// single-slot offer ("oprima dos o diga no"), 3 on a two-slot offer
// ("oprima tres").
function handleSlotChoice(session, choice) {
  const declineKey = session.slots.length === 1 ? 2 : 3;
  if (choice === 0 || choice === declineKey) return declineSlots(session);
  if (choice !== 1 && choice !== 2) return null; // engine treats as a strike
  const slot = session.slots[choice - 1];
  if (!slot) return null;
  session.attempts = 0;
  session.chosenSlot = slot;
  session.state = 'confirm';
  return [
    { type: 'playText', text: confirmSlotText(slot) },
    { type: 'listen' },
  ];
}

function handleConfirmation(session, yes) {
  if (!yes) return declineSlots(session);

  const slot = session.chosenSlot;
  bookAppointment(session.db, {
    mrn: session.booking.mrn,
    patientType: session.flow.patientType,
    date: slot.date,
    time: slot.time,
    reason: session.booking.reason,
    reasonTranscript: session.booking.reasonTranscript,
    extractionConfidence: session.minConfidence,
  });
  session.end();

  const actions = [];
  const smsTo = session.booking.smsPhone || session.callerPhone;
  if (smsTo) {
    actions.push({ type: 'sms', to: smsTo, text: smsConfirmationText(slot) });
    actions.push({ type: 'play', promptId: 'booking_confirmed_sms' });
  } else {
    actions.push({ type: 'playText', text: bookingConfirmedNoSmsText(slot) });
  }
  actions.push({ type: 'hangup' });
  return actions;
}

module.exports = {
  startScheduling,
  handleWindowSelection,
  handleSlotChoice,
  handleConfirmation,
  windowRange,
  WINDOW_DTMF,
  MAX_OFFER_ROUNDS,
  PROMPTS,
};
