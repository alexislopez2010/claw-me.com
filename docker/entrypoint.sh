#!/bin/bash
# claw-me.com — OpenClaw tenant container entrypoint (v15)
#
# This script runs at container startup and:
#   1. Pulls tenant config from AWS Secrets Manager
#   2. Preserves Lambda-injected env vars (OPENAI_API_KEY, OPENAI_API_BASE)
#   3. Generates gateway token, registers with ALB target group
#   4. Writes openclaw.json with 4-channel support (Telegram, WhatsApp, Discord, Slack)
#   5. Configures model auth via paste-token (BEFORE gateway starts)
#   6. Generates tokenized dashboard URL → stores in Supabase
#   7. Starts OpenClaw gateway on port 18789
#
# Two config paths:
#   - LiteLLM path: when OPENAI_API_BASE is set (includes models.providers.openai config)
#   - Direct path: when no LiteLLM proxy (no models section, uses default provider)
#
# All channels are enabled:true with empty tokens — tenants configure from dashboard.
# IMPORTANT: channels with enabled:false flash then disappear on the dashboard page.
set -e

echo "🦞 claw-me.com — Starting OpenClaw for tenant: ${TENANT_ID:-unknown}"

# ── Pull secrets from AWS Secrets Manager ──
if [ -n "$SECRET_NAME" ] && [ -n "$AWS_DEFAULT_REGION" ]; then
  echo "Pulling config from Secrets Manager: $SECRET_NAME"
  SECRET_JSON=$(aws secretsmanager get-secret-value \
    --secret-id "$SECRET_NAME" \
    --region "$AWS_DEFAULT_REGION" \
    --query SecretString \
    --output text 2>/dev/null || echo "{}")

  export OPENCLAW_GATEWAY_TOKEN=$(echo "$SECRET_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('gatewayToken',''))" 2>/dev/null || echo "")
  export TELEGRAM_BOT_TOKEN=$(echo "$SECRET_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('telegramBotToken',''))" 2>/dev/null || echo "")
  # Only override API keys from Secrets Manager if LiteLLM is NOT active.
  # When OPENAI_API_BASE is set, the Lambda injected a LiteLLM virtual key
  # as OPENAI_API_KEY — don't overwrite it with the raw provider key.
  if [ -z "$OPENAI_API_BASE" ]; then
    _SM_OPENAI=$(echo "$SECRET_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('openaiApiKey',''))" 2>/dev/null || echo "")
    _SM_ANTHROPIC=$(echo "$SECRET_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('anthropicApiKey',''))" 2>/dev/null || echo "")
    [ -n "$_SM_OPENAI" ]    && export OPENAI_API_KEY="$_SM_OPENAI"
    [ -n "$_SM_ANTHROPIC" ] && export ANTHROPIC_API_KEY="$_SM_ANTHROPIC"
  else
    echo "LiteLLM active (OPENAI_API_BASE=${OPENAI_API_BASE}) — using virtual key, skipping Secrets Manager API keys"
  fi
fi

# ── Generate gateway token if not provided ──
if [ -z "$OPENCLAW_GATEWAY_TOKEN" ]; then
  OPENCLAW_GATEWAY_TOKEN=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 48 | head -n 1)
  echo "Generated new gateway token"
fi

