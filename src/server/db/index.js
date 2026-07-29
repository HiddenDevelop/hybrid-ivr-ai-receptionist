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
  // DB files created before reason_transcript existed don't get it from the
  // CREATE TABLE IF NOT EXISTS above — patch it in so inserts don't break.
  const apptCols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  if (!apptCols.includes('reason_transcript')) {
    db.exec('ALTER TABLE appointments ADD COLUMN reason_transcript TEXT');
  }
  return db;
}

module.exports = { openDb };
