/**
 * claw-me.com — Auth API Worker
 *
 * Cloudflare Worker that handles ALL authentication for claw-me.com.
 * This is the single source of truth for auth — no Cloudflare Access dependency.
 *
 * Auth methods:
 *   1. Email + Password + Email MFA (primary)
 *   2. Google OAuth 2.0 (alternative)
 *
 * Both methods issue the same JWT session cookie (claw_session) on .claw-me.com
 * so tenant-guard can authorize requests uniformly.
 *
 * Endpoints:
 *   POST /login             - Verify email + password, trigger MFA code email
 *   POST /verify-mfa        - Verify MFA code, issue JWT session cookie
 *   POST /change-password   - Change password (first login or voluntary)
 *   POST /logout            - Clear session cookie
 *   GET  /auth/google       - Redirect to Google OAuth consent screen
 *   GET  /auth/google/callback - Handle Google OAuth callback, issue JWT
 *
 * Environment variables:
 *   SUPABASE_URL            - e.g., https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY    - service role key (secret)
 *   JWT_SECRET              - HMAC-SHA256 signing key for session JWTs
 *   N8N_MFA_WEBHOOK_URL     - n8n webhook URL that sends MFA code emails
 *   ALLOWED_ORIGIN          - https://claw-me.com (for CORS)
 *   GOOGLE_CLIENT_ID        - Google OAuth 2.0 client ID
 *   GOOGLE_CLIENT_SECRET    - Google OAuth 2.0 client secret
 *
 * Deploy:
 *   npx wrangler deploy --config wrangler-auth.toml
 */

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(env, new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── GET routes (Google OAuth redirects) ──
      if (request.method === 'GET') {
        switch (path) {
          case '/auth/google':
            return handleGoogleRedirect(url, env);
          case '/auth/google/callback':
            return await handleGoogleCallback(url, env);
          default:
            return corsResponse(env, jsonResponse({ error: 'Not found' }, 404));
        }
      }

      // ── POST routes (password auth) ──
      if (request.method !== 'POST') {
        return corsResponse(env, jsonResponse({ error: 'Method not allowed' }, 405));
      }

      switch (path) {
        case '/login':
          return corsResponse(env, await handleLogin(request, env));
        case '/verify-mfa':
          return corsResponse(env, await handleVerifyMfa(request, env));
        case '/change-password':
          return corsResponse(env, await handleChangePassword(request, env));
        case '/logout':
          return corsResponse(env, handleLogout(env));
        default:
          return corsResponse(env, jsonResponse({ error: 'Not found' }, 404));
      }
    } catch (err) {
      console.error('Auth worker error:', err.message, err.stack);
      return corsResponse(env, jsonResponse({ error: 'Internal server error' }, 500));
    }
  }
};


// ═══════════════════════════════════════════════════════════════
// GOOGLE OAUTH 2.0
// ═══════════════════════════════════════════════════════════════

/**
 * GET /auth/google?instance=<subdomain>
 * Redirects user to Google's OAuth consent screen.
 * The instance subdomain is stored in the OAuth state parameter.
 */
