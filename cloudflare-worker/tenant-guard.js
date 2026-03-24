/**
 * claw-me.com — Tenant Guard Worker
 *
 * Cloudflare Worker that enforces tenant ownership at the edge.
 * Runs on *.claw-me.com — NO dependency on Cloudflare Access.
 *
 * Auth method:
 *   JWT session cookie (claw_session) — issued by claw-auth worker
 *   for both password+MFA and Google OAuth users.
 *
 * Flow:
 *   1. Extract subdomain from Host header
 *   2. Read JWT from claw_session cookie
 *   3. Verify JWT signature + expiry
 *   4. Look up tenant in Supabase: instances → users (role='owner' or 'member')
 *   5. If email matches → pass through (inject email header for auth-proxy.py)
 *   6. If not → redirect to login page
 *
 * Environment variables:
 *   SUPABASE_URL         - e.g., https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY - service role key (secret)
 *   BASE_DOMAIN          - claw-me.com
 *   JWT_SECRET           - HMAC-SHA256 key (same as claw-auth worker)
 *
 * Deploy:
 *   npx wrangler deploy --name tenant-guard
 *   Route: *.claw-me.com/*
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;
    const baseDomain = env.BASE_DOMAIN || 'claw-me.com';

    // Only run on tenant subdomains (*.claw-me.com), skip root domain
    if (host === baseDomain || host === `www.${baseDomain}`) {
      return fetch(request);
    }

    // Extract subdomain (e.g., "tenant-abc123" from "tenant-abc123.claw-me.com")
    const subdomain = host.replace(`.${baseDomain}`, '');

    // Skip non-tenant subdomains (admin, litellm, auth, etc.)
    const SKIP_SUBDOMAINS = ['admin', 'www', 'litellm', 'api', 'auth'];
    if (SKIP_SUBDOMAINS.includes(subdomain)) {
      return fetch(request);
    }

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
        console.error('JWT verification failed:', e.message);
      }
    }

    // No valid session — redirect to login
    if (!authedEmail) {
      const loginUrl = `https://${baseDomain}/login`;
      return Response.redirect(loginUrl, 302);
    }

    // Look up tenant ownership in Supabase
    try {
      const isAuthorized = await checkTenantOwnership(
        env.SUPABASE_URL,
        env.SUPABASE_SERVICE_KEY,
        subdomain,
        baseDomain,
        authedEmail
      );

      if (!isAuthorized) {
        return new Response(forbidden('You do not have access to this instance.'), {
          status: 403,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    } catch (err) {
      console.error('Tenant guard error:', err.message);
      // On lookup failure, fail closed — deny access
      return new Response(forbidden('Unable to verify access. Please try again.'), {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Authorized — pass through to origin
    // Inject the email header so auth-proxy.py (Layer 2) works seamlessly
    const modifiedRequest = new Request(request);
    modifiedRequest.headers.set('Cf-Access-Authenticated-User-Email', authedEmail);
    return fetch(modifiedRequest);
  }
};


/**
 * Check if the authenticated email is an owner/member of the tenant
 * that owns the given subdomain.
 */
async function checkTenantOwnership(supabaseUrl, serviceKey, subdomain, baseDomain, email) {
  const endpointUrl = `https://${subdomain}.${baseDomain}`;

  // Step 1: Find the tenant_id from the instances table by endpoint_url
  const instanceRes = await fetch(
    `${supabaseUrl}/rest/v1/instances?endpoint_url=eq.${encodeURIComponent(endpointUrl)}&select=tenant_id&limit=1`,
    {
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      }
    }
  );

  if (!instanceRes.ok) {
    throw new Error(`Supabase instances lookup failed: ${instanceRes.status}`);
  }

  const instances = await instanceRes.json();
  if (!instances.length) {
    // No instance found for this subdomain — deny
    return false;
  }

  const tenantId = instances[0].tenant_id;

  // Step 2: Check if the authenticated email has owner or member role for this tenant
  const userRes = await fetch(
    `${supabaseUrl}/rest/v1/users?tenant_id=eq.${tenantId}&email=eq.${encodeURIComponent(email)}&role=in.(owner,member)&select=id&limit=1`,
    {
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`
      }
    }
  );

  if (!userRes.ok) {
    throw new Error(`Supabase users lookup failed: ${userRes.status}`);
  }

  const users = await userRes.json();
  return users.length > 0;
}


/**
 * Extract a cookie value from the request
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
 * Verify a JWT token (HMAC-SHA256)
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
 * Branded 403 page matching the claw-me.com theme
 */
function forbidden(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Access Denied — claw-me.com</title>
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
    a {
      display: inline-block;
      background: #ff4c29; color: #fff;
      border-radius: 8px; padding: 10px 24px;
      font-size: 0.88rem; font-weight: 700;
      text-decoration: none;
      transition: background 0.2s;
    }
    a:hover { background: #ff7a52; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🦞</div>
    <h1>Access Denied</h1>
    <p>${message}</p>
    <a href="https://claw-me.com/login">Sign in to claw-me.com</a>
  </div>
</body>
</html>`;
}
