#!/bin/bash
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
  export OPENAI_API_KEY=$(echo "$SECRET_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('openaiApiKey',''))" 2>/dev/null || echo "")
  export ANTHROPIC_API_KEY=$(echo "$SECRET_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('anthropicApiKey',''))" 2>/dev/null || echo "")
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

# ── Write openclaw.json config ──
mkdir -p ~/.openclaw/workspace ~/.openclaw/logs

cat > ~/.openclaw/openclaw.json << EOF
{
  "gateway": {
    "bind": "lan",
    "mode": "local",
    "port": ${GATEWAY_PORT:-18789},
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "controlUi": {
      "allowedOrigins": ["*"]
    }
  },
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "model": {
        "primary": "${MODEL_PRIMARY:-openai/gpt-4.1-mini}"
      },
      "models": {
        "${MODEL_PRIMARY:-openai/gpt-4.1-mini}": { "alias": "Primary" }
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": ${TELEGRAM_ENABLED:-false},
      "botToken": "${TELEGRAM_BOT_TOKEN:-}",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "groups": {
        "*": { "requireMention": true }
      }
    }
  }
}
EOF

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  echo "Telegram channel: enabled"
else
  echo "Telegram channel: disabled (no bot token)"
fi

echo "Config written to ~/.openclaw/openclaw.json"
echo "Starting OpenClaw gateway on port ${GATEWAY_PORT:-18789}..."

# ── Start gateway ──
exec openclaw gateway --port ${GATEWAY_PORT:-18789}