# ── Get container private IP for ALB registration ──
PRIVATE_IP=$(curl -s --max-time 5 "${ECS_CONTAINER_METADATA_URI_V4}/task" 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Containers'][0]['Networks'][0]['IPv4Addresses'][0])" 2>/dev/null \
  || hostname -I | awk '{print $1}')
echo "Private IP: ${PRIVATE_IP:-unknown}"

# ── Use HTTPS endpoint from Lambda if provided, else fall back to public IP ──
if [ -n "$HTTPS_ENDPOINT" ]; then
  GATEWAY_ENDPOINT="$HTTPS_ENDPOINT"
else
  PUBLIC_IP=$(curl -s --max-time 5 https://checkip.amazonaws.com || echo "")
  GATEWAY_ENDPOINT="http://${PUBLIC_IP}:${GATEWAY_PORT:-18789}"
fi
echo "Gateway endpoint: $GATEWAY_ENDPOINT"

# ── Register container with ALB target group ──
if [ -n "$TARGET_GROUP_ARN" ] && [ -n "$PRIVATE_IP" ] && [ -n "$AWS_DEFAULT_REGION" ]; then
  aws elbv2 register-targets \
    --target-group-arn "$TARGET_GROUP_ARN" \
    --targets "Id=${PRIVATE_IP},Port=${GATEWAY_PORT:-18789}" \
    --region "$AWS_DEFAULT_REGION" \
    > /dev/null 2>&1 && echo "Registered with ALB target group" || echo "Warning: could not register with ALB"
fi

# ── Store gateway token + endpoint back to Secrets Manager ──
if [ -n "$SECRET_NAME" ] && [ -n "$AWS_DEFAULT_REGION" ]; then
  UPDATED_SECRET=$(echo "$SECRET_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
d['gatewayToken']    = '${OPENCLAW_GATEWAY_TOKEN}'
d['gatewayEndpoint'] = '${GATEWAY_ENDPOINT}'
d['privateIp']       = '${PRIVATE_IP}'
print(json.dumps(d))
" 2>/dev/null || echo "{}")

  aws secretsmanager update-secret \
    --secret-id "$SECRET_NAME" \
    --secret-string "$UPDATED_SECRET" \
    --region "$AWS_DEFAULT_REGION" \
    > /dev/null 2>&1 && echo "Stored gateway token in Secrets Manager" || echo "Warning: could not update secret"
fi

# ── Update Supabase instance with HTTPS endpoint + gateway token ──
if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_KEY" ] && [ -n "$TENANT_ID" ]; then
  SUPABASE_PAYLOAD="{\"endpoint_url\": \"${GATEWAY_ENDPOINT}\", \"gateway_token\": \"${OPENCLAW_GATEWAY_TOKEN}\"}"
  curl -s -X PATCH \
    "${SUPABASE_URL}/rest/v1/instances?tenant_id=eq.${TENANT_ID}" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
    -H "Content-Type: application/json" \
    -d "$SUPABASE_PAYLOAD" \
    > /dev/null 2>&1 && echo "Updated endpoint + token in Supabase" || echo "Warning: could not update Supabase"
fi

# ── Write openclaw.json config using Python (avoids sed escaping issues) ──
if [ -n "$OPENAI_API_BASE" ] && [ -n "$OPENAI_API_KEY" ]; then
  echo "Configuring OpenClaw with LiteLLM proxy at ${OPENAI_API_BASE}"
  python3 -c "
import json, os
base_url = os.environ.get('OPENAI_API_BASE', '')
api_key  = os.environ.get('OPENAI_API_KEY', '')
config = {
  'gateway': {
    'bind': 'lan', 'mode': 'local', 'port': 18789,
    'auth': {'mode': 'trusted-proxy', 'trustedProxy': {'userHeader': 'Cf-Access-Authenticated-User-Email'}},
    'trustedProxies': ['127.0.0.1/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    'controlUi': {'allowedOrigins': ['*']}
  },
  'models': {
    'providers': {
      'openai': {
        'baseUrl': base_url + '/v1',
        'apiKey': api_key,
        'models': [
          {'id': 'gpt-4.1-mini', 'name': 'GPT-4.1 Mini', 'contextWindow': 128000, 'maxTokens': 16384},
          {'id': 'gpt-4.1', 'name': 'GPT-4.1', 'contextWindow': 1000000, 'maxTokens': 32768}
        ]
      }
    }
  },
  'agents': {
    'defaults': {
      'workspace': '/root/.openclaw/workspace',
      'model': {'primary': 'openai/gpt-4.1-mini'},
      'models': {'openai/gpt-4.1-mini': {'alias': 'Primary'}}
    }
  },
  'channels': {
    'telegram': {'enabled': True, 'botToken': '', 'dmPolicy': 'pairing', 'groupPolicy': 'open'},
    'whatsapp': {'enabled': True, 'dmPolicy': 'pairing', 'groupPolicy': 'open'},
    'discord':  {'enabled': True, 'token': '', 'dmPolicy': 'pairing', 'groupPolicy': 'open'},
    'slack':    {'enabled': True, 'mode': 'socket', 'appToken': '', 'botToken': '', 'dmPolicy': 'pairing'}
  }
}
with open('/root/.openclaw/openclaw.json', 'w') as f:
  json.dump(config, f, indent=2)
"
else
  echo "Configuring OpenClaw with direct OpenAI provider"
  python3 -c "
import json
config = {
  'gateway': {
    'bind': 'lan', 'mode': 'local', 'port': 18789,
    'auth': {'mode': 'trusted-proxy', 'trustedProxy': {'userHeader': 'Cf-Access-Authenticated-User-Email'}},
    'trustedProxies': ['127.0.0.1/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    'controlUi': {'allowedOrigins': ['*']}
  },
  'agents': {
    'defaults': {
      'workspace': '/root/.openclaw/workspace',
      'model': {'primary': 'openai/gpt-4.1-mini'},
      'models': {'openai/gpt-4.1-mini': {'alias': 'Primary'}}
    }
  },
  'channels': {
    'telegram': {'enabled': True, 'botToken': '', 'dmPolicy': 'pairing', 'groupPolicy': 'open'},
    'whatsapp': {'enabled': True, 'dmPolicy': 'pairing', 'groupPolicy': 'open'},
    'discord':  {'enabled': True, 'token': '', 'dmPolicy': 'pairing', 'groupPolicy': 'open'},
    'slack':    {'enabled': True, 'mode': 'socket', 'appToken': '', 'botToken': '', 'dmPolicy': 'pairing'}
  }
}
with open('/root/.openclaw/openclaw.json', 'w') as f:
  json.dump(config, f, indent=2)
"
fi

echo "Config written to ~/.openclaw/openclaw.json"
echo "=== openclaw.json at startup ==="
cat ~/.openclaw/openclaw.json
echo "=== end config ==="

# ── Configure model auth (must run BEFORE gateway starts) ──
# openclaw models auth paste-token writes to auth-profiles.json.
# Running it while the gateway is live triggers a config-change restart — so we do it here.
mkdir -p /root/.openclaw/agents/main/agent

if [ -n "$OPENAI_API_KEY" ]; then
  # Direct mode: register with openai provider
  echo "=== Configuring OpenAI auth ==="
  echo "$OPENAI_API_KEY" | openclaw models auth paste-token --provider openai 2>&1 || \
    echo "Warning: OpenAI auth setup failed (will retry on next reprovision)"
fi

if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "=== Configuring Anthropic auth ==="
  echo "$ANTHROPIC_API_KEY" | openclaw models auth paste-token --provider anthropic 2>&1 || \
    echo "Warning: Anthropic auth setup failed"
fi

# ── Fetch tenant owner email(s) for container-level auth check ──
TENANT_OWNER_EMAILS=""
if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_KEY" ] && [ -n "$TENANT_ID" ]; then
  echo "Fetching tenant owner emails from Supabase..."
  TENANT_OWNER_EMAILS=$(curl -s \
    "${SUPABASE_URL}/rest/v1/users?tenant_id=eq.${TENANT_ID}&role=in.(owner,member)&select=email" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
    | python3 -c "import sys,json; emails=json.load(sys.stdin); print(','.join(e['email'] for e in emails))" 2>/dev/null || echo "")
  echo "Authorized emails: ${TENANT_OWNER_EMAILS:-none found}"
fi
export TENANT_OWNER_EMAILS

echo "Starting OpenClaw gateway on port ${GATEWAY_PORT:-18789}..."

# ── Generate tokenized dashboard URL (before gateway starts) ──
# Run before exec so no gateway is running yet — avoids triggering a restart.
# The tokenized URL embeds a device credential that bypasses pairing entirely.
echo "=== Generating tokenized dashboard URL ==="
DASHBOARD_OUTPUT=$(openclaw dashboard --no-open 2>&1 || true)
echo "$DASHBOARD_OUTPUT"
echo "=== end dashboard output ==="

# Extract URL and replace localhost with tenant HTTPS endpoint
DASHBOARD_URL=$(echo "$DASHBOARD_OUTPUT" | grep -oE 'https?://[^ ]+' | head -1 || true)
if [ -n "$DASHBOARD_URL" ] && [ -n "$HTTPS_ENDPOINT" ]; then
  # Replace http://localhost:PORT with the tenant HTTPS URL
  TOKENIZED_URL=$(echo "$DASHBOARD_URL" | sed "s|http://localhost:[0-9]*|${HTTPS_ENDPOINT}|g" | sed "s|https://localhost:[0-9]*|${HTTPS_ENDPOINT}|g" | sed "s|http://127.0.0.1:[0-9]*|${HTTPS_ENDPOINT}|g" | sed "s|https://127.0.0.1:[0-9]*|${HTTPS_ENDPOINT}|g")
  echo "Tokenized dashboard URL: ${TOKENIZED_URL}"

  # Store in Supabase
  if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_KEY" ] && [ -n "$TENANT_ID" ]; then
    curl -s -X PATCH \
      "${SUPABASE_URL}/rest/v1/instances?tenant_id=eq.${TENANT_ID}" \
      -H "apikey: ${SUPABASE_SERVICE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"dashboard_url\": \"${TOKENIZED_URL}\"}" \
      > /dev/null 2>&1 && echo "Stored dashboard URL in Supabase" || echo "Warning: could not store dashboard URL"
  fi
fi

# NOTE: Do NOT run any `openclaw` CLI commands while the gateway is running.
# Invoking the CLI modifies gateway.auth.token in the config which triggers
# a full process restart, wiping all device state.

# ── Start gateway with auth proxy ──
# If owner emails are configured, run the auth proxy on the public port
# and OpenClaw on an internal port. Otherwise, run OpenClaw directly.
if [ -n "$TENANT_OWNER_EMAILS" ]; then
  export OPENCLAW_PORT=18790
  echo "Starting auth proxy on port ${GATEWAY_PORT:-18789} → OpenClaw on port ${OPENCLAW_PORT}"
  python3 /auth-proxy.py &
  AUTH_PROXY_PID=$!
  # Give proxy a moment to bind
  sleep 1
  exec openclaw gateway --port ${OPENCLAW_PORT}
else
  echo "No owner emails configured — running OpenClaw directly (no auth proxy)"
  exec openclaw gateway --port ${GATEWAY_PORT:-18789}
fi
