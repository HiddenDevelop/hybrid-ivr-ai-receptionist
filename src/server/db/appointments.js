// Slot search + booking against SQLite only (no calendar backend — see
// CLAUDE.md non-goals). Prototype slot model: weekdays, three fixed times,
// a slot is free if no appointment row occupies it.
//
// All date math is LOCAL time (the clinic's clock), never UTC — a slot
// list must not shift by a day because the box's timezone differs from
// the string formatting.

const SLOT_TIMES = ['09:00', '11:00', '14:00'];
// Same-day bookings need at least this much notice.
const MIN_LEAD_MINUTES = 60;

function isWeekday(date) {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function toLocalIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Open slots between two dates (inclusive, local midnight-to-midnight).
// `now` filters out same-day times that are already too close. When the
// range spans several days, the returned slots prefer DISTINCT days —
// "Monday at 9 or Tuesday at 9" is a real choice; "Monday at 9 or Monday
// at 11" isn't, for a caller who can't do Mondays. Same-day times are the
// fallback when one day is all the range has.
function findOpenSlotsBetween(db, { from, to, now, count = 2 }) {
  const taken = new Set(
    db.prepare('SELECT scheduled_date, scheduled_time FROM appointments').all()
      .map((r) => `${r.scheduled_date} ${r.scheduled_time}`),
  );
  const earliest = now.getTime() + MIN_LEAD_MINUTES * 60 * 1000;

  const open = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cursor.getTime() <= end.getTime()) {
    if (isWeekday(cursor)) {
      const date = toLocalIso(cursor);
      for (const time of SLOT_TIMES) {
        const [h, min] = time.split(':').map(Number);
        const slotAt = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), h, min);
        if (slotAt.getTime() < earliest) continue;
        if (!taken.has(`${date} ${time}`)) open.push({ date, time });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  // First pass takes the earliest slot of each day; second pass fills any
  // remaining seats chronologically from what's left.
  const picked = [];
  const usedDays = new Set();
  for (const slot of open) {
    if (picked.length >= count) break;
    if (usedDays.has(slot.date)) continue;
    usedDays.add(slot.date);
    picked.push(slot);
  }
  for (const slot of open) {
    if (picked.length >= count) break;
    if (!picked.includes(slot)) picked.push(slot);
  }
  picked.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return picked;
}

function bookAppointment(db, {
  mrn, patientType, date, time, reason, reasonTranscript, extractionConfidence,
}) {
  const info = db.prepare(`
    INSERT INTO appointments (mrn, patient_type, scheduled_date, scheduled_time, reason, reason_transcript, extraction_confidence)
    VALUES (@mrn, @patientType, @date, @time, @reason, @reasonTranscript, @extractionConfidence)
  `).run({
    mrn: mrn ?? null,
    patientType,
    date,
    time,
    reason: reason ?? null,
    reasonTranscript: reasonTranscript ?? null,
    extractionConfidence: extractionConfidence ?? null,
  });
  return info.lastInsertRowid;
}

module.exports = { findOpenSlotsBetween, bookAppointment, SLOT_TIMES, MIN_LEAD_MINUTES, toLocalIso };
