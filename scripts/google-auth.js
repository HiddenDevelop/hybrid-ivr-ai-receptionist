#!/usr/bin/env node
// One-time Google OAuth consent for the calendar mirror.
//
//   node --env-file-if-exists=.env scripts/google-auth.js
//
// Opens a loopback redirect server, prints the consent URL (open it in
// your Windows browser — WSL2 forwards localhost), and writes the refresh
// token to GOOGLE_TOKEN_FILE (default var/google-token.json, gitignored).
// If the redirect page fails to load, paste the full redirected URL from
// the browser's address bar into this terminal instead.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');

const { loadInstalledCreds } = require('../src/server/calendar/googleClient');

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const credentialsFile = process.env.GOOGLE_CREDENTIALS_FILE || 'credentials.json';
const tokenFile = process.env.GOOGLE_TOKEN_FILE || 'var/google-token.json';
const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

async function main() {
  const creds = loadInstalledCreds(credentialsFile);
  if (!creds) {
    console.error(`No OAuth client file at ${credentialsFile}.`);
    console.error('Create a "Desktop app" OAuth client in Google Cloud Console');
    console.error('(APIs & Services > Credentials), download its JSON, and save it there.');
    process.exit(1);
  }

  const state = crypto.randomBytes(16).toString('hex');
  let redirectUri; // set once the loopback server knows its port

  // Loopback server catches the consent redirect. Ephemeral port; the
  // redirect_uri must match EXACTLY in the auth URL and token exchange.
  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const err = url.searchParams.get('error');
      if (err) {
        res.end('Autorizacion rechazada. Puede cerrar esta ventana.');
        reject(new Error(`consent denied: ${err}`));
        return;
      }
      if (url.searchParams.get('state') !== state) {
        res.writeHead(400).end('state mismatch');
        return;
      }
      res.end('Listo — autorizacion recibida. Puede cerrar esta ventana.');
      server.close();
      resolve(url.searchParams.get('code'));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?'
        + new URLSearchParams({
          client_id: creds.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPE,
          access_type: 'offline', // required to get a refresh_token
          prompt: 'consent', // force a refresh_token even on re-consent
          state,
        });
      console.log('\nOpen this URL in your browser and approve access:\n');
      console.log(`  ${authUrl}\n`);
      console.log('If the final redirect page does not load, paste the full');
      console.log('URL from the address bar here and press Enter.\n');
    });
    // Fallback: user pastes the redirected URL (or just the code) on stdin.
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      try {
        const pasted = new URL(text);
        const code = pasted.searchParams.get('code');
        if (code) { rl.close(); server.close(); resolve(code); return; }
      } catch { /* not a URL — treat as a bare code */ }
      rl.close();
      server.close();
      resolve(text);
    });
  });

  const code = await codePromise;
  console.log('Exchanging authorization code for tokens...');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`token exchange failed (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  if (!data.refresh_token) {
    throw new Error('Google returned no refresh_token — remove this app under '
      + 'https://myaccount.google.com/permissions and run this script again.');
  }

  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(
    tokenFile,
    `${JSON.stringify({ refresh_token: data.refresh_token, obtained_at: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Refresh token saved to ${tokenFile}`);

  // Smoke test against the EVENTS endpoint — the only surface the sync
  // uses, and the only one the minimal calendar.events scope covers (the
  // calendar-metadata endpoint would 403 on this token by design).
  const calRes = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?maxResults=1`,
    { headers: { Authorization: `Bearer ${data.access_token}` } },
  );
  if (!calRes.ok) {
    const body = String(await calRes.text()).slice(0, 300);
    throw new Error(`token works but events on calendar "${calendarId}" are not accessible (HTTP ${calRes.status}): ${body}`);
  }
  console.log(`Calendar OK: events on "${calendarId}" are accessible`);
  console.log('Done — restart the Node server to enable calendar sync.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
