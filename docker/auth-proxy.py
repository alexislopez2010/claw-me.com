#!/usr/bin/env python3
"""
claw-me.com — Tenant Auth Proxy (container-level defense)

Lightweight HTTP reverse proxy that validates the Cf-Access-Authenticated-User-Email
header against the TENANT_OWNER_EMAILS env var before forwarding to OpenClaw gateway.

This is the second layer of defense (after the Cloudflare Worker edge check).
If the Worker is bypassed or misconfigured, this proxy blocks unauthorized access.

Usage:
  TENANT_OWNER_EMAILS="alice@gmail.com,bob@gmail.com" \
  OPENCLAW_PORT=18790 \
  python3 auth-proxy.py

Listens on: port from GATEWAY_PORT env var (default 18789)
Forwards to: localhost:OPENCLAW_PORT (default 18790)
"""

import http.server
import http.client
import os
import sys
import json

LISTEN_PORT = int(os.environ.get('GATEWAY_PORT', '18789'))
BACKEND_PORT = int(os.environ.get('OPENCLAW_PORT', '18790'))
ALLOWED_EMAILS = set(
    e.strip().lower()
    for e in os.environ.get('TENANT_OWNER_EMAILS', '').split(',')
    if e.strip()
)

# Health check paths that don't require email auth
HEALTH_PATHS = {'/health', '/healthz', '/ready', '/api/health'}

FORBIDDEN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Access Denied — claw-me.com</title>
  <style>
    body {{
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0d0f14; color: #e8eaf0;
      font-family: 'Inter', system-ui, sans-serif; margin: 0;
    }}
    .card {{
      background: #13161e; border: 1px solid #252a38;
      border-radius: 16px; padding: 48px 40px;
      max-width: 440px; text-align: center;
    }}
    .icon {{ font-size: 3rem; margin-bottom: 16px; }}
    h1 {{ font-size: 1.4rem; font-weight: 800; margin-bottom: 12px; }}
    p {{ color: #8891a8; font-size: 0.92rem; line-height: 1.6; margin-bottom: 24px; }}
    a {{
      display: inline-block; background: #ff4c29; color: #fff;
      border-radius: 8px; padding: 10px 24px;
      font-size: 0.88rem; font-weight: 700; text-decoration: none;
    }}
    a:hover {{ background: #ff7a52; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🦞</div>
    <h1>Access Denied</h1>
    <p>{message}</p>
    <a href="https://claw-me.com">Back to claw-me.com</a>
  </div>
</body>
</html>"""


class AuthProxyHandler(http.server.BaseHTTPRequestHandler):
    """Validates email header, then proxies to OpenClaw backend."""

    def do_request(self):
        # Health check endpoints pass through without email validation
        if self.path in HEALTH_PATHS:
            self.proxy_request()
            return

        # If no owner emails configured, pass through (fail open for initial setup)
        if not ALLOWED_EMAILS:
            self.proxy_request()
            return

        # Check the Cf-Access-Authenticated-User-Email header
        email = self.headers.get('Cf-Access-Authenticated-User-Email', '').strip().lower()

        if not email:
            self.send_forbidden('Authentication required. Please sign in through claw-me.com.')
            return

        if email not in ALLOWED_EMAILS:
            self.send_forbidden(
                f'Your account ({email}) does not have access to this instance. '
                'Contact the instance owner if you believe this is an error.'
            )
            return

        # Authorized — proxy to OpenClaw
        self.proxy_request()

    def proxy_request(self):
        """Forward the request to the OpenClaw backend."""
        try:
            conn = http.client.HTTPConnection('127.0.0.1', BACKEND_PORT, timeout=30)

            # Read request body if present
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length > 0 else None

            # Forward all headers
            headers = {}
            for key, value in self.headers.items():
                if key.lower() not in ('host', 'transfer-encoding'):
                    headers[key] = value

            conn.request(self.command, self.path, body=body, headers=headers)
            response = conn.getresponse()

            # Send response back
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ('transfer-encoding',):
                    self.send_header(key, value)
            self.end_headers()

            # Stream response body
            while True:
                chunk = response.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)

            conn.close()
        except Exception as e:
            self.send_error(502, f'Backend unavailable: {e}')

    def send_forbidden(self, message):
        self.send_response(403)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(FORBIDDEN_HTML.format(message=message).encode('utf-8'))

    # Handle all HTTP methods
    do_GET = do_request
    do_POST = do_request
    do_PUT = do_request
    do_DELETE = do_request
    do_PATCH = do_request
    do_OPTIONS = do_request
    do_HEAD = do_request

    def log_message(self, format, *args):
        email = self.headers.get('Cf-Access-Authenticated-User-Email', '-') if hasattr(self, 'headers') else '-'
        sys.stderr.write(f"[auth-proxy] {email} {format % args}\n")


if __name__ == '__main__':
    print(f"[auth-proxy] Starting on port {LISTEN_PORT}, forwarding to localhost:{BACKEND_PORT}")
    print(f"[auth-proxy] Allowed emails: {ALLOWED_EMAILS or 'ALL (no restriction configured)'}")

    server = http.server.HTTPServer(('0.0.0.0', LISTEN_PORT), AuthProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()
