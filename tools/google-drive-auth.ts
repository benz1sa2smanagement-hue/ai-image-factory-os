import http from 'node:http';
import { URL } from 'node:url';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your local shell. Never commit them.');
}

const redirectUri = 'http://127.0.0.1:53682/oauth2/callback';
const scope = 'https://www.googleapis.com/auth/drive.file';
const state = crypto.randomUUID();
const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
auth.searchParams.set('client_id', clientId);
auth.searchParams.set('redirect_uri', redirectUri);
auth.searchParams.set('response_type', 'code');
auth.searchParams.set('scope', scope);
auth.searchParams.set('access_type', 'offline');
auth.searchParams.set('prompt', 'consent');
auth.searchParams.set('state', state);

console.log('\nOpen this URL in your browser and approve Drive access:\n');
console.log(auth.toString());
console.log('\nWaiting for OAuth callback on 127.0.0.1:53682 ...');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1:53682');
  if (url.pathname !== '/oauth2/callback') {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('Invalid state');
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Missing code');
    return;
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.refresh_token) {
    res.writeHead(500).end('OAuth exchange failed. Check the terminal for details.');
    console.error(JSON.stringify(token));
    server.close();
    process.exitCode = 1;
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Authorization complete. You can close this browser tab.');
  console.log('\nGOOGLE_REFRESH_TOKEN=\n' + token.refresh_token);
  console.log('\nStore this value only as a Cloudflare Worker secret. Do not commit it.');
  server.close();
});

server.listen(53682, '127.0.0.1');
