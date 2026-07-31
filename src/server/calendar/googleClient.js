// Minimal Google Calendar client — OAuth refresh-token grant + events
// insert, nothing else. Deliberately zero-dependency (global fetch, Node
// >= 20): the whole surface is two HTTPS endpoints, and pulling in
// googleapis for that adds ~100 packages to a repo that keeps its
// dependency list short.
//
// Credentials: an OAuth "installed app" client JSON (top-level key
// "installed") plus a refresh token minted once by scripts/google-auth.js.

const fs = require('node:fs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
// Refresh this many ms before the access token actually expires.
const EXPIRY_SLACK_MS = 60 * 1000;

function loadInstalledCreds(credentialsFile) {
  let raw;
  try {
    raw = fs.readFileSync(credentialsFile, 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw);
  const installed = parsed.installed || parsed.web;
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error(
      `${credentialsFile} is not an OAuth client JSON (expected top-level "installed" with client_id/client_secret)`,
    );
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

function loadRefreshToken(tokenFile) {
  let raw;
  try {
    raw = fs.readFileSync(tokenFile, 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw);
  if (!parsed.refresh_token) {
    throw new Error(`${tokenFile} has no refresh_token — re-run scripts/google-auth.js`);
  }
  return parsed.refresh_token;
}

// Returns null when the token file doesn't exist yet (sync disabled until
// the one-time consent flow runs). Throws on malformed files — silent
// misconfiguration would look identical to "not set up yet".
function createCalendarClient({ credentialsFile, tokenFile, fetchImpl = fetch, now = () => Date.now() }) {
  const creds = loadInstalledCreds(credentialsFile);
  if (!creds) return null;
  const refreshToken = loadRefreshToken(tokenFile);
  if (!refreshToken) return null;

  let accessToken = null;
  let accessTokenExpiresAt = 0;

  async function refreshAccessToken() {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) {
      const body = String(await res.text()).slice(0, 200);
      throw new Error(`token refresh failed (HTTP ${res.status}): ${body}`);
    }
    const data = await res.json();
    accessToken = data.access_token;
    accessTokenExpiresAt = now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SLACK_MS;
    return accessToken;
  }

  async function getAccessToken() {
    if (accessToken && now() < accessTokenExpiresAt) return accessToken;
    return refreshAccessToken();
  }

  // Resolves {ok: true, id} on success. A 409 means an event with our
  // client-supplied id already exists (a previous attempt succeeded but the
  // DB update was lost) — that IS success for a push-only mirror, reported
  // as {ok: true, id, duplicate: true}. Anything else throws.
  async function insertEvent({ calendarId, event }) {
    const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
    const doPost = async (token) => fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    let res = await doPost(await getAccessToken());
    if (res.status === 401) {
      // Token revoked or expired early — refresh once and retry.
      res = await doPost(await refreshAccessToken());
    }
    if (res.status === 409) return { ok: true, id: event.id, duplicate: true };
    if (!res.ok) {
      const body = String(await res.text()).slice(0, 200);
      throw new Error(`event insert failed (HTTP ${res.status}): ${body}`);
    }
    const data = await res.json();
    return { ok: true, id: data.id ?? event.id };
  }

  return { insertEvent };
}

module.exports = { createCalendarClient, loadInstalledCreds, loadRefreshToken };
