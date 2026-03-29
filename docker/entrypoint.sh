#!/bin/bash
# claw-me.com — OpenClaw tenant container entrypoint (v30)
#
# Clean rewrite — no MITM proxy, no cert tricks.
#
# LiteLLM metering:
#   openclaw.json is written with baseUrl = LiteLLM internal URL and
#   apiKey = LITELLM_VIRTUAL_KEY.  paste-token is SKIPPED in LiteLLM mode
#   so it cannot write auth-profiles.json and override the baseUrl.
#   openclaw (v2026.3.24+) respects the baseUrl in openclaw.json.
#
# v29 key-creation:
#   Lambda cannot reach litellm.claw-me.com (Cloudflare blocks non-browser
#   traffic), so LITELLM_VIRTUAL_KEY is always empty after Lambda runs.
#   Fix: container is already in the VPC, so it calls the LiteLLM internal
#   URL directly at startup to create its own per-tenant virtual key.
#   Requires LITELLM_MASTER_KEY env var (passed via ECS task definition).
#
# Direct mode (no LITELLM_VIRTUAL_KEY and key creation fails):
#   openclaw.json gets no baseUrl — calls go straight to api.openai.com.
#   paste-token runs normally to register the API key.
#
# All channels are enabled:true with empty tokens — tenants configure via dashboard.
set -e

echo "🦞 claw-me.com — Starting OpenClaw for tenant: ${TENANT_ID:-unknown}"
openclaw --version 2>&1 | head -1 || true

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
  _SM_OPENAI=$(echo "$SECRET_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('openaiApiKey',''))" 2>/dev/null || echo "")
  _SM_ANTHROPIC=$(echo "$SECRET_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('anthropicApiKey',''))" 2>/dev/null || echo "")
  # In LiteLLM mode, keep OPENAI_API_KEY = virtual key from Lambda (don't overwrite)
  [ -z "$LITELLM_VIRTUAL_KEY" ] && [ -n "$_SM_OPENAI" ] && export OPENAI_API_KEY="$_SM_OPENAI"
  [ -n "$_SM_ANTHROPIC" ] && export ANTHROPIC_API_KEY="$_SM_ANTHROPIC"
fi

# ── Auto-create LiteLLM virtual key (container is in VPC, can reach internal URL) ──
# Lambda cannot create virtual keys via the public litellm.claw-me.com because
# Cloudflare blocks non-browser traffic.  The ECS container is in the VPC and
# can reach litellm.claw-me.local:4000 directly, so we create the key here.
#
# LITELLM_MASTER_KEY is injected as a static env var from the ECS task definition
# (set in the --container-definitions JSON in deploy-v27.sh and later scripts).
_LITELLM_INTERNAL="${LITELLM_INTERNAL_URL:-http://litellm.claw-me.local:4000}"

