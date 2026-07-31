-- Prototype schema — SQLite only, no EHR write path, no staff-review
-- columns yet (deliberately: see CLAUDE.md non-goals).

-- Insurance is the plan name only: the clinic decided not to collect
-- policy/group numbers over the phone, and there are no allergy or
-- reason-for-visit questions (clinic decisions, 2026-07-30).
CREATE TABLE IF NOT EXISTS patients (
  mrn TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  dob TEXT,
  phone TEXT,
  insurance_provider TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn TEXT REFERENCES patients(mrn),
  patient_type TEXT CHECK(patient_type IN ('new','follow_up','post_op')),
  scheduled_date TEXT,
  scheduled_time TEXT,
  reason TEXT,
  extraction_confidence REAL,
  -- Google Calendar mirror outbox: NULL until the event is created, then
  -- the calendar event id. Attempts/last-attempt drive retry backoff.
  google_event_id TEXT,
  calendar_sync_attempts INTEGER NOT NULL DEFAULT 0,
  calendar_last_attempt_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
