// One-way, push-only mirror of the appointments table into Google
// Calendar. SQLite is the source of truth; the appointments table itself
// is the outbox — google_event_id IS NULL means "not pushed yet". Events
// are only ever created, never updated or deleted (see CLAUDE.md
// non-goals), and a failed push can never affect a call: the booking is
// already committed before sync runs.
//
// PHI boundary: buildEvent() is the ONLY place an event payload is
// assembled, and the only patient data it may include is the name and the
// patient type. No phone, DOB, MRN, reason, or transcript text — that is
// the recorded exception's hard limit (CLAUDE.md).

const crypto = require('node:crypto');
const { findByMrn } = require('../db/patients');

const EVENT_DURATION_MINUTES = 60;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

const PATIENT_TYPE_LABELS = {
  new: 'paciente nuevo',
  follow_up: 'seguimiento',
  post_op: 'post-operatorio',
};

// Client-supplied Calendar event id. Deterministic per appointment row so
// a crash between "event created" and "id recorded" heals on retry: the
// second insert gets a 409, which the client treats as success. Hex is a
// valid subset of Calendar's base32hex id charset; created_at salts
// against rowid reuse if the DB file is ever rebuilt.
function eventIdFor(row) {
  return crypto.createHash('sha256').update(`${row.id}|${row.created_at}`).digest('hex');
}

function summaryFor(db, row) {
  const label = PATIENT_TYPE_LABELS[row.patient_type] ?? row.patient_type;
  const patient = row.mrn ? findByMrn(db, row.mrn) : null;
  const name = [patient?.first_name, patient?.last_name].filter(Boolean).join(' ');
  return `Cita: ${name || 'paciente'} (${label})`;
}

// Slot times are the clinic's wall clock; the event carries the timezone
// explicitly instead of an offset so DST is Google's problem, not ours.
function buildEvent(db, row, { timeZone }) {
  const [h, m] = row.scheduled_time.split(':').map(Number);
  const endMinutes = h * 60 + m + EVENT_DURATION_MINUTES;
  const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
  return {
    id: eventIdFor(row),
    summary: summaryFor(db, row),
    start: { dateTime: `${row.scheduled_date}T${row.scheduled_time}:00`, timeZone },
    end: { dateTime: `${row.scheduled_date}T${endTime}:00`, timeZone },
  };
}

function backoffMs(attempts) {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

// Unsynced rows whose retry backoff has elapsed. Retried indefinitely —
// appointments are near-term, and the capped backoff (1h) bounds the cost.
function listPending(db, now) {
  return db.prepare(
    'SELECT * FROM appointments WHERE google_event_id IS NULL ORDER BY id',
  ).all().filter((row) => {
    if (!row.calendar_last_attempt_at) return true;
    const elapsed = now.getTime() - Date.parse(row.calendar_last_attempt_at);
    return elapsed >= backoffMs(row.calendar_sync_attempts);
  });
}

async function syncPending({
  db, client, calendarId, timeZone, now = () => new Date(), log = console,
}) {
  const pending = listPending(db, now());
  const bumpAttempt = db.prepare(
    'UPDATE appointments SET calendar_sync_attempts = calendar_sync_attempts + 1, calendar_last_attempt_at = ? WHERE id = ?',
  );
  const recordEventId = db.prepare(
    'UPDATE appointments SET google_event_id = ? WHERE id = ?',
  );

  for (const row of pending) {
    // Bump before calling out so a crash mid-request still counts as an
    // attempt and backs off instead of hammering.
    bumpAttempt.run(now().toISOString(), row.id);
    try {
      const event = buildEvent(db, row, { timeZone });
      const result = await client.insertEvent({ calendarId, event });
      recordEventId.run(result.id, row.id);
      log.log(`[calendar] synced appt #${row.id} -> event ${result.id}${result.duplicate ? ' (already existed)' : ''}`);
    } catch (err) {
      log.error(`[calendar] sync failed for appt #${row.id} (attempt ${row.calendar_sync_attempts + 1}): ${err.message}`);
    }
  }
}

// Background reconciler: one immediate pass caller-side (drains any
// backlog left by a restart or outage), then a low-frequency interval for
// retries. syncNow() is also fired after each booking so the happy path
// lands on the calendar within seconds.
function startCalendarSync({
  db, client, calendarId, timeZone, intervalMs = 60000, now = () => new Date(), log = console,
}) {
  let running = false;

  async function syncNow() {
    if (running) return; // serialize — overlapping passes would double-send
    running = true;
    try {
      await syncPending({ db, client, calendarId, timeZone, now, log });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    syncNow().catch((err) => log.error(`[calendar] sync pass failed: ${err.message}`));
  }, intervalMs);
  timer.unref(); // never keep the process alive just for retries

  return { syncNow, stop: () => clearInterval(timer) };
}

module.exports = {
  eventIdFor,
  buildEvent,
  listPending,
  syncPending,
  startCalendarSync,
  PATIENT_TYPE_LABELS,
  EVENT_DURATION_MINUTES,
};