function handleGoogleRedirect(url, env) {
  const instance = url.searchParams.get('instance') || '';

  if (!instance) {
    return new Response(errorPage('Missing instance parameter. Please go back and enter your instance name.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Build state: instance subdomain (we'll use it after callback to redirect)
  const state = encodeURIComponent(instance);

  const callbackUrl = `${url.origin}/auth/google/callback`;

  const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleAuthUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  googleAuthUrl.searchParams.set('redirect_uri', callbackUrl);
  googleAuthUrl.searchParams.set('response_type', 'code');
  googleAuthUrl.searchParams.set('scope', 'openid email profile');
  googleAuthUrl.searchParams.set('state', state);
  googleAuthUrl.searchParams.set('access_type', 'online');
  googleAuthUrl.searchParams.set('prompt', 'select_account');

  return Response.redirect(googleAuthUrl.toString(), 302);
}


/**
 * GET /auth/google/callback?code=...&state=<instance>
 * Exchanges the authorization code for tokens, extracts user email,
 * verifies user exists in Supabase, issues JWT session cookie,
 * and redirects to the tenant subdomain.
 */
async function handleGoogleCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(errorPage(`Google sign-in was cancelled or failed: ${error}`), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  if (!code || !state) {
    return new Response(errorPage('Invalid callback. Missing authorization code or state.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const instance = decodeURIComponent(state);
  const callbackUrl = `${url.origin}/auth/google/callback`;

  // Step 1: Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code'
    })
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('Google token exchange failed:', err);
    return new Response(errorPage('Failed to complete Google sign-in. Please try again.'), {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const tokens = await tokenRes.json();

  // Step 2: Get user info from Google
  const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` }
  });

  if (!userinfoRes.ok) {
    return new Response(errorPage('Failed to retrieve Google account info.'), {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const userinfo = await userinfoRes.json();
  const googleEmail = userinfo.email?.toLowerCase();

  if (!googleEmail) {
    return new Response(errorPage('Could not retrieve email from your Google account.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Step 3: Verify user exists in Supabase for this tenant
  const users = await supabaseGet(
    env,
    `/rest/v1/users?email=eq.${encodeURIComponent(googleEmail)}&select=id,email,tenant_id,role&limit=1`
  );

  if (!users || users.length === 0) {
    return new Response(errorPage(
      `No account found for ${googleEmail}. ` +
      'Please make sure you are using the email you registered with, or sign up first.'
    ), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const user = users[0];

  // Step 4: Look up tenant's instance URL for redirect
  // Prefer dashboard_url (tokenized — auto-authenticates in OpenClaw) over bare endpoint_url
  const instances = await supabaseGet(
    env,
    `/rest/v1/instances?tenant_id=eq.${user.tenant_id}&select=endpoint_url,dashboard_url&limit=1`
  );

  const baseDomain = env.BASE_DOMAIN || 'claw-me.com';
  const inst = instances?.[0];
  const redirectUrl = inst?.dashboard_url || inst?.endpoint_url || `https://${instance}.${baseDomain}`;

  // Step 5: Issue JWT session cookie
  const jwt = await signJwt(env.JWT_SECRET, {
    sub: user.id,
    email: user.email,
    tenant_id: user.tenant_id,
    role: user.role,
    auth_method: 'google'
  }, 7 * 24 * 60 * 60); // 7 days

  // Redirect to tenant instance with session cookie
  const response = new Response(null, {
    status: 302,
    headers: { 'Location': redirectUrl }
  });

  response.headers.set('Set-Cookie',
    `claw_session=${jwt}; ` +
    `Domain=.${baseDomain}; ` +
    `Path=/; ` +
    `HttpOnly; ` +
    `Secure; ` +
    `SameSite=Lax; ` +
    `Max-Age=${7 * 24 * 60 * 60}`
  );

  return response;
}


// ═══════════════════════════════════════════════════════════════
// PASSWORD + MFA AUTH
// ═══════════════════════════════════════════════════════════════

// ── LOGIN ──────────────────────────────────────────────────
// Verify email + password, generate MFA code, trigger email
async function handleLogin(request, env) {
  const { email, password } = await request.json();

  if (!email || !password) {
    return jsonResponse({ error: 'Email and password are required' }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Look up user by email
  const user = await supabaseGet(
    env,
    `/rest/v1/users?email=eq.${encodeURIComponent(normalizedEmail)}&select=id,email,display_name,tenant_id,password_hash,must_change_password,role&limit=1`
  );

  if (!user || user.length === 0) {
    // Don't reveal whether email exists
    return jsonResponse({ error: 'Invalid email or password' }, 401);
  }

  const u = user[0];

  if (!u.password_hash) {
    // User doesn't have a password set (Google OAuth only)
    return jsonResponse({
      error: 'This account uses Google sign-in. Please use the "Sign in with Google" option.'
    }, 401);
  }

  // Verify password via Supabase RPC (bcrypt in Postgres)
  const valid = await supabaseRpc(env, 'verify_password', {
    pwd: password,
    hashed: u.password_hash
  });

  if (!valid) {
    return jsonResponse({ error: 'Invalid email or password' }, 401);
  }

  // Clean up old MFA codes for this email
  await supabaseDelete(env, `/rest/v1/mfa_codes?email=eq.${encodeURIComponent(normalizedEmail)}`);

  // Generate 6-digit MFA code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 minutes

  // Store MFA code in Supabase
  await supabasePost(env, '/rest/v1/mfa_codes', {
    email: normalizedEmail,
    code: code,
    expires_at: expiresAt
  });

  // Trigger MFA email via n8n webhook
  if (env.N8N_MFA_WEBHOOK_URL) {
    await fetch(env.N8N_MFA_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: normalizedEmail,
        code: code,
        name: u.display_name || normalizedEmail
      })
    });
  }

  // Mask email for display: a***@example.com
  const [local, domain] = normalizedEmail.split('@');
  const masked = local[0] + '***@' + domain;

  return jsonResponse({
    mfa_required: true,
    email_masked: masked,
    must_change_password: u.must_change_password || false
  });
}


// ── VERIFY MFA ─────────────────────────────────────────────
// Check 6-digit code, issue JWT session cookie
async function handleVerifyMfa(request, env) {
  // redirect_url_override: optional field from login page when ?redirect= is set
  // (e.g. /admin). Validated against BASE_DOMAIN before use — prevents open redirect.
  const { email, code, redirect_url_override } = await request.json();

  if (!email || !code) {
    return jsonResponse({ error: 'Email and code are required' }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Look up pending MFA code
  const codes = await supabaseGet(
    env,
    `/rest/v1/mfa_codes?email=eq.${encodeURIComponent(normalizedEmail)}&used=eq.false&order=created_at.desc&limit=1`
  );

  if (!codes || codes.length === 0) {
    return jsonResponse({ error: 'No pending verification code. Please log in again.' }, 401);
  }

  const mfa = codes[0];

  // Check attempts (max 5)
  if (mfa.attempts >= 5) {
    return jsonResponse({ error: 'Too many attempts. Please log in again to get a new code.' }, 429);
  }

  // Check expiry
  if (new Date(mfa.expires_at) < new Date()) {
    return jsonResponse({ error: 'Code expired. Please log in again.' }, 401);
  }

  // Verify code
  if (mfa.code !== code.trim()) {
    // Increment attempts
    await supabasePatch(env, `/rest/v1/mfa_codes?id=eq.${mfa.id}`, {
      attempts: mfa.attempts + 1
    });
    return jsonResponse({ error: 'Invalid code. Please try again.' }, 401);
  }

  // Mark code as used
  await supabasePatch(env, `/rest/v1/mfa_codes?id=eq.${mfa.id}`, { used: true });

  // Look up user for JWT claims
  const users = await supabaseGet(
    env,
    `/rest/v1/users?email=eq.${encodeURIComponent(normalizedEmail)}&select=id,email,tenant_id,role,must_change_password&limit=1`
  );

  if (!users || users.length === 0) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  const user = users[0];

  // Look up tenant's instance URL for redirect
  // Prefer dashboard_url (tokenized — auto-authenticates in OpenClaw) over bare endpoint_url
  const instances = await supabaseGet(
    env,
    `/rest/v1/instances?tenant_id=eq.${user.tenant_id}&select=endpoint_url,dashboard_url&limit=1`
  );

  const inst = instances?.[0];
  let redirectUrl = inst?.dashboard_url || inst?.endpoint_url || `https://${baseDomain}`;

  // If the login page passed a redirect_url_override (e.g. from ?redirect=/admin),
  // use it — but ONLY if it resolves to the same BASE_DOMAIN to prevent open redirect.
  if (redirect_url_override) {
    try {
      const overrideUrl = redirect_url_override.startsWith('/')
        ? `https://${baseDomain}${redirect_url_override}`
        : redirect_url_override;
      const parsed = new URL(overrideUrl);
      if (parsed.hostname === baseDomain || parsed.hostname.endsWith(`.${baseDomain}`)) {
        redirectUrl = overrideUrl;
      }
    } catch (_) {
      // Invalid URL — ignore and use default redirect
    }
  }

  // Issue JWT
  const jwt = await signJwt(env.JWT_SECRET, {
    sub: user.id,
    email: user.email,
    tenant_id: user.tenant_id,
    role: user.role,
    auth_method: 'password'
  }, 7 * 24 * 60 * 60); // 7 days

  const baseDomain = env.BASE_DOMAIN || 'claw-me.com';

  // Set cookie on .claw-me.com domain so tenant subdomains can read it
  const response = jsonResponse({
    success: true,
    must_change_password: user.must_change_password || false,
    redirect_url: redirectUrl
  });

  response.headers.set('Set-Cookie',
    `claw_session=${jwt}; ` +
    `Domain=.${baseDomain}; ` +
    `Path=/; ` +
    `HttpOnly; ` +
    `Secure; ` +
    `SameSite=Lax; ` +
    `Max-Age=${7 * 24 * 60 * 60}`
  );

  return response;
}


// ── CHANGE PASSWORD ────────────────────────────────────────
// For first-login password change or voluntary change
async function handleChangePassword(request, env) {
  const { email, current_password, new_password } = await request.json();

  if (!email || !new_password) {
    return jsonResponse({ error: 'Email and new password are required' }, 400);
  }

  if (new_password.length < 8) {
    return jsonResponse({ error: 'Password must be at least 8 characters' }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Look up user
  const users = await supabaseGet(
    env,
    `/rest/v1/users?email=eq.${encodeURIComponent(normalizedEmail)}&select=id,password_hash,must_change_password&limit=1`
  );

  if (!users || users.length === 0) {
    return jsonResponse({ error: 'User not found' }, 404);
  }

  const user = users[0];

  // If not a forced change, verify current password
  if (!user.must_change_password && current_password) {
    const valid = await supabaseRpc(env, 'verify_password', {
      pwd: current_password,
      hashed: user.password_hash
    });
    if (!valid) {
      return jsonResponse({ error: 'Current password is incorrect' }, 401);
    }
  }

  // Hash new password via Supabase RPC (bcrypt)
  const newHash = await supabaseRpc(env, 'hash_password', { pwd: new_password });

  // Update user
  await supabasePatch(env, `/rest/v1/users?id=eq.${user.id}`, {
    password_hash: newHash,
    must_change_password: false
  });

  return jsonResponse({ success: true, message: 'Password updated successfully' });
}


// ── LOGOUT ─────────────────────────────────────────────────
function handleLogout(env) {
  const baseDomain = env.BASE_DOMAIN || 'claw-me.com';
  const response = jsonResponse({ success: true });
  response.headers.set('Set-Cookie',
    `claw_session=; Domain=.${baseDomain}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
  return response;
}


// ═══════════════════════════════════════════════════════════════
// JWT HELPERS
// ═══════════════════════════════════════════════════════════════

async function signJwt(secret, payload, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const claims = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
    iss: 'claw-me.com'
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));

  return `${signingInput}.${sigB64}`;
}

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

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}


// ═══════════════════════════════════════════════════════════════
// SUPABASE HELPERS
// ═══════════════════════════════════════════════════════════════

async function supabaseGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
  return res.json();
}

async function supabasePost(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase POST failed: ${res.status}`);
  return res.json();
}

async function supabasePatch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status}`);
}

async function supabaseDelete(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: 'DELETE',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!res.ok) throw new Error(`Supabase DELETE failed: ${res.status}`);
}

async function supabaseRpc(env, funcName, params) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${funcName}`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(params)
  });
  if (!res.ok) throw new Error(`Supabase RPC ${funcName} failed: ${res.status}`);
  return res.json();
}


// ═══════════════════════════════════════════════════════════════
// CORS & RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════

function corsResponse(env, response) {
  const origin = env.ALLOWED_ORIGIN || 'https://claw-me.com';
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  return response;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Branded error page matching claw-me.com theme
 */
function errorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign-in Error — claw-me.com</title>
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
    <h1>Sign-in Error</h1>
    <p>${message}</p>
    <a href="https://claw-me.com/login">Back to Sign In</a>
  </div>
</body>
</html>`;
}
