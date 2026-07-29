-- Prototype schema — SQLite only, no EHR write path, no staff-review
-- columns yet (deliberately: see CLAUDE.md non-goals).

CREATE TABLE IF NOT EXISTS patients (
  mrn TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  dob TEXT,
  phone TEXT,
  insurance_provider TEXT,
  policy_number TEXT,
  group_number TEXT,
  allergies TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn TEXT REFERENCES patients(mrn),
  referring_provider TEXT,
  referring_fax TEXT,
  authorization_code TEXT,
  procedure_type TEXT,
  received_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mrn TEXT REFERENCES patients(mrn),
  patient_type TEXT CHECK(patient_type IN ('new','follow_up','post_op','referral')),
  scheduled_date TEXT,
  scheduled_time TEXT,
  reason TEXT,
  -- Verbatim STT transcript the reason was extracted from — the caller's
  -- actual words, next to the model's cleaned rendering above.
  reason_transcript TEXT,
  extraction_confidence REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
