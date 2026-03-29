/**
 * claw-me.com — Admin Guard Worker
 *
 * Cloudflare Worker that protects claw-me.com/admin/* using the exact
 * same JWT session cookie mechanism as tenant containers (tenant-guard).
 *
 * Auth method:
 *   JWT session cookie (claw_session) — issued by claw-auth Worker for
 *   both password+MFA and Google OAuth login flows.
 *
 * Authorization:
 *   The authenticated email must be listed in the ADMIN_EMAILS secret
 *   (comma-separated). No Supabase lookup required — admin is a small
 *   trusted set of operator emails.
 *
 * Flow:
 *   1. Read JWT from claw_session cookie
 *   2. Verify JWT signature (HMAC-SHA256) + expiry
 *   3. Check email is in ADMIN_EMAILS
 *   4. Authorized  → proxy to origin (GitHub Pages static files)
 *   5. No session  → redirect to /login?redirect=/admin (preserves path)
 *   6. Not in list → 403 branded error page
 *
 * Environment variables:
 *   JWT_SECRET    - HMAC-SHA256 key shared with claw-auth + tenant-guard
 *   ADMIN_EMAILS  - Comma-separated list of admin emails (e.g. "alex@co.com,ops@co.com")
 *   BASE_DOMAIN   - claw-me.com
 *
 * Deploy:
 *   npx wrangler deploy --config wrangler-admin.toml
 *
 * Secrets to configure (one-time):
 *   npx wrangler secret put JWT_SECRET    --config wrangler-admin.toml
 *   npx wrangler secret put ADMIN_EMAILS  --config wrangler-admin.toml
 *
 * Route: claw-me.com/admin/*
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const baseDomain = env.BASE_DOMAIN || 'claw-me.com';

    // ── Authenticate via JWT session cookie ──
    let authedEmail = null;

    const jwt = getCookie(request, 'claw_session');
    if (jwt) {
      try {
        const payload = await verifyJwt(env.JWT_SECRET, jwt);
        if (payload && payload.email) {
          authedEmail = payload.email.toLowerCase();
        }
      } catch (e) {
        console.error('Admin guard JWT verification failed:', e.message);
      }
    }

    // No valid session — redirect to login with ?redirect= so we return here after auth
    if (!authedEmail) {
      const redirectPath = url.pathname + (url.search ? url.search : '');
      const loginUrl = `https://${baseDomain}/login?redirect=${encodeURIComponent(redirectPath)}`;
      return Response.redirect(loginUrl, 302);
    }

    // ── Check admin authorization ──
    const adminEmails = (env.ADMIN_EMAILS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    if (!adminEmails.includes(authedEmail)) {
      return new Response(forbidden(
        `<strong>${authedEmail}</strong> does not have access to the admin portal.`,
        baseDomain
      ), {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // ── Authorized admin — proxy to origin ──
    return fetch(request);
  }
};


/**
 * Extract a cookie value from the request.
 * Identical to tenant-guard implementation for consistency.
 */
function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.split('=');
    if (key.trim() === name) {
      return valueParts.join('=');
    }
  }
  return null;
}


/**
 * Verify a JWT token (HMAC-SHA256).
 * Identical to tenant-guard implementation — shares the same JWT_SECRET.
 */
async function verifyJwt(secret, token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const sigBytes = Uint8Array.from(base64UrlDecode(sigB64), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBytes, new TextEncoder().encode(signingInput)
  );

  if (!valid) return null;

  const payload = JSON.parse(base64UrlDecode(payloadB64));

  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}


/**
 * Branded 403 page matching the claw-me.com theme.
 * Identical style to tenant-guard forbidden page.
 */
function forbidden(message, baseDomain) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Access Denied — claw-me.com Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #0d0f14; color: #e8eaf0;
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
    }
    .card {
      background: #13161e; border: 1px solid #252a38;
      border-radius: 16px; padding: 48px 40px;
      max-width: 440px; width: 90%; text-align: center;
    }
    .icon { font-size: 3rem; margin-bottom: 16px; }
    h1 { font-size: 1.4rem; font-weight: 800; margin-bottom: 12px; }
    p { color: #8891a8; font-size: 0.92rem; line-height: 1.6; margin-bottom: 24px; }
    .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    a {
      display: inline-block;
      background: #ff4c29; color: #fff;
      border-radius: 8px; padding: 10px 24px;
      font-size: 0.88rem; font-weight: 700;
      text-decoration: none;
      transition: background 0.2s;
    }
    a:hover { background: #ff7a52; }
    a.secondary {
      background: transparent;
      border: 1px solid #252a38;
      color: #8891a8;
    }
    a.secondary:hover { background: #13161e; color: #e8eaf0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🦞</div>
    <h1>Admin Access Denied</h1>
    <p>${message}</p>
    <div class="actions">
      <a href="https://${baseDomain}/login?redirect=/admin">Sign in as admin</a>
      <a class="secondary" href="https://${baseDomain}">Back to home</a>
    </div>
  </div>
</body>
</html>`;
}
