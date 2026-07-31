// Single shared SQLite handle. Everything else in db/ takes the db object
// as an argument so tests can run against ':memory:' without touching the
// real file.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function openDb(dbPath = process.env.DB_PATH || 'var/clinic.db') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  // DB files created before these columns existed don't get them from the
  // CREATE TABLE IF NOT EXISTS above — patch them in so inserts don't break.
  const apptCols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  const apptMigrations = [
    ['google_event_id', 'TEXT'],
    ['calendar_sync_attempts', 'INTEGER NOT NULL DEFAULT 0'],
    ['calendar_last_attempt_at', 'TEXT'],
  ];
  for (const [col, ddl] of apptMigrations) {
    if (!apptCols.includes(col)) {
      db.exec(`ALTER TABLE appointments ADD COLUMN ${col} ${ddl}`);
    }
  }
  return db;
}

module.exports = { openDb };
