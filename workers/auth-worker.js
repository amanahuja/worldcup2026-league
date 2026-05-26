/**
 * auth-worker.js
 * POST /api/login — validates username/passphrase against KV, issues HMAC session cookie.
 *
 * Bindings required:
 *   WC2026_USERS  — KV namespace (key: username, value: passphrase)
 *   SESSION_SECRET — Worker secret (random hex string, min 32 bytes)
 */

const COOKIE_NAME = 'wc2026_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ---------------------------------------------------------------------------
// HMAC helpers (Web Crypto API — no external dependencies)
// ---------------------------------------------------------------------------

async function getSigningKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signPayload(payload, secret) {
  const key = await getSigningKey(secret);
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${btoa(JSON.stringify(payload))}.${sigB64}`;
}

export async function verifySessionToken(token, secret) {
  try {
    const [payloadB64, sigB64] = token.split('.');
    if (!payloadB64 || !sigB64) return null;
    const payload = JSON.parse(atob(payloadB64));
    if (!payload.username || !payload.exp) return null;
    if (Date.now() / 1000 > payload.exp) return null; // expired

    const key = await getSigningKey(secret);
    const enc = new TextEncoder();
    const data = enc.encode(JSON.stringify(payload));
    const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, data);
    return valid ? payload : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleLogin(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { username, passphrase } = body;
  if (!username || !passphrase) {
    return new Response(JSON.stringify({ error: 'Missing username or passphrase' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Look up passphrase in KV
  const storedPassphrase = await env.WC2026_USERS.get(username.toLowerCase());
  if (!storedPassphrase || storedPassphrase !== passphrase) {
    return new Response(JSON.stringify({ error: 'Invalid username or passphrase' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Issue session token
  const payload = {
    username: username.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const token = await signPayload(payload, env.SESSION_SECRET);

  const cookie = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'Path=/',
  ].join('; ');

  return new Response(JSON.stringify({ ok: true, username: payload.username }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
}

// ---------------------------------------------------------------------------
// Session extraction helper (used by other workers)
// ---------------------------------------------------------------------------

export async function getSession(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return verifySessionToken(match[1], env.SESSION_SECRET);
}
