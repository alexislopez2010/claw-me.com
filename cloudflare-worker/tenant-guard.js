/**
 * claw-me.com — Tenant Guard Worker
 *
 * Cloudflare Worker that enforces tenant ownership at the edge.
 * Runs on *.claw-me.com AFTER Cloudflare Access authentication.
 *
 * Flow:
 *   1. Extract subdomain from Host header (e.g., tenant-abc123 from tenant-abc123.claw-me.com)
 *   2. Read authenticated email from Cf-Access-Authenticated-User-Email header
 *   3. Look up tenant owner in Supabase: instances → tenant_id → users (role='owner')
 *   4. If email matches owner → pass through to origin
 *   5. If not → return 403
 *
 * Environment variables (set in Cloudflare dashboard or wrangler.toml):
 *   SUPABASE_URL         - e.g., https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY - service role key (secret)
 *   BASE_DOMAIN          - claw-me.com
 *
 * Deploy:
 *   wrangler deploy --name tenant-guard
 *   Then add route: *.claw-me.com/* → tenant-guard
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

    // Skip non-tenant subdomains (admin, litellm, etc.)
    const SKIP_SUBDOMAINS = ['admin', 'www', 'litellm', 'api'];
    if (SKIP_SUBDOMAINS.includes(subdomain)) {
      return fetch(request);
    }

    // Get the authenticated user email from Cloudflare Access
    const authedEmail = request.headers.get('Cf-Access-Authenticated-User-Email');
    if (!authedEmail) {
      // No Cloudflare Access header — this shouldn't happen if Access is configured,
      // but block it just in case
      return new Response(forbidden('Authentication required'), {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Look up tenant ownership in Supabase
    try {
      const isOwner = await checkTenantOwnership(
        env.SUPABASE_URL,
        env.SUPABASE_SERVICE_KEY,
        subdomain,
        baseDomain,
        authedEmail
      );

      if (!isOwner) {
        return new Response(forbidden('You do not have access to this instance'), {
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
    return fetch(request);
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
    <a href="https://claw-me.com">Back to claw-me.com</a>
  </div>
</body>
</html>`;
}
