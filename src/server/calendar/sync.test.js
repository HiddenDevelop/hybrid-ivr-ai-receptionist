const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { openDb } = require('../db/index');
const { createPatient } = require('../db/patients');
const { bookAppointment } = require('../db/appointments');
const {
  eventIdFor, buildEvent, syncPending, PATIENT_TYPE_LABELS,
} = require('./sync');
const { createCalendarClient } = require('./googleClient');

const TIME_ZONE = 'America/Puerto_Rico';
const FIXED_NOW = () => new Date(2026, 6, 24, 8, 0, 0);

let db;
beforeEach(() => {
  db = openDb(':memory:');
});

// Recording fake per the fakeExtract pattern: scripted results, captured calls.
function fakeClient(results = []) {
  const calls = [];
  return {
    calls,
    insertEvent: async ({ calendarId, event }) => {
      calls.push({ calendarId, event });
      const next = results.shift() ?? { ok: true, id: event.id };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function bookOne(overrides = {}) {
  const id = bookAppointment(db, {
    mrn: null,
    patientType: 'post_op',
    date: '2026-07-27',
    time: '09:00',
    ...overrides,
  });
  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
}

const quietLog = { log: () => {}, error: () => {} };

function sync(client, now = FIXED_NOW) {
  return syncPending({
    db, client, calendarId: 'primary', timeZone: TIME_ZONE, now, log: quietLog,
  });
}

test('migration adds the calendar outbox columns', () => {
  const cols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  for (const col of ['google_event_id', 'calendar_sync_attempts', 'calendar_last_attempt_at']) {
    assert.ok(cols.includes(col), `missing column ${col}`);
  }
});

test('happy path: booking gets an event and records its id', async () => {
  const row = bookOne();
  const client = fakeClient();
  await sync(client);

  assert.strictEqual(client.calls.length, 1);
  assert.strictEqual(client.calls[0].event.id, eventIdFor(row));
  const after = db.prepare('SELECT * FROM appointments WHERE id = ?').get(row.id);
  assert.strictEqual(after.google_event_id, eventIdFor(row));
  assert.strictEqual(after.calendar_sync_attempts, 1);
});

test('event payload carries name + type only — no other PHI', () => {
  const mrn = createPatient(db, {
    firstName: 'María',
    lastName: 'González',
    dob: '1938-03-12',
    phone: '7874902081',
    insuranceProvider: 'Triple-S',
  });
  const row = bookOne({
    mrn,
    patientType: 'new',
    reason: 'dolor abdominal persistente',
  });

  const event = buildEvent(db, row, { timeZone: TIME_ZONE });
  assert.deepStrictEqual(Object.keys(event).sort(), ['end', 'id', 'start', 'summary']);
  assert.strictEqual(event.summary, 'Cita: María González (paciente nuevo)');
  assert.strictEqual(event.start.dateTime, '2026-07-27T09:00:00');
  assert.strictEqual(event.start.timeZone, TIME_ZONE);
  assert.strictEqual(event.end.dateTime, '2026-07-27T10:00:00');

  const serialized = JSON.stringify(event);
  for (const phi of ['7874902081', '1938', 'Triple-S', 'abdomen', 'abdominal', mrn]) {
    assert.ok(!serialized.includes(phi), `event payload leaked "${phi}"`);
  }
});

test('every patient type maps to a Spanish label; missing patient falls back', () => {
  assert.deepStrictEqual(PATIENT_TYPE_LABELS, {
    new: 'paciente nuevo',
    follow_up: 'seguimiento',
    post_op: 'post-operatorio',
  });
  for (const [type, label] of Object.entries(PATIENT_TYPE_LABELS)) {
    const row = bookOne({ patientType: type });
    const event = buildEvent(db, row, { timeZone: TIME_ZONE });
    assert.strictEqual(event.summary, `Cita: paciente (${label})`, `mrn-less ${type}`);
  }
});

test('failure leaves the row pending and backs off before retrying', async () => {
  const row = bookOne();
  const client = fakeClient([new Error('HTTP 500')]);
  await sync(client);

  let after = db.prepare('SELECT * FROM appointments WHERE id = ?').get(row.id);
  assert.strictEqual(after.google_event_id, null);
  assert.strictEqual(after.calendar_sync_attempts, 1);

  // Same instant: backoff (30s after one attempt) has not elapsed.
  await sync(client);
  assert.strictEqual(client.calls.length, 1, 'no retry inside the backoff window');

  // 31s later: retried and succeeds.
  await sync(client, () => new Date(FIXED_NOW().getTime() + 31 * 1000));
  assert.strictEqual(client.calls.length, 2);
  after = db.prepare('SELECT * FROM appointments WHERE id = ?').get(row.id);
  assert.strictEqual(after.google_event_id, eventIdFor(row));
});

test('409 duplicate (event already created before a crash) counts as synced', async () => {
  const row = bookOne();
  const client = fakeClient([{ ok: true, id: eventIdFor(row), duplicate: true }]);
  await sync(client);

  const after = db.prepare('SELECT * FROM appointments WHERE id = ?').get(row.id);
  assert.strictEqual(after.google_event_id, eventIdFor(row));
});

test('already-synced rows are never re-sent (push-only)', async () => {
  const row = bookOne();
  db.prepare('UPDATE appointments SET google_event_id = ? WHERE id = ?')
    .run('existing-event', row.id);

  const client = fakeClient();
  await sync(client);
  assert.strictEqual(client.calls.length, 0);
});

// --- googleClient: token caching + 401 refresh, against a fake fetch ---

function writeTempCreds(dir) {
  const fs = require('node:fs');
  const path = require('node:path');
  const credsFile = path.join(dir, 'creds.json');
  const tokenFile = path.join(dir, 'token.json');
  fs.writeFileSync(credsFile, JSON.stringify({
    installed: { client_id: 'cid', client_secret: 'csec' },
  }));
  fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'rtok' }));
  return { credsFile, tokenFile };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('googleClient caches the access token and refreshes once on 401', async (t) => {
  const dir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'gcal-test-'),
  );
  t.after(() => require('node:fs').rmSync(dir, { recursive: true, force: true }));
  const { credsFile, tokenFile } = writeTempCreds(dir);

  const fetchCalls = [];
  const script = [
    jsonResponse(200, { access_token: 'tok1', expires_in: 3600 }), // initial refresh
    jsonResponse(200, { id: 'ev1' }), // insert #1
    jsonResponse(401, {}), // insert #2 rejected — token revoked
    jsonResponse(200, { access_token: 'tok2', expires_in: 3600 }), // re-refresh
    jsonResponse(200, { id: 'ev2' }), // insert #2 retried
  ];
  const client = createCalendarClient({
    credentialsFile: credsFile,
    tokenFile,
    now: () => FIXED_NOW().getTime(),
    fetchImpl: async (url, opts) => {
      fetchCalls.push({ url, auth: opts.headers?.Authorization });
      return script.shift();
    },
  });

  const first = await client.insertEvent({ calendarId: 'primary', event: { id: 'a' } });
  assert.strictEqual(first.id, 'ev1');
  const second = await client.insertEvent({ calendarId: 'primary', event: { id: 'b' } });
  assert.strictEqual(second.id, 'ev2');

  assert.strictEqual(fetchCalls.length, 5);
  assert.ok(fetchCalls[0].url.includes('oauth2.googleapis.com'), 'refresh first');
  assert.strictEqual(fetchCalls[1].auth, 'Bearer tok1');
  assert.strictEqual(fetchCalls[2].auth, 'Bearer tok1', 'cached token reused, no second refresh');
  assert.strictEqual(fetchCalls[4].auth, 'Bearer tok2', 'retried with the refreshed token');
});

test('createCalendarClient returns null when the token file is absent', () => {
  const dir = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'gcal-test-'),
  );
  const { credsFile } = writeTempCreds(dir);
  const client = createCalendarClient({
    credentialsFile: credsFile,
    tokenFile: require('node:path').join(dir, 'missing.json'),
  });
  assert.strictEqual(client, null);
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});