if [ -z "$LITELLM_VIRTUAL_KEY" ] && [ -n "$LITELLM_MASTER_KEY" ] && [ -n "$TENANT_ID" ]; then
  _KEY_ALIAS="tenant-${TENANT_ID}"
  echo "=== Auto-creating LiteLLM virtual key for ${_KEY_ALIAS} ==="

  _KEY_BODY="{\"key_alias\":\"${_KEY_ALIAS}\",\"metadata\":{\"tenant_id\":\"${TENANT_ID}\"},\"models\":[\"gpt-4.1-mini\",\"gpt-4.1\",\"openai/gpt-4.1-mini\",\"openai/gpt-4.1\"],\"max_budget\":10,\"budget_duration\":\"monthly\"}"

  _KEY_RES=$(curl -s --max-time 10 -X POST "${_LITELLM_INTERNAL}/key/generate" \
    -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
    -H "Content-Type: application/json" \
    -d "$_KEY_BODY" 2>/dev/null || echo "{}")

  _LITELLM_NEW_KEY=$(echo "$_KEY_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('key',''))" 2>/dev/null || echo "")

  # If alias already exists (from a previous provision), delete old keys and retry
  _HAS_EXISTS=$(echo "$_KEY_RES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
err=str(d.get('error',d.get('detail','')))
print('yes' if 'already exists' in err or 'already_exists' in err else '')
" 2>/dev/null || echo "")

  if [ -z "$_LITELLM_NEW_KEY" ] && [ -n "$_HAS_EXISTS" ]; then
    echo "Key alias ${_KEY_ALIAS} already exists — deleting and recreating"

    # List existing keys by alias
    _LIST_RES=$(curl -s --max-time 10 "${_LITELLM_INTERNAL}/key/list?key_alias=${_KEY_ALIAS}" \
      -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" 2>/dev/null || echo "{}")
    _KEY_IDS=$(echo "$_LIST_RES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
keys=d.get('keys',[])
print(json.dumps({'keys':keys}))
" 2>/dev/null || echo "{\"keys\":[]}")

    # Delete old keys
    curl -s --max-time 10 -X POST "${_LITELLM_INTERNAL}/key/delete" \
      -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
      -H "Content-Type: application/json" \
      -d "$_KEY_IDS" > /dev/null 2>&1 && echo "Deleted old LiteLLM keys" || echo "Warning: key delete failed"

    # Retry creation
    _KEY_RES=$(curl -s --max-time 10 -X POST "${_LITELLM_INTERNAL}/key/generate" \
      -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
      -H "Content-Type: application/json" \
      -d "$_KEY_BODY" 2>/dev/null || echo "{}")
    _LITELLM_NEW_KEY=$(echo "$_KEY_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('key',''))" 2>/dev/null || echo "")
  fi

  if [ -n "$_LITELLM_NEW_KEY" ]; then
    export LITELLM_VIRTUAL_KEY="$_LITELLM_NEW_KEY"
    export OPENAI_API_BASE="$_LITELLM_INTERNAL"
    # OpenClaw uses OPENAI_API_KEY env var as the Authorization header — it does NOT
    # read apiKey from openclaw.json providers config.  Override it here so that
    # LiteLLM receives the virtual key (not the real OpenAI key) and can meter correctly.
    export OPENAI_API_KEY="$LITELLM_VIRTUAL_KEY"
    echo "LiteLLM virtual key created: ${LITELLM_VIRTUAL_KEY:0:12}...  base=${OPENAI_API_BASE}"

    # Store virtual key in Supabase for observability (optional, non-fatal)
    if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_KEY" ] && [ -n "$TENANT_ID" ]; then
      curl -s -X PATCH \
        "${SUPABASE_URL}/rest/v1/instances?tenant_id=eq.${TENANT_ID}" \
        -H "apikey: ${SUPABASE_SERVICE_KEY}" \
        -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"litellm_virtual_key\": \"${LITELLM_VIRTUAL_KEY}\"}" \
        > /dev/null 2>&1 || true
    fi
  else
    echo "Warning: LiteLLM key creation failed. Container will run in direct OpenAI mode."
    echo "LiteLLM response: $_KEY_RES"
  fi
elif [ -n "$LITELLM_VIRTUAL_KEY" ]; then
  echo "LiteLLM virtual key provided by Lambda: ${LITELLM_VIRTUAL_KEY:0:12}..."
  # Ensure OPENAI_API_BASE is set if virtual key was provided
  if [ -z "$OPENAI_API_BASE" ]; then
    export OPENAI_API_BASE="$_LITELLM_INTERNAL"
    echo "OPENAI_API_BASE defaulted to: ${OPENAI_API_BASE}"
  fi
  # Same as auto-create path: override OPENAI_API_KEY so OpenClaw sends the
  # virtual key (not the real OpenAI key) as the Authorization header to LiteLLM.
  export OPENAI_API_KEY="$LITELLM_VIRTUAL_KEY"
  echo "OPENAI_API_KEY overridden with virtual key for LiteLLM auth"
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

# ── Use HTTPS endpoint from Lambda if provided ──
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

# ── Write openclaw.json ──
#
# LiteLLM mode  (LITELLM_VIRTUAL_KEY is set):
#   baseUrl = LiteLLM internal URL, apiKey = virtual key.
#   paste-token is NOT run — skipping it prevents auth-profiles.json from
#   being written with api.openai.com as the endpoint, which would override
#   the baseUrl set here.
#
# Direct mode  (no LITELLM_VIRTUAL_KEY):
#   No baseUrl — calls go straight to api.openai.com.
#   paste-token runs to register the real API key in auth-profiles.json.
#
if [ -n "$LITELLM_VIRTUAL_KEY" ] && [ -n "$OPENAI_API_BASE" ]; then
  echo "=== LiteLLM mode: writing openclaw.json with LiteLLM baseUrl ==="
  python3 -c "
import json, os
virtual_key   = os.environ.get('LITELLM_VIRTUAL_KEY', '')
base_url      = os.environ.get('OPENAI_API_BASE', '').rstrip('/') + '/v1'
gateway_token = os.environ.get('OPENCLAW_GATEWAY_TOKEN', '')
models = [
  {'id': 'gpt-4.1-mini', 'name': 'GPT-4.1 Mini', 'contextWindow': 128000, 'maxTokens': 16384},
  {'id': 'gpt-4.1',      'name': 'GPT-4.1',       'contextWindow': 1000000, 'maxTokens': 32768},
]
config = {
  'gateway': {
    'bind': 'lan', 'mode': 'local', 'port': 18789,
    'auth': {'mode': 'trusted-proxy', 'trustedProxy': {'userHeader': 'X-Forwarded-User'}},
    'trustedProxies': ['0.0.0.0/0'],
    'controlUi': {'allowedOrigins': ['*']}
  },
  'models': {
    'providers': {
      'openai': {'baseUrl': base_url, 'apiKey': virtual_key, 'models': models}
    }
  },
  'agents': {
    'defaults': {
      'workspace': '/root/.openclaw/workspace',
      'model': {'primary': 'openai/gpt-4.1-mini'},
      'models': {'openai/gpt-4.1-mini': {'alias': 'GPT-4.1 Mini'}, 'openai/gpt-4.1': {'alias': 'GPT-4.1'}}
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
print('LiteLLM config written: baseUrl=' + base_url + '  apiKey=...' + virtual_key[-6:])
"

else
  echo "=== Direct mode: writing openclaw.json for direct OpenAI/Anthropic ==="
  python3 -c "
import json, os
openai_key    = os.environ.get('OPENAI_API_KEY', '')
anthropic_key = os.environ.get('ANTHROPIC_API_KEY', '')
gateway_token = os.environ.get('OPENCLAW_GATEWAY_TOKEN', '')
providers = {}
if openai_key:
  providers['openai'] = {
    'apiKey': openai_key,
    'models': [
      {'id': 'gpt-4.1-mini', 'name': 'GPT-4.1 Mini', 'contextWindow': 128000, 'maxTokens': 16384},
      {'id': 'gpt-4.1',      'name': 'GPT-4.1',       'contextWindow': 1000000, 'maxTokens': 32768}
    ]
  }
if anthropic_key:
  providers['anthropic'] = {
    'apiKey': anthropic_key,
    'models': [{'id': 'claude-sonnet-4-6', 'name': 'Claude Sonnet', 'contextWindow': 200000, 'maxTokens': 8096}]
  }
primary_model = 'openai/gpt-4.1-mini' if openai_key else 'anthropic/claude-sonnet-4-6'
config = {
  'gateway': {
    'bind': 'lan', 'mode': 'local', 'port': 18789,
    'auth': {'mode': 'trusted-proxy', 'trustedProxy': {'userHeader': 'X-Forwarded-User'}},
    'trustedProxies': ['0.0.0.0/0'],
    'controlUi': {'allowedOrigins': ['*']}
  },
  'models': {'providers': providers},
  'agents': {
    'defaults': {
      'workspace': '/root/.openclaw/workspace',
      'model': {'primary': primary_model},
      'models': {primary_model: {'alias': 'Primary'}}
    }
  },
  'channels': {
    'telegram': {'enabled': True, 'botToken': '', 'dmPolicy': 'pairing', 'groupPolicy': 'open'},
    'whatsapp': {'enabled': True, 'dmPolicy': 'pairing', 'groupPolicy': 'open'},
    'discord':  {'enabled': True, 'token': '', 'dmPolicy': 'pairing', 'groupPolicy': 'open'},
    'slack':    {'enabled': True, 'mode': 'socket', 'appToken': '', 'botToken': '', 'dmPolicy': 'pairing'}
  }
}
if providers:
  config['models'] = {'providers': providers}
with open('/root/.openclaw/openclaw.json', 'w') as f:
  json.dump(config, f, indent=2)
print('Direct config written')
"

  # paste-token only in direct mode — in LiteLLM mode we skip it so that
  # auth-profiles.json is never written with api.openai.com as the endpoint.
  mkdir -p /root/.openclaw/agents/main/agent

  if [ -n "$OPENAI_API_KEY" ]; then
    echo "=== Configuring OpenAI auth (direct mode) ==="
    echo "$OPENAI_API_KEY" | openclaw models auth paste-token --provider openai 2>&1 || \
      echo "Warning: OpenAI auth setup failed"
  fi

  if [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "=== Configuring Anthropic auth (direct mode) ==="
    echo "$ANTHROPIC_API_KEY" | openclaw models auth paste-token --provider anthropic 2>&1 || \
      echo "Warning: Anthropic auth setup failed"
  fi
fi

echo "=== openclaw.json at startup ==="
cat ~/.openclaw/openclaw.json
echo "=== end config ==="

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

# ── Build tokenized dashboard URL from known gateway token ──
# We construct the URL directly from OPENCLAW_GATEWAY_TOKEN (which is also
# written into openclaw.json gateway.auth.token) instead of running
# "openclaw dashboard --no-open", which could generate its own independent
# token that doesn't match what the gateway will actually use.
echo "=== Building tokenized dashboard URL ==="
if [ -n "$HTTPS_ENDPOINT" ] && [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
  TOKENIZED_URL="${HTTPS_ENDPOINT}/#token=${OPENCLAW_GATEWAY_TOKEN}"
  echo "Tokenized dashboard URL: ${TOKENIZED_URL}"

  if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_KEY" ] && [ -n "$TENANT_ID" ]; then
    curl -s -X PATCH \
      "${SUPABASE_URL}/rest/v1/instances?tenant_id=eq.${TENANT_ID}" \
      -H "apikey: ${SUPABASE_SERVICE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"dashboard_url\": \"${TOKENIZED_URL}\", \"gateway_token\": \"${OPENCLAW_GATEWAY_TOKEN}\"}" \
      > /dev/null 2>&1 && echo "Stored dashboard URL + token in Supabase" || echo "Warning: could not store dashboard URL"
  fi
else
  echo "Warning: HTTPS_ENDPOINT or OPENCLAW_GATEWAY_TOKEN not set — skipping dashboard URL storage"
fi

echo "Starting OpenClaw gateway on port ${GATEWAY_PORT:-18789}"
exec openclaw gateway --port ${GATEWAY_PORT:-18789}
