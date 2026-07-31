// Shared scheduling step: all four patient paths converge here.
// Broad-to-narrow: first ask WHEN roughly (hoy / esta semana / la próxima
// semana / una fecha que el paciente sugiera; keypad 1-4), then offer up
// to two concrete slots inside that window (keypad again), then a 1/2
// confirmation -> book + SMS. Only the suggested specific date is spoken.
// Pure state handlers; declines and empty windows loop back to the broad
// question indefinitely — the only ways out of scheduling are booking a
// slot, pressing 0 for a person, * for the menu, or hanging up.

const { findOpenSlotsBetween, bookAppointment } = require('../db/appointments');
const {
  slotOfferText, nearestSlotOfferText, confirmSlotText, smsConfirmationText,
  bookingConfirmedNoSmsText,
} = require('../prompts');

// When the caller's window is full, search this far past it for the nearest
// bookable slot to propose, rather than bouncing them straight back to the
// window menu with nothing.
const NEAREST_SEARCH_DAYS = 60;

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
  return [
    { type: 'play', promptId: 'ask_sched_window' },
    { type: 'listen' },
  ];
}

// The caller understood an offer and turned it down — an answer, not a
// misfire. Back to the broad question, prefixed with a reminder that 0
// reaches a person: a caller declining round after round is looping by
// choice, but must never be trapped without hearing the way out.
function declineSlots(session) {
  return [
    { type: 'play', promptId: 'sched_retry_hint' },
    ...startScheduling(session),
  ];
}

// A window (or a specific date) was chosen. Returns null when the choice
// is unusable — the engine replays the current question.
function handleWindowSelection(session, window, specificDate = null) {
  if (window === 'specific' && !specificDate) {
    session.state = 'sched_date';
    return [
      { type: 'play', promptId: 'ask_preferred_date' },
      { type: 'listen' },
    ];
  }

  const range = windowRange(window, session.now(), specificDate);
  if (range === 'past') {
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
    // Grammar tracks what the caller asked for: one day (hoy, or a specific
    // date) gets "ese día", a week-wide window gets "esas fechas".
    const nonePromptId = (window === 'today' || window === 'specific')
      ? 'slots_none_day' : 'slots_none_window';

    // Don't leave the caller empty-handed: propose the nearest slot after
    // the window they asked for, as a normal one-slot offer.
    const nearest = findOpenSlotsBetween(session.db, {
      from: plusDays(range.to, 1),
      to: plusDays(range.to, NEAREST_SEARCH_DAYS),
      now: session.now(),
      count: 1,
    });
    if (nearest.length > 0) {
      session.slots = nearest;
      session.state = 'offer';
      return [
        { type: 'play', promptId: nonePromptId },
        { type: 'playText', text: nearestSlotOfferText(nearest[0]) },
        { type: 'listen' },
      ];
    }

    // Nothing bookable for weeks out either — say so (with the 0 reminder)
    // and go back to the window question.
    session.state = 'sched_window';
    return [
      { type: 'play', promptId: 'slots_none' },
      { type: 'play', promptId: 'ask_sched_window' },
      { type: 'listen' },
    ];
  }

  session.slots = slots;
  session.state = 'offer';
  return [
    { type: 'playText', text: slotOfferText(slots) },
    { type: 'listen' },
  ];
}

// 1 or 2 picks a slot; the decline KEY matches what the offer copy
// announces: 2 on a single-slot offer, 3 on a two-slot offer.
function handleSlotChoice(session, choice) {
  const declineKey = session.slots.length === 1 ? 2 : 3;
  if (choice === declineKey) return declineSlots(session);
  if (choice !== 1 && choice !== 2) return null; // engine replays the offer
  const slot = session.slots[choice - 1];
  if (!slot) return null;
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
  // Nudge the Google Calendar mirror so the booking lands within seconds
  // instead of waiting for the background interval. Fire-and-forget at the
  // dispatch layer — never blocks or fails the call.
  actions.push({ type: 'calendarSync' });
  actions.push({ type: 'hangup' });
  return actions;
}

module.exports = {
  startScheduling,
  handleWindowSelection,
  handleSlotChoice,
  handleConfirmation,
  WINDOW_DTMF,
};
