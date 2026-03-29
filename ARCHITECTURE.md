# claw-me.com — Architecture & Deployment Guide

> **Status:** Production-ready infrastructure deployed in `us-east-1`.
> Last updated: March 25, 2026 — v15 image + S3 wrapper entrypoint (task def :55), LiteLLM metering working end-to-end (virtual keys via public URL, VPC-internal traffic), direct-key fallback fixed (no paste-token dependency), dual-layer tenant security, claw-auth Worker, tokenized dashboard login flow

---

## Table of Contents

1. [System Overview](#system-overview)
2. [AWS Resources](#aws-resources)
3. [IAM Roles & Policies](#iam-roles--policies)
4. [Supabase Schema](#supabase-schema)
5. [Docker Image](#docker-image)
6. [Lambda: Provision / Deprovision](#lambda-provision--deprovision)
7. [LiteLLM Usage Proxy](#litellm-usage-proxy)
8. [ALB + HTTPS Routing](#alb--https-routing)
9. [Cloudflare Configuration](#cloudflare-configuration)
10. [Tenant Security — Dual-Layer Auth](#tenant-security--dual-layer-auth)
11. [Tenant Login Gateway](#tenant-login-gateway)
12. [Admin Portal](#admin-portal)
13. [Tenant Provisioning Flow](#tenant-provisioning-flow)
14. [OpenClaw Gateway Auth](#openclaw-gateway-auth)
15. [OpenClaw Model Auth](#openclaw-model-auth)
16. [Deployment Runbook](#deployment-runbook)
17. [Troubleshooting Lessons Learned](#troubleshooting-lessons-learned)
18. [Pending / Next Steps](#pending--next-steps)

---

## System Overview

```
Customer Browser
      │
      ▼
claw-me.com/login/  (Tenant Login Gateway — GitHub Pages)
  └── User logs in via Google OAuth or password + MFA
        ├── Auth requests go to: https://auth.claw-me.com  (claw-auth Worker)
        ├── claw-auth issues a signed JWT in a claw_session cookie (.claw-me.com domain)
        └── Redirects to instances.dashboard_url (tokenized URL with #token=XXX)
      │
      ▼
Cloudflare Worker: tenant-guard  (LAYER 1 — Edge Security)
  └── Route: *.claw-me.com/*
        ├── Reads claw_session JWT cookie (HMAC-SHA256 signed)
        ├── Looks up tenant ownership in Supabase (instances → users table)
        ├── Injects BOTH X-Forwarded-User and Cf-Access-Authenticated-User-Email headers
        │     (dual-header for old/new container backward compatibility)
        ├── Passes through if user is owner/member
        └── Returns branded 403 if not authorized / redirects to login if no session
      │
      ▼
AWS ALB  (claw-me-alb)
  ├── HTTP :80  →  redirect to HTTPS
  └── HTTPS :443  (ACM wildcard cert *.claw-me.com)
        ├── host: tenant-abc123.claw-me.com  →  TG: oclaw-abc123  →  ECS Task (tenant)
        ├── host: tenant-def456.claw-me.com  →  TG: oclaw-def456  →  ECS Task (tenant)
        └── default  →  fixed 404

Container Auth Proxy  (LAYER 2 — Container Security)
  └── auth-proxy.py listens on :18789, forwards to OpenClaw on :18790
        ├── Validates Cf-Access-Authenticated-User-Email against TENANT_OWNER_EMAILS
        ├── Owner emails fetched from Supabase at container startup
        └── Returns branded 403 if not authorized

Admin Portal (GitHub Pages)
  └── claw-me.com/admin/index.html
        ├── Reads Supabase (tenants + instances tables)
        └── Calls API Gateway → Lambda (provision / deprovision)

AWS Lambda: claw-me-provision-instance
  ├── POST /provision   → creates LiteLLM virtual key, Secret, TG, ALB rule, RunTask
  ├── POST /deprovision → StopTask, delete rule + TG, delete secret
  ├── POST /status      → reads Supabase
  └── EventBridge (ECS Task State Change) → updates instance status in Supabase

LiteLLM Proxy (ECS Fargate Service — persistent, 1 task)
  └── Internal URL: http://litellm.claw-me.local:4000 (CloudMap DNS)
        ├── One real OpenAI/Anthropic API key stored here
        ├── Issues per-tenant virtual keys with monthly budget caps
        ├── Logs all usage to Supabase litellm_spendlogs table
        ├── Reachable only from within the VPC
        └── ⚠ Standalone Fargate tasks may not resolve CloudMap DNS —
            Lambda provides LITELLM_INTERNAL_URL with fallback to LITELLM_URL

ECS Fargate Tasks (one per tenant, ephemeral)
  └── Image: 204128836886.dkr.ecr.us-east-1.amazonaws.com/claw-me/openclaw:v15
        ├── Pulls secrets from AWS Secrets Manager
        ├── Gets private IP from ECS metadata endpoint
        ├── Registers itself with its ALB target group
        ├── Configures OpenAI auth via `openclaw models auth paste-token` (before gateway)
        ├── Fetches tenant owner emails from Supabase → starts auth proxy if found
        ├── Runs `openclaw dashboard --no-open` to get tokenized dashboard URL
        ├── Stores tokenized URL in Supabase (dashboard_url column)
        ├── Updates Supabase with endpoint_url + gateway_token
        └── Runs OpenClaw gateway on port 18790 (behind auth proxy on 18789)
```

---

## AWS Resources

### Account & Region
| Resource | Value |
|---|---|
| Account ID | `204128836886` |
| Primary Region | `us-east-1` |

### Networking
| Resource | Value |
|---|---|
| VPC | `vpc-05680ab38e5751715` |
| Subnet A | `subnet-099c37f1370e66dc9` |
| Subnet B | `subnet-084bca9516e001a4c` |
| Security Group | `sg-0b8a155730a60d71d` |

### ECS
| Resource | Value |
|---|---|
| Cluster | `claw-me-cluster-use1` |
| Tenant Task Definition Family | `openclaw-task` (current revision: `:53` — v15 image, dual-layer auth) |
| LiteLLM Service | `litellm-proxy` |
| LiteLLM Task Definition Family | `litellm-proxy` |
| Container Name (tenant) | `openclaw` |
| Container Port (tenant) | `18789` |
| Container Port (LiteLLM) | `4000` |
| ECR Repository | `204128836886.dkr.ecr.us-east-1.amazonaws.com/claw-me/openclaw` |

### ALB
| Resource | Value |
|---|---|
| Load Balancer | `claw-me-alb` |
| DNS Name | `claw-me-alb-1129197728.us-east-1.elb.amazonaws.com` |
| HTTPS Listener ARN | `arn:aws:elasticloadbalancing:us-east-1:204128836886:listener/app/claw-me-alb/91aae942341e10a4/03eda1357867fd46` |
| ACM Certificate | `arn:aws:acm:us-east-1:204128836886:certificate/3e2a3ca2-ad04-4e67-84e8-5d7d15b46555` |
| Cloudflare CNAME | `*` → `claw-me-alb-1129197728.us-east-1.elb.amazonaws.com` |

### Lambda & API Gateway
| Resource | Value |
|---|---|
| Function Name | `claw-me-provision-instance` |
| API Gateway URL | `https://1ennrvc596.execute-api.us-east-1.amazonaws.com/prod` |

### Supabase
| Resource | Value |
|---|---|
| Project URL | `https://xfklynglppislmdhjtut.supabase.co` |

### S3
| Resource | Value |
|---|---|
| Config Bucket | `claw-me-config-204128836886` |
| LiteLLM Config Key | `litellm/litellm_config.yaml` |

### CloudMap (internal DNS)
| Resource | Value |
|---|---|
| Namespace | `claw-me.local` |
| Namespace ID | `ns-ikuxejdvo45dcsne` |
| LiteLLM Service | `litellm` |
| LiteLLM Internal URL | `http://litellm.claw-me.local:4000` |

---

## IAM Roles & Policies

Both the ECS task role and execution role use the **same role**: `claw-me-ecs-task-role`

### Required Policies on `claw-me-ecs-task-role`

**1. AlbRegistrationAndSecrets** (inline policy)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ALBTargetRegistration",
      "Effect": "Allow",
      "Action": [
        "elasticloadbalancing:RegisterTargets",
        "elasticloadbalancing:DeregisterTargets",
        "elasticloadbalancing:DescribeTargetHealth"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SecretsManagerUpdate",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:UpdateSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:204128836886:secret:openclaw/*"
    }
  ]
}
```

**2. ECSExec** (inline policy — required for `aws ecs execute-command`)
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel"
    ],
    "Resource": "*"
  }]
}
```

**3. CloudWatchLogsAccess** (inline policy — required for ECS log streaming)
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams"
    ],
    "Resource": "arn:aws:logs:us-east-1:204128836886:*"
  }]
}
```

**4. LiteLLMConfigS3Read** (inline policy — allows LiteLLM task to read config from S3)
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject"],
    "Resource": "arn:aws:s3:::claw-me-config-204128836886/*"
  }]
}
```

> **Note:** The Lambda function has a **separate** IAM role with ALB management permissions. Do not confuse the Lambda role with the ECS task role.

> **Note:** `awslogs-create-group: true` in the task definition requires `logs:CreateLogGroup` on the execution role. If the role is missing this, the task fails to start with `ResourceInitializationError` before any log lines appear. Either pre-create the log group manually (`aws logs create-log-group --log-group-name /ecs/litellm`) or add the CloudWatchLogsAccess policy above.

---

## Supabase Schema

### `tenants`
```sql
id          uuid primary key default gen_random_uuid()
name        text
email       text unique
plan        text    -- 'starter' | 'pro' | 'enterprise'
status      text    -- 'pending' | 'active' | 'suspended' | 'cancelled'
stripe_id   text
created_at  timestamptz default now()
updated_at  timestamptz default now()
```

### `instances`
```sql
id                    uuid primary key default gen_random_uuid()
tenant_id             uuid references tenants(id)
ecs_task_arn          text    -- full ARN
ecs_cluster           text    -- e.g. claw-me-cluster-use1
endpoint_url          text    -- https://tenant-{id-prefix}.claw-me.com
gateway_token         text    -- generated by container on startup
dashboard_url         text    -- tokenized URL: https://tenant-{prefix}.claw-me.com/#token=XXX
region                text    -- e.g. us-east-1
status                text    -- 'provisioning' | 'running' | 'stopped' | 'error'
alb_target_group_arn  text
alb_listener_rule_arn text
last_health_at        timestamptz
created_at            timestamptz default now()
updated_at            timestamptz default now()
```

### `users` (tenant membership — used by Worker + auth proxy)
```sql
id              uuid primary key references auth.users(id)
tenant_id       uuid references tenants(id)
email           text
display_name    text
role            text    -- 'owner' | 'member' | 'viewer'
created_at      timestamptz default now()
updated_at      timestamptz default now()
```

### `audit_log`
```sql
id          uuid primary key default gen_random_uuid()
tenant_id   uuid references tenants(id)
actor       text    -- 'system' | 'admin' | 'eventbridge'
action      text    -- e.g. 'instance.provisioned'
payload     jsonb
created_at  timestamptz default now()
```

### LiteLLM Tables (auto-created by LiteLLM in Supabase)

LiteLLM creates its own tables in the database when it first starts with `STORE_MODEL_IN_DB=True`. Key table for usage queries:

```sql
-- Per-tenant spend this month
SELECT
  metadata->>'tenant_id' AS tenant_id,
  SUM(spend)             AS total_usd,
  SUM(total_tokens)      AS total_tokens,
  COUNT(*)               AS requests
FROM litellm_spendlogs
WHERE startTime > date_trunc('month', now())
GROUP BY 1
ORDER BY 2 DESC;
```

### Row Level Security

RLS is enabled with a **permissive anon policy** (admin portal uses anon key):
```sql
ALTER TABLE tenants   ENABLE ROW LEVEL SECURITY;
ALTER TABLE instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all" ON tenants   FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON instances FOR ALL TO anon USING (true) WITH CHECK (true);
```

### Fixing Status Discrepancies

If tenants are stuck as `pending` but their instances are `running`:
```sql
UPDATE tenants SET status = 'active'
WHERE status = 'pending'
AND id IN (SELECT tenant_id FROM instances WHERE status = 'running');
```

---

## Docker Image

### Location
`docker/Dockerfile` and `docker/entrypoint.sh` in the repo root.

### Deploying (v15 — current)
```bash
cd docker
bash build-v15.sh    # builds --platform linux/amd64 --no-cache, pushes to ECR as :v15

# Set required secrets as env vars first:
export SUPABASE_SERVICE_KEY="sb_secret_..."
export OPENAI_API_KEY="sk-proj-..."
export LITELLM_MASTER_KEY="sk-litellm-..."
bash deploy-v15.sh   # registers task def, updates Lambda ECS_TASK_DEFINITION
```

After deploying, deprovision and reprovision the tenant to pick up the new image.

### What the Container Does at Startup (`entrypoint.sh` — v15)

1. Pulls config JSON from AWS Secrets Manager (`openclaw/tenants/{tenantId}`)
2. **Preserves Lambda-injected env vars** — only overwrites `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` if Secrets Manager has a non-empty value (prevents clobbering)
3. Generates a random `gateway_token` if one doesn't exist
4. Gets its **private IP** from the ECS container metadata endpoint
5. Registers itself with its **ALB target group** using the private IP + port 18789
6. Updates Secrets Manager secret with the token + endpoint
7. Updates Supabase `instances` row with `endpoint_url` and `gateway_token`
8. Writes `~/.openclaw/openclaw.json` via Python (two paths: LiteLLM or direct)
9. **Configures model auth** via `openclaw models auth paste-token --provider openai` — MUST run before gateway
10. **Fetches tenant owner/member emails from Supabase** → sets `TENANT_OWNER_EMAILS` env var
11. Runs `openclaw dashboard --no-open` **before** starting the gateway to generate the tokenized dashboard URL
12. Replaces `http://127.0.0.1:18789` in the tokenized URL with the tenant's HTTPS endpoint
13. Stores the tokenized URL in Supabase (`dashboard_url` column)
14. **If owner emails found:** starts `auth-proxy.py` on port 18789, then `exec openclaw gateway --port 18790`
15. **If no owner emails:** starts OpenClaw directly on port 18789 (backward compatible)

> **Critical:** Steps 9 and 10 MUST run before `exec openclaw gateway`. Running any `openclaw` CLI command while the gateway is live causes the CLI to modify `gateway.auth.token` in the config, which triggers a full process restart and wipes all connection state.

> **Critical:** The entrypoint exports `OPENAI_API_KEY` from Secrets Manager early in startup. If Secrets Manager doesn't have `openaiApiKey` (the common case — it only stores `tenantId/plan/integrations`), this previously overwrote the value injected by the Lambda container override with an empty string, silently skipping the `paste-token` call. Fixed: Secrets Manager values only override env vars when non-empty.

### Environment Variables Injected by Lambda

| Variable | Example Value | Notes |
|---|---|---|
| `TENANT_ID` | `befd5746-...` | |
| `PLAN` | `starter` | |
| `SUBDOMAIN` | `tenant-befd5746` | |
| `REGION` | `us-east-1` | |
| `SECRET_NAME` | `openclaw/tenants/befd5746-...` | |
| `AWS_DEFAULT_REGION` | `us-east-1` | |
| `GATEWAY_PORT` | `18789` | |
| `SUPABASE_URL` | `https://xfklynglppislmdhjtut.supabase.co` | |
| `SUPABASE_SERVICE_KEY` | *(service role key)* | |
| `TARGET_GROUP_ARN` | `arn:aws:elasticloadbalancing:...` | |
| `HTTPS_ENDPOINT` | `https://tenant-befd5746.claw-me.com` | |
| `OPENAI_API_KEY` | `sk-litellm-...` (virtual key) or `sk-...` (real key) | Virtual key when LiteLLM is up; real key as fallback |
| `OPENAI_API_BASE` | `http://litellm.claw-me.local:4000` or direct IP | Set when LiteLLM virtual key is used. Uses `LITELLM_INTERNAL_URL` (CloudMap) with fallback to `LITELLM_URL` (public). **Must be VPC-internal — Cloudflare blocks the public domain.** |
| `ANTHROPIC_API_KEY` | *(empty if using LiteLLM)* | Only set if bypassing LiteLLM |

### OpenClaw Config — LiteLLM Path (generated by entrypoint.sh when `OPENAI_API_BASE` is set)

```json
{
  "gateway": {
    "bind": "lan",
    "mode": "local",
    "port": 18789,
    "auth": {
      "mode": "trusted-proxy",
      "trustedProxy": { "userHeader": "Cf-Access-Authenticated-User-Email" }
    },
    "trustedProxies": ["127.0.0.1/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    "controlUi": { "allowedOrigins": ["*"] }
  },
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "http://litellm.claw-me.local:4000/v1",
        "apiKey": "sk-litellm-...",
        "models": [
          { "id": "gpt-4.1-mini", "name": "GPT-4.1 Mini", "contextWindow": 128000, "maxTokens": 16384 },
          { "id": "gpt-4.1", "name": "GPT-4.1", "contextWindow": 1000000, "maxTokens": 32768 }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/root/.openclaw/workspace",
      "model": { "primary": "openai/gpt-4.1-mini" },
      "models": { "openai/gpt-4.1-mini": { "alias": "Primary" } }
    }
  },
  "channels": {
    "telegram": { "enabled": true, "botToken": "", "dmPolicy": "pairing", "groupPolicy": "open" },
    "whatsapp": { "enabled": true, "dmPolicy": "pairing", "groupPolicy": "open" },
    "discord":  { "enabled": true, "token": "", "dmPolicy": "pairing", "groupPolicy": "open" },
    "slack":    { "enabled": true, "mode": "socket", "appToken": "", "botToken": "", "dmPolicy": "pairing" }
  }
}
```

> **All four channels must have `enabled: true`** to appear on the tenant's channels page. Channels with `enabled: false` flash briefly then disappear as the dashboard hides unconfigured channels after the status check. Tenants configure tokens/credentials from the dashboard UI.

> **Critical: The `models` array in `models.providers.openai` is REQUIRED.** Without it, OpenClaw schema validation fails with `models.providers.openai.models: Invalid input: expected array, received undefined` and the gateway won't start. The models must also be listed in the LiteLLM `/key/generate` call (see Lambda code).
```

The gateway uses `auth.mode: "trusted-proxy"` which trusts the `Cf-Access-Authenticated-User-Email` header injected by Cloudflare Access after Google OAuth authentication. This provides per-user identity — the authenticated user's email becomes the OpenClaw user identity. `127.0.0.1/8` is included in `trustedProxies` so that internal cron health checks from localhost are authorized without needing the email header.

> **Current image:** `v15` in ECR. Task definition `:53` includes the container-level auth proxy (`auth-proxy.py`) for dual-layer tenant security. All config (trustedProxies, 4-channel support, LiteLLM provider, auth proxy) is baked into the image. Previous task defs `:46`–`:50` used fragile sed overrides that broke the channels page.

---

## Lambda: Provision / Deprovision

### Function: `claw-me-provision-instance`
- **Runtime:** Node.js 20
- **Entry:** `lambda/provision-instance/index.js`
- **Trigger:** API Gateway POST + EventBridge (ECS Task State Change)

### Deploy
```bash
cd lambda/provision-instance
npm install
zip -r function.zip .
aws lambda update-function-code \
  --function-name claw-me-provision-instance \
  --zip-file fileb://function.zip \
  --region us-east-1
```

### Environment Variables

| Variable | Value |
|---|---|
| `ECS_TASK_DEFINITION` | `openclaw-task:53` (updated by `deploy-v15.sh`) |
| `SUPABASE_URL` | `https://xfklynglppislmdhjtut.supabase.co` |
| `SUPABASE_SERVICE_KEY` | *(service role key)* |
| `SUBNET_IDS` | `subnet-099c37f1370e66dc9,subnet-084bca9516e001a4c` |
| `SECURITY_GROUP_ID` | `sg-0b8a155730a60d71d` |
| `VPC_ID` | `vpc-05680ab38e5751715` |
| `ALB_LISTENER_ARN` | `arn:aws:elasticloadbalancing:us-east-1:204128836886:listener/app/claw-me-alb/...` |
| `BASE_DOMAIN` | `claw-me.com` |
| `OPENAI_API_KEY` | *(real OpenAI key — fallback when LiteLLM unavailable)* |
| `LITELLM_URL` | `https://litellm.claw-me.com` (public, used for key generation from Lambda) |
| `LITELLM_INTERNAL_URL` | `http://litellm.claw-me.local:4000` (VPC-internal, passed to tenant containers as `OPENAI_API_BASE`) |
| `LITELLM_MASTER_KEY` | `sk-litellm-master-...` |

> `deploy.sh` updates `ECS_TASK_DEFINITION` automatically — you only need to manually update other vars.

> **OPENAI_API_KEY must be set in Lambda env.** The entrypoint reads it from the Lambda container override. If it's missing from Lambda env, LiteLLM virtual key creation falls back to empty string, the container starts with no API key, and `openclaw models auth paste-token` is silently skipped.

### What `provision` Does

1. Creates (or restores) an AWS Secrets Manager secret: `openclaw/tenants/{tenantId}`
2. Creates an ALB target group: `oclaw-{tenantId-prefix}` (IP type, port 18789)
3. Creates an ALB listener rule: `host-header: tenant-{prefix}.claw-me.com` → target group
4. **Creates a LiteLLM virtual key** for the tenant (if `LITELLM_URL` + `LITELLM_MASTER_KEY` are set), with monthly budget cap based on plan
5. Runs an ECS Fargate task with `enableExecuteCommand: true`, injecting the virtual key as `OPENAI_API_KEY` and `OPENAI_API_BASE`
6. Upserts the `instances` row in Supabase

### What `deprovision` Does

1. Stops the ECS task
2. Deletes the ALB listener rule
3. Deletes the ALB target group
4. Schedules the Secrets Manager secret for deletion (7-day recovery window)
5. Updates instance status to `stopped` and tenant status to `cancelled`

### EventBridge Handler

Listens for ECS Task State Change events and updates `instances.status` in Supabase:
- `RUNNING` → `running`
- `STOPPED` → `stopped`
- Other → `provisioning`

---

## LiteLLM Usage Proxy

LiteLLM sits between tenant containers and OpenAI/Anthropic. Your real API keys never leave LiteLLM. Each tenant gets a **virtual key** with a monthly budget cap.

### Architecture

```
Tenant ECS Task
  OPENAI_API_KEY = sk-litellm-...  (virtual key)
  OPENAI_API_BASE = http://litellm.claw-me.local:4000  (or hardcoded IP if DNS fails)
      │
      ▼ (VPC-internal, CloudMap DNS or direct IP)
LiteLLM Proxy (ECS Fargate Service)
  litellm.claw-me.local:4000
      │
      ├── Validates virtual key + checks monthly budget
      ├── Logs request to litellm_spendlogs (Supabase)
      └── Forwards to OpenAI / Anthropic with real API key
```

> **Critical: Do NOT use the public domain (`https://litellm.claw-me.com`) for container-to-container traffic.** Cloudflare proxies that domain and blocks non-browser requests with a 403. Tenant containers must reach LiteLLM via VPC-internal networking (CloudMap DNS or IP).

### Metering Status (verified March 22, 2026)

LiteLLM per-tenant spend tracking is confirmed working end-to-end. The `/global/spend/keys` endpoint shows per-key spend accumulation:
```bash
curl -s -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  "https://litellm.claw-me.com/global/spend/keys?start_date=2026-03-20&end_date=2026-03-23"
```

### Deployment

```bash
export LITELLM_MASTER_KEY="sk-litellm-master-YOURKEY"  # you choose this
export OPENAI_API_KEY="sk-..."                          # real OpenAI key
export ANTHROPIC_API_KEY="sk-ant-..."                   # optional
export DATABASE_URL="postgresql://..."                  # Supabase connection string

./litellm/deploy-litellm.sh
```

The script (7 steps):
1. Creates S3 bucket `claw-me-config-204128836886` and uploads config (skips if bucket exists)
2. Creates CloudMap namespace `claw-me.local` (skips if exists, polls for completion)
3. Creates CloudMap service `litellm` (skips if exists)
4. Attaches `LiteLLMConfigS3Read` inline policy to `claw-me-ecs-task-role`
5. Registers ECS task definition `litellm-proxy` (no `--config` flag — runs config-free)
6. Creates or updates ECS service `litellm-proxy` (desired count: 1, persistent)
7. Stores `LITELLM_URL` + `LITELLM_MASTER_KEY` in Lambda env

### Config-Free Mode

LiteLLM runs without a `--config` file. All settings come from environment variables:
- `LITELLM_MASTER_KEY` — admin API key
- `OPENAI_API_KEY` — real OpenAI key (used for all tenant proxied calls)
- `DATABASE_URL` + `STORE_MODEL_IN_DB=True` — persists models and keys in Supabase

> **Why no config file?** The official `ghcr.io/berriai/litellm:main-latest` image does not reliably support `--config s3://...` paths. Attempts to use S3 config result in `Exception: Config file not found: s3://...` even with correct IAM permissions. Running config-free with env vars is the stable approach.

### Per-Tenant Virtual Keys

Created automatically during provisioning (`lambda/provision-instance/index.js`):

| Plan | Monthly Budget |
|---|---|
| Starter | $10 |
| Pro | $50 |
| Enterprise | No limit |

When a tenant exceeds their budget, LiteLLM returns a `BudgetExceededError` and the agent fails gracefully.

### Monitoring Usage

```sql
-- Per-tenant spend this month
SELECT
  metadata->>'tenant_id' AS tenant_id,
  SUM(spend)             AS total_usd,
  SUM(total_tokens)      AS total_tokens,
  COUNT(*)               AS requests
FROM litellm_spendlogs
WHERE startTime > date_trunc('month', now())
GROUP BY 1
ORDER BY 2 DESC;
```

### Viewing LiteLLM Logs

```bash
aws logs tail /ecs/litellm --region us-east-1 --follow
```

---

## ALB + HTTPS Routing

### Certificate
Wildcard ACM cert for `*.claw-me.com`:
- ARN: `arn:aws:acm:us-east-1:204128836886:certificate/3e2a3ca2-ad04-4e67-84e8-5d7d15b46555`
- Validated via CNAME record in Cloudflare

### Listeners
| Listener | Port | Action |
|---|---|---|
| HTTP | 80 | Redirect to HTTPS (301) |
| HTTPS | 443 | Host-header routing rules (one per tenant) |

### Per-Tenant Routing
Each provisioned tenant gets:
- **Target Group:** `oclaw-{tenantId-prefix}` — IP type, port 18789, health check path `/`, codes 200–404
- **Listener Rule:** host-header matches `tenant-{prefix}.claw-me.com` → forward to that TG

### DNS (Cloudflare)
Single wildcard CNAME proxied through Cloudflare:
```
*   CNAME   claw-me-alb-1129197728.us-east-1.elb.amazonaws.com
```

### Why HTTPS is Required
OpenClaw's control UI requires a **Secure Context** (HTTPS or localhost) to access browser APIs like WebCrypto for device identity. Without HTTPS, login fails with: *"requires device identity (use HTTPS or localhost)"*.

---

## Cloudflare Configuration

### Wildcard CNAME
```
*   CNAME   claw-me-alb-1129197728.us-east-1.elb.amazonaws.com   (proxied)
```

### claw-auth Worker (Identity Layer)

Authentication is handled by the `claw-auth` Cloudflare Worker at `auth.claw-me.com`. It replaced Cloudflare Access entirely and supports both Google OAuth and password + TOTP MFA login.

| Setting | Value |
|---|---|
| Worker name | `claw-auth` |
| URL | `https://auth.claw-me.com` |
| Auth methods | Google OAuth (via Google APIs) + password + TOTP MFA |
| Session token | `claw_session` JWT cookie (HMAC-SHA256, 7-day expiry, domain `.claw-me.com`) |
| Post-login redirect | `instances.dashboard_url` (tokenized URL) → falls back to `endpoint_url` |
| File | `cloudflare-worker/claw-auth.js` |

**Flow:**
1. User visits `claw-me.com/login/` with `?instance=tenant-abc123` pre-filled (from welcome email link)
2. User chooses Google OAuth or password + MFA
3. `claw-auth` verifies credentials, issues `claw_session` JWT cookie on `.claw-me.com`
4. `claw-auth` fetches `dashboard_url` from Supabase and redirects the user there

> **Note:** Cloudflare Access (`ielaboratories.cloudflareaccess.com`) is no longer used for tenant authentication. The old "Inject user header for OpenClaw" Transform Rule (static `X-Forwarded-User: user`) was deleted. The `claw-auth` Worker issues real per-user JWT sessions.

### Cloudflare Worker: tenant-guard

Route `*.claw-me.com/*` → `tenant-guard` Worker. See [Tenant Security](#tenant-security--dual-layer-auth) for details.

---

## Tenant Security — Dual-Layer Auth

Tenant access is protected by two independent layers. Both must pass for a request to reach the OpenClaw gateway.

### Layer 1: Cloudflare Worker (Edge)

**File:** `cloudflare-worker/tenant-guard.js`

The `tenant-guard` Worker runs on every request to `*.claw-me.com/*` and validates tenant ownership at the edge before traffic reaches the origin:

1. Extract subdomain from the request hostname
2. Read the `claw_session` JWT cookie (issued by `claw-auth` Worker)
3. Verify JWT signature (HMAC-SHA256) and expiry
4. Look up `instances` table in Supabase by `endpoint_url` to find the `tenant_id`
5. Check `users` table for a row matching the email with `owner` or `member` role
6. If authorized: inject BOTH `Cf-Access-Authenticated-User-Email` and `X-Forwarded-User` headers with the authenticated email, then pass through
7. If no valid session: redirect to `https://claw-me.com/login`
8. If authorized but wrong tenant: return branded 403

Skips root domain, `www`, `admin`, and `litellm` subdomains. Fails closed (denies if Supabase lookup fails).

> **Dual-header injection:** tenant-guard injects BOTH `X-Forwarded-User` and `Cf-Access-Authenticated-User-Email` for backward compatibility. Containers provisioned from older images (v14 and earlier) expect `X-Forwarded-User`; v15+ containers expect `Cf-Access-Authenticated-User-Email`. Injecting both ensures all containers work.

**Config:** `cloudflare-worker/wrangler.toml`
```
routes = [{ pattern = "*.claw-me.com/*", zone_name = "claw-me.com" }]
```

**Secrets (set via `wrangler secret put`):**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `JWT_SECRET` (must match the secret used by `claw-auth`)

### Layer 2: Container Auth Proxy

**File:** `docker/auth-proxy.py`

A lightweight Python HTTP reverse proxy inside the container. Listens on port 18789 (the public-facing port), forwards to OpenClaw on port 18790.

1. Entrypoint fetches tenant owner/member emails from Supabase at startup → `TENANT_OWNER_EMAILS`
2. Auth proxy validates `Cf-Access-Authenticated-User-Email` against the allowlist
3. Health check paths (`/health`, `/healthz`, `/ready`, `/api/health`) pass through without auth
4. If no owner emails configured, passes through (fail open for initial setup)

This provides defense in depth — if the Worker is bypassed or misconfigured, the container itself blocks unauthorized access.

---

## Tenant Login Gateway

**File:** `login/index.html` (GitHub Pages)
**URL:** `https://claw-me.com/login/`
**Auth Worker:** `cloudflare-worker/claw-auth.js` at `https://auth.claw-me.com`

A branded login page that authenticates the user and redirects them directly into their OpenClaw dashboard:

1. User navigates to `claw-me.com/login/` — typically via a link in the welcome email that includes `?instance=tenant-abc123&email=user@example.com` to pre-fill the form
2. User chooses Google OAuth or password + TOTP MFA
3. `claw-auth` verifies credentials against Supabase, issues a signed `claw_session` JWT cookie on `.claw-me.com` domain
4. `claw-auth` fetches `instances.dashboard_url` for the tenant (the tokenized URL)
5. Browser is redirected to the tokenized URL: `https://tenant-abc123.claw-me.com/#token=XXX`
6. `tenant-guard` Worker validates the `claw_session` cookie, injects email headers, passes to ALB
7. Container auth proxy validates email, forwards to OpenClaw
8. OpenClaw frontend reads `#token=XXX` from the URL hash — user lands directly in the dashboard with no additional login step

The landing page (`index.html`) includes two entry points to the login flow:
- Top nav: "Early Access Login" button
- Mid-page: "Already have early access? Log in to your claw-me instance" button

---

## Admin Portal

- **URL:** `https://claw-me.com/admin/index.html` (GitHub Pages)
- **File:** `admin/index.html`
- **Auth:** `admin-guard` Cloudflare Worker (same JWT + MFA as tenant containers)

### Security Layer — admin-guard Worker

The admin portal is protected by the `admin-guard` Cloudflare Worker running on the `claw-me.com/admin/*` route. It uses the exact same JWT cookie mechanism as `tenant-guard` and tenant containers:

| Step | Detail |
|------|--------|
| 1 | Read `claw_session` JWT cookie from request |
| 2 | Verify HMAC-SHA256 signature using shared `JWT_SECRET` |
| 3 | Check email is in `ADMIN_EMAILS` Cloudflare secret (comma-separated operator list) |
| 4 | **Pass** → proxy to origin (GitHub Pages) |
| 5 | **No session** → redirect to `/login?redirect=/admin` (returns here after MFA) |
| 6 | **Not admin** → branded 403 page |

**Files:**
- `cloudflare-worker/admin-guard.js` — Worker source
- `cloudflare-worker/wrangler-admin.toml` — Deploy config

**Secrets to configure once (never commit):**
```bash
npx wrangler secret put JWT_SECRET   --config cloudflare-worker/wrangler-admin.toml
# Use the SAME value as claw-auth and tenant-guard

npx wrangler secret put ADMIN_EMAILS --config cloudflare-worker/wrangler-admin.toml
# Comma-separated, e.g.: alexis.hiram@gmail.com,ops@claw-me.com
```

**Deploy:**
```bash
cd cloudflare-worker
npx wrangler deploy --config wrangler-admin.toml
```

### Admin Login Flow

When an unauthenticated request hits `/admin`, the guard redirects to `/login?redirect=/admin`. The login page detects `?redirect=/admin` and:
1. Hides the instance-name field (not needed for operator accounts)
2. Shows "Admin access — sign in with your operator credentials"
3. Hides the Google OAuth button (password+MFA only for admin)
4. After successful MFA, passes `redirect_url_override: "/admin"` to `claw-auth`'s `verify-mfa` endpoint, which validates it's on the same domain and returns `redirect_url: "https://claw-me.com/admin"` — landing the user directly on the admin portal.

### Features
- Lists all tenants with status, plan, email
- Shows instance details: `endpoint_url`, `ecs_task_arn`, status
- **🔑 Creds button** — shows gateway URL + token in a modal with copy buttons
- **Provision button** — calls `POST /provision` via API Gateway
- **Deprovision button** — calls `POST /deprovision` via API Gateway

---

## Tenant Provisioning Flow

```
Admin clicks Provision
        │
        ▼
API Gateway POST /provision
  { action: "provision", tenantId, plan }
        │
        ▼
Lambda: claw-me-provision-instance
  1. Create/restore Secrets Manager secret
  2. Create ALB target group (oclaw-{prefix})
  3. Create ALB listener rule (host-header)
  4. Create LiteLLM virtual key for tenant (budget: $10/mo starter, $50/mo pro)
  5. RunTask (ECS Fargate, enableExecuteCommand: true)
     Injects: OPENAI_API_KEY=<virtual-key>, OPENAI_API_BASE=<LITELLM_INTERNAL_URL or LITELLM_URL>
  6. Upsert Supabase instances row (status: provisioning)
        │
        ▼ (task starts ~30s later)
ECS Task entrypoint.sh
  1. Pull secrets from Secrets Manager
  2. Preserve Lambda-injected OPENAI_API_KEY (do NOT overwrite with empty SM value)
  3. Generate gateway_token (if not in secret)
  4. Get private IP from ECS metadata
  5. Register with ALB target group
  6. Update secret with token + endpoint
  7. PATCH Supabase instances (endpoint_url, gateway_token)
  8. Write ~/.openclaw/openclaw.json from template
  9. Run `openclaw models auth paste-token --provider openai` (uses OPENAI_API_KEY)
  10. Fetch tenant owner/member emails from Supabase → TENANT_OWNER_EMAILS
  11. Run `openclaw dashboard --no-open` → get tokenized URL
  12. Replace 127.0.0.1:18789 with HTTPS endpoint in URL
  13. Store tokenized URL in Supabase (dashboard_url)
  14. If owner emails found: start auth-proxy.py on :18789 → OpenClaw on :18790
  15. If no owner emails: start OpenClaw directly on :18789
        │
        ▼
EventBridge (ECS Task State Change: RUNNING)
  → Lambda updates instances.status = 'running'
        │
        ▼
Tenant accesses: https://claw-me.com/login/ (link in welcome email includes ?instance= pre-filled)
  → Google OAuth or password+MFA via claw-auth Worker
  → claw-auth issues claw_session JWT cookie, redirects to instances.dashboard_url
  → tenant-guard Worker validates JWT, injects email headers (Layer 1)
  → Auth proxy validates email (Layer 2)
  → OpenClaw dashboard (frontend reads #token= from URL hash, no extra login step)
```

---

## OpenClaw Gateway Auth

### How It Works

The gateway runs with `auth.mode: "trusted-proxy"`. All browser connections are authenticated via the `Cf-Access-Authenticated-User-Email` HTTP header, which the `tenant-guard` Worker injects after validating the user's `claw_session` JWT cookie. The authenticated user's email becomes the OpenClaw user identity. No device pairing is required.

The `tenant-guard` Worker also injects `X-Forwarded-User` for backward compatibility with containers built from older images that expect that header name. Both headers carry the same email value.

### How to Access the Control UI

Use the **tokenized URL** stored in `instances.dashboard_url` in Supabase. It looks like:
```
https://tenant-XXXX.claw-me.com/#token=<DASHBOARD_TOKEN>
```

The `#token=` fragment is read by the Control UI JavaScript. Do **not** use the plain URL (`https://tenant-XXXX.claw-me.com`) — it will attempt an unauthenticated connection and fail.

### OpenClaw Auth Config — What Works and What Doesn't

| Config | Result |
|---|---|
| `auth.mode: "token"` + `controlUi.allowInsecureAuth: true` | `allowInsecureAuth` does NOT bypass pairing over HTTPS — it only allows token over HTTP. Pairing still required. |
| `auth.mode: "token"` + auto-approve CLI loop | CLI commands modify `gateway.auth.token` → triggers full gateway restart every 5s → device state wiped → pairing never completes. |
| `auth.mode: "open"` | Invalid value. Allowed values: `"none"`, `"token"`, `"password"`, `"trusted-proxy"`. |
| `auth.mode: "none"` | Gateway refuses to bind to `lan` without auth. Only works for loopback. |
| `auth.mode: "trusted-proxy"` with `trustedProxy: { ips: [...] }` | Invalid — `ips` is unrecognized. Required field is `userHeader`. |
| `auth.mode: "trusted-proxy"` with `trustedProxy: { userHeader: "Cf-Access-Authenticated-User-Email" }` | ✅ **Works.** Gateway starts, accepts all connections where the header is present. Cloudflare Access injects this header automatically after Google OAuth. |
| `gateway.devices.autoApprove: true` | Invalid key — crashes gateway on startup. |

### Tokenized URL Notes

- `openclaw dashboard --no-open` generates a URL of the form `http://127.0.0.1:18789/#token=XXX`
- This command MUST be run **before** `exec openclaw gateway` in the entrypoint
- Running it while the gateway is live triggers a config change → gateway restart
- The `127.0.0.1:18789` portion is replaced with the tenant's HTTPS endpoint in entrypoint.sh
- The `#token=` fragment is handled client-side by the Control UI JavaScript — it is never sent to the server

### ECS Exec (for debugging)

Requires: `brew install --cask session-manager-plugin` on your Mac.

```bash
# Get task ID
aws ecs list-tasks --cluster claw-me-cluster-use1 --region us-east-1 --query 'taskArns[0]' --output text

# Open shell in container
aws ecs execute-command --cluster claw-me-cluster-use1 --region us-east-1 \
  --task <TASK_ID> --container openclaw --interactive --command '/bin/bash'

# Check live config
cat /root/.openclaw/openclaw.json

# Check auth profiles
cat /root/.openclaw/agents/main/agent/auth-profiles.json
```

> **Warning:** Do not run `openclaw` CLI commands inside the container while the gateway is running. Any CLI invocation modifies `gateway.auth.token` in the config file, which the gateway file-watches. It detects the change and does a full process restart — wiping all connection state.

---

## OpenClaw Model Auth

### How LLM API Keys Are Configured

OpenClaw does **not** read `OPENAI_API_KEY` from the OS environment. It stores LLM credentials in its own auth store:

```
/root/.openclaw/agents/main/agent/auth-profiles.json
```

This file is populated by the `openclaw models auth paste-token` command. If it doesn't exist or is empty, every agent message fails with:

```
No API key found for provider "openai". Auth store: /root/.openclaw/agents/main/agent/auth-profiles.json
```

### Configuring Auth (entrypoint.sh)

```bash
mkdir -p /root/.openclaw/agents/main/agent
echo "$OPENAI_API_KEY" | openclaw models auth paste-token --provider openai
echo "$ANTHROPIC_API_KEY" | openclaw models auth paste-token --provider anthropic
```

This MUST run before `exec openclaw gateway`. Running it while the gateway is live crashes the container.

### Useful Model Commands

```bash
# From inside the container (via ECS exec):
openclaw models --help               # list subcommands
openclaw models auth --help          # auth subcommands
openclaw models auth paste-token --help  # non-interactive key config
openclaw models list                 # list configured models
openclaw models status               # show model health
```

### OpenClaw Control UI Limitations

The Control UI is **chat-only** — there is no settings panel, no channel config, no model config. All configuration must be done via:
- `openclaw.json` (baked into the Docker image)
- `entrypoint.sh` (runtime config at startup)
- CLI commands run inside the container before the gateway starts

---

## Deployment Runbook

### Iterating on the Docker image

**Current approach (v15 — dual-layer auth):**
```bash
cd docker
bash build-v15.sh    # builds --platform linux/amd64 --no-cache, pushes to ECR as :v15

# Set required secrets as env vars:
export SUPABASE_SERVICE_KEY="sb_secret_..."
export OPENAI_API_KEY="sk-proj-..."
export LITELLM_MASTER_KEY="sk-litellm-..."
bash deploy-v15.sh   # registers task def, updates Lambda ECS_TASK_DEFINITION
```

> **Note:** `deploy-v15.sh` reads secrets from environment variables — they are NOT hardcoded in the script. This allows the script to be committed to GitHub without triggering secret scanning push protection.

**Legacy options (deprecated):**
- `deploy.sh` — auto-increments version, registers task def, updates Lambda
- `build-v13.sh` / `deploy-v13.sh` — v13 image without auth proxy
- `build-v14.sh` / `deploy-v14.sh` — v14 image with Cloudflare Access header but no auth proxy
- Task defs `:46`–`:50` — sed entrypoint overrides (broke channels page, do not use)

Then deprovision + reprovision the tenant to pick up the new task definition.

### Deploying the Cloudflare Worker

```bash
cd cloudflare-worker
npx wrangler login              # first time only
npx wrangler deploy             # deploys worker + registers route
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
```

> **Important:** When the ECR tag (e.g., `:v15`) is overwritten with a new push, existing task definitions referencing that tag will pull the new image on the next task launch. No task def re-registration needed if only the image contents changed.

### Deploying LiteLLM

```bash
export LITELLM_MASTER_KEY="sk-litellm-master-YOURKEY"
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."
export DATABASE_URL="postgresql://..."

./litellm/deploy-litellm.sh
```

Re-run anytime to update the config or task definition.

### Deploying Lambda code

```bash
cd lambda/provision-instance
npm install
zip -r function.zip .
aws lambda update-function-code \
  --function-name claw-me-provision-instance \
  --zip-file fileb://function.zip \
  --region us-east-1
```

### Updating Lambda environment variables

```bash
CURRENT_ENV=$(aws lambda get-function-configuration \
  --function-name claw-me-provision-instance \
  --region us-east-1 \
  --query 'Environment.Variables' --output json)

NEW_ENV=$(echo "$CURRENT_ENV" | python3 -c "
import sys, json
d = json.load(sys.stdin)
d['OPENAI_API_KEY'] = 'sk-...'
print(json.dumps({'Variables': d}))
")

aws lambda update-function-configuration \
  --function-name claw-me-provision-instance \
  --region us-east-1 \
  --environment "$NEW_ENV"
```

> Always merge into existing env vars (fetch → modify → put) to avoid wiping other variables.

### Provision / Deprovision via CLI

```bash
# Deprovision
aws lambda invoke \
  --function-name claw-me-provision-instance \
  --region us-east-1 \
  --payload '{"action":"deprovision","tenantId":"YOUR-TENANT-ID"}' \
  --cli-binary-format raw-in-base64-out /tmp/out.json && cat /tmp/out.json

# Provision
aws lambda invoke \
  --function-name claw-me-provision-instance \
  --region us-east-1 \
  --payload '{"action":"provision","tenantId":"YOUR-TENANT-ID","plan":"starter"}' \
  --cli-binary-format raw-in-base64-out /tmp/out.json && cat /tmp/out.json
```

---

## Troubleshooting Lessons Learned

### Container goes straight to STOPPED — `TaskFailedToStart` / platform mismatch
```
image Manifest does not contain descriptor matching platform 'linux/amd64'
```
Built on an M-series Mac without `--platform linux/amd64`. Fix: `deploy.sh` always passes `--platform linux/amd64`. Never build manually without this flag.

### `TaskFailedToStart` — `ResourceInitializationError: failed to create Cloudwatch log group`
```
AccessDeniedException: not authorized to perform: logs:CreateLogGroup
```
The ECS execution role lacks `logs:CreateLogGroup`. Two fixes: (1) pre-create the log group manually with `aws logs create-log-group --log-group-name /ecs/litellm --region us-east-1`, or (2) add the `CloudWatchLogsAccess` inline policy to `claw-me-ecs-task-role`. The task will not log any output before this error — if logs are missing, always check `aws ecs describe-services` events first.

### `OPENAI_API_KEY` empty in container despite being set in Lambda env
The entrypoint exports `OPENAI_API_KEY` from Secrets Manager early in startup:
```bash
export OPENAI_API_KEY=$(echo "$SECRET_JSON" | python3 -c "...d.get('openaiApiKey','')")
```
The Secrets Manager secret only contains `tenantId/plan/createdAt/integrations` — no `openaiApiKey`. This returns `""` and **overwrites** the value injected by the Lambda container override. The fix: only update the env var if Secrets Manager returns a non-empty value. See `entrypoint.sh` for the corrected pattern.

### `openclaw models auth paste-token` crashes container
Running `paste-token` while the gateway is live writes to `auth-profiles.json`, which the gateway detects as a config change and triggers a process restart. If tini doesn't handle the restart cleanly, the container dies. Fix: always run `paste-token` **before** `exec openclaw gateway` in the entrypoint.

### `No API key found for provider "openai"` — agent fails on every message
OpenClaw doesn't read `OPENAI_API_KEY` from the environment. It requires `auth-profiles.json` to be populated via `openclaw models auth paste-token`. If the startup logs show `=== Configuring OpenAI auth ===` is missing, `OPENAI_API_KEY` was empty when the entrypoint ran — check the Lambda env variable.

### LiteLLM `Exception: Config file not found: s3://...`
The `ghcr.io/berriai/litellm:main-latest` image does not reliably support S3 config paths despite having boto3 installed. Even with correct IAM permissions (`s3:GetObject` on the config bucket), the S3 fetch fails silently and raises `Config file not found`. Fix: remove the `--config` flag entirely and run LiteLLM config-free using only environment variables.

### S3 bucket creation fails silently in us-east-1
AWS S3 bucket creation in `us-east-1` must **not** include `--create-bucket-configuration LocationConstraint=us-east-1`. The `us-east-1` region is the S3 default and specifying `LocationConstraint` for it returns a 400 error. Using `|| true` to suppress errors causes the bucket to silently not be created, and subsequent uploads fail with `NoSuchBucket`. Fix: detect region and omit `LocationConstraint` when `REGION == "us-east-1"`.

### Container crashes with "Invalid config: Unrecognized key"
OpenClaw validates config strictly on startup. Any unrecognized key causes a fatal crash. Keys we confirmed do NOT exist: `gateway.devices`, `gateway.devices.autoApprove`. Check logs immediately — the error message names the bad key exactly.

### Container crashes — old image despite rebuild
Docker BuildKit ECR remote cache overrides `--no-cache`. Fix: always use versioned tags (`:v10`, `:v11`, etc.) — new tags get no cache hits. `deploy.sh` auto-increments the version.

### Lambda "invalid revision number"
`ECS_TASK_DEFINITION` env var on the Lambda had a stale revision. `deploy.sh` updates it automatically.

### `register-task-definition` parameter validation error
`describe-task-definition` output includes read-only fields that cannot be re-submitted. Must strip: `taskDefinitionArn`, `revision`, `status`, `requiresAttributes`, `compatibilities`, `registeredAt`, `registeredBy`. `deploy.sh` handles this automatically.

### Gateway does full process restart → container dies
OpenClaw occasionally does a "full process restart" (spawns new PID, exits original). Without a process supervisor, ECS sees PID 1 exit and stops the task. Fix: `tini` as PID 1 (`ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]`).

### `openclaw devices list/approve` in background loop causes constant restarts
Any `openclaw` CLI command run while the gateway is live writes to `gateway.auth.token` in `openclaw.json`. The gateway file-watches the config, detects the change, and does a full process restart — wiping all device pairing state. **Do not run any `openclaw` CLI commands while the gateway is running.**

### `trusted-proxy` mode: `trusted_proxy_user_missing`
The gateway started but rejected all WebSocket connections. The most common cause is a **header name mismatch**: the container's `openclaw.json` is configured with a `trustedProxy.userHeader` that doesn't match the header the Worker is actually injecting.

- **v15+ containers** (entrypoint.sh v15): `userHeader: "Cf-Access-Authenticated-User-Email"`
- **v14 and earlier containers**: `userHeader: "X-Forwarded-User"`

The `tenant-guard` Worker now injects BOTH headers to handle all container generations. If you see this error on a running container, check the container's `openclaw.json` (via ECS Exec or CloudWatch logs) to confirm which header it expects. The `remote=10.x.x.x` IP in the WS log is the ALB — verify it falls within the `trustedProxies` ranges in the config (`10.0.0.0/8` covers all ALB IPs).

Diagnostic: Check CloudWatch logs for the container startup — it prints the full `openclaw.json` at boot. The `trustedProxy.userHeader` value tells you exactly which header is expected.

### LiteLLM ECS service stuck at 0 running tasks after fix
After fixing the CloudWatch log group permission issue, ECS does not automatically retry — it backs off. Use `aws ecs update-service --force-new-deployment` to kick it.

### Lambda env update wipes other variables
Using `aws lambda update-function-configuration --environment '{"Variables":{"KEY":"val"}}'` with a partial object replaces the entire env. Always fetch the current env first, merge in changes, then put the full object back.

### `aws logs tail` not working in zsh
`aws logs tail` is an AWS CLI v2 command — make sure CLI v2 is installed. Also confirm the log group exists first; if the ECS task never started, the log group won't exist yet.

### Cloudflare 403 "Your request was blocked" on container-to-container LLM calls
Tenant containers routing through `https://litellm.claw-me.com` (the public domain) get a 403 from Cloudflare. Cloudflare's bot protection blocks non-browser HTTP traffic from within VPCs. Fix: use VPC-internal networking. The Lambda sets `OPENAI_API_BASE` to `LITELLM_INTERNAL_URL` (CloudMap DNS `http://litellm.claw-me.local:4000`) or a direct IP. Never use the public `https://litellm.claw-me.com` for container-to-container traffic.

### CloudMap DNS not resolving from standalone Fargate tasks
Setting `OPENAI_API_BASE=http://litellm.claw-me.local:4000` caused timeouts — the tenant task couldn't resolve the CloudMap DNS name. VPC has `enableDnsSupport=true` but `enableDnsHostnames=false`. The Cloud Map namespace and service are correctly configured, but standalone Fargate tasks (not part of an ECS service with service discovery) may not reliably resolve private DNS. Workaround: use a hardcoded IP (e.g., `http://10.0.2.58:4000`). Production fix: enable `enableDnsHostnames` on the VPC, or resolve the IP at Lambda provision time via the ECS/CloudMap API.

**Update (March 25, 2026):** VPC private hosted zone `claw-me.local` has a Route53 A record for `litellm.claw-me.local` pointing to the LiteLLM task IP. ECS Fargate containers in the VPC CAN resolve this name. The DNS issue only affects Lambda (which is NOT in the VPC — `VpcConfig` is null). See below.

### Lambda is NOT in the VPC — cannot resolve private DNS
The provision Lambda has `VpcConfig: null`. It cannot resolve `litellm.claw-me.local` or any other `claw-me.local` private hosted zone record. Error: `ENOTFOUND hostname litellm.claw-me.local`. Fix: always use the public `LITELLM_URL` for Lambda→LiteLLM calls. ECS containers use `LITELLM_INTERNAL_URL` (private DNS) for their API traffic — that works because containers run inside the VPC.

```
Lambda (outside VPC) → https://litellm.claw-me.com  (key generation only)
ECS containers (in VPC) → http://litellm.claw-me.local:4000  (all API calls)
```

Never set `litellmKeygenUrl = LITELLM_INTERNAL_URL || LITELLM_URL` in the Lambda — internal URL won't resolve. Use `LITELLM_URL` directly for key generation.

### LiteLLM master key mismatch causes silent 401s on key generation
The Lambda's `LITELLM_MASTER_KEY` must exactly match the `LITELLM_MASTER_KEY` env var in the LiteLLM ECS task. If they differ, every `/key/generate` request returns `401 Unauthorized`. The Lambda then sets `litellmVirtualKey = ''`, which causes containers to fall back to the raw `OPENAI_API_KEY` — bypassing metering entirely.

The misleading part: the Lambda code logs `"Created LiteLLM virtual key for tenant X"` unconditionally, even when `litellmData.key` comes back empty. The log line fires right after the assignment regardless of its value. **Do not trust this log message — check whether `OPENAI_API_KEY` in the ECS task env is a LiteLLM virtual key (starts with `sk-ucF...` or similar short key) vs the raw OpenAI key (starts with `sk-proj-...`).** If it's the raw key, LiteLLM key generation failed.

Current keys:
- LiteLLM task definition env: `LITELLM_MASTER_KEY=sk-litellm-master-clawme-2026x03x21`
- Lambda env: must match exactly

### `No API key found for provider "openai"` — even with correct OPENAI_API_KEY env var
`openclaw models auth paste-token` is an **interactive TUI** application. It draws a full-screen UI using ANSI escape codes and waits for keyboard input. It cannot be automated via piped stdin, Python pty, `TERM=dumb`, or `pseudoTerminal: true` — it writes nothing to `auth-profiles.json` without real human keyboard interaction.

The correct fix is to **bypass `auth-profiles.json` entirely** by writing `models.providers.openai.apiKey` directly into `openclaw.json`. This works for both the LiteLLM path (uses virtual key + baseUrl) and the direct path (uses raw OpenAI key). The `paste-token` call in `entrypoint.sh` is left in place but runs with `|| true` so failure is non-fatal.

```python
# Both paths must write this into openclaw.json:
config['models'] = {
  'providers': {
    'openai': {
      'apiKey': api_key,   # LiteLLM virtual key OR raw OpenAI key
      'baseUrl': base_url + '/v1',  # only in LiteLLM path
      'models': [...]       # required — omitting this crashes the gateway
    }
  }
}
```

### S3 wrapper-entrypoint.sh is the source of truth for container startup
The ECR image (`:v15`) has an old `entrypoint.sh` that lacks the LiteLLM path, `TENANT_OWNER_EMAILS`, and direct-provider config. The task definition command downloads `wrapper-entrypoint.sh` from S3 and `exec`s it, completely replacing the image's entrypoint:

```bash
aws s3 cp s3://claw-me-config-204128836886/wrapper-entrypoint.sh /tmp/wrapper-entrypoint.sh --region us-east-1 && chmod +x /tmp/wrapper-entrypoint.sh && exec /tmp/wrapper-entrypoint.sh
```

The canonical copy of this file is `docker/entrypoint.sh` in the workspace. Changes there should be synced to S3. To update a running container, upload to S3 and re-provision (stop + Lambda invoke). **When rebuilding the Docker image (`:v16`), bake this file in and remove the S3 download step.**

### OpenClaw internal health check fails with gateway authorization error
The cron-based health check inside the container hits the gateway from `127.0.0.1` without an `X-Forwarded-User` header. In `trusted-proxy` mode, this gets rejected. Fix: include `127.0.0.1/8` in the `trustedProxies` array in `openclaw.json`. Requests from loopback are then trusted without needing the proxy header. Task def `:46` applies this as a runtime patch via entrypoint override.

### OpenClaw config validation: `models` array required
When configuring `models.providers.openai` in `openclaw.json`, the `models` array is **required** by OpenClaw's schema validation. Omitting it produces: `models.providers.openai.models: Invalid input: expected array, received undefined`. Each model entry needs at least `id`, `name`, `contextWindow`, and `maxTokens`.

### Docker image wrong architecture — ARM on Fargate
Building on Apple Silicon (M-series Mac) produces an ARM image by default. Fargate requires `linux/amd64`. Error: `image Manifest does not contain descriptor matching platform 'linux/amd64'`. Fix: always pass `--platform linux/amd64` to `docker build`. All `build-vN.sh` scripts include this flag.

### Lambda SUBNET_IDS formatting
The `SUBNET_IDS` env var must use commas (`,`) not colons (`:`) between subnet IDs. The Lambda splits on commas (`process.env.SUBNET_IDS.split(',')`) when creating the Fargate task. Using colons produces `InvalidSubnetID.NotFound` because AWS receives the entire colon-delimited string as one subnet ID. Be careful when using the AWS CLI `--environment` shorthand, which also uses commas as delimiters — quote the value or use JSON format.

### `{"error":"Internal server error"}` on login (both Google and password flows)
`claw-auth` queries `SELECT endpoint_url, dashboard_url FROM instances` during the post-auth redirect. If the `dashboard_url` column doesn't exist in Supabase, Supabase returns a 400 error, which `claw-auth` catches and returns as "Internal server error". Fix: ensure the column exists:
```sql
ALTER TABLE instances ADD COLUMN IF NOT EXISTS dashboard_url TEXT;
```

### OpenClaw model picker only shows models from its internal registry — custom IDs are silently ignored
OpenClaw's model picker dropdown is NOT driven by `agents.defaults.models` or `models.providers.openai.models` in `openclaw.json`. It filters entries against its own internal model registry. Only recognised OpenAI model IDs (e.g. `gpt-4.1-mini`, `gpt-4.1`) appear. Custom IDs like `nova-lite`, `nova-pro`, `claude-haiku-bedrock` are silently ignored — they never show in the UI even if explicitly listed in the config.

Consequence: Bedrock and other custom LiteLLM-registered models are technically accessible (LiteLLM can route to them) but cannot be selected via the picker. The `agents.defaults.models` dict is used for display aliases only for models OpenClaw already recognises.

Workaround for Bedrock: route Bedrock behind a recognised model ID at the LiteLLM layer (e.g. register `nova-lite` as the backend for `gpt-4.1-mini`). This is transparent to OpenClaw but hides which model is actually running. Do not do this without making the mapping clear to tenants.

### OpenClaw falls back from unrecognised primary model — bypasses LiteLLM baseUrl
If `agents.defaults.model.primary` is set to a model ID that OpenClaw does not recognise (e.g. `openai/nova-lite`), OpenClaw falls back to its own internal default (`openai/gpt-4.1-mini`) using a **different code path** that ignores `models.providers.openai.baseUrl`. The request goes directly to `api.openai.com` with whatever API key is in the config — which, when that key is a LiteLLM virtual key (`sk-v6caE...`), produces a 401 from OpenAI:

```
401 Incorrect API key provided: sk-v6caE*****. You can find your API key at https://platform.openai.com/account/api-keys.
```

**Fix: `primary` must always be a model ID that OpenClaw recognises.** Currently the only safe values are `openai/gpt-4.1-mini` and `openai/gpt-4.1`. Never set primary to a Bedrock or custom model ID.

```python
# ✓ CORRECT — OpenClaw recognises this and routes through baseUrl
primary = 'openai/gpt-4.1-mini'

# ✗ WRONG — OpenClaw doesn't recognise this, falls back, bypasses baseUrl, 401 from OpenAI
primary = 'openai/nova-lite'
```

### LiteLLM alias collision on re-provision — `key_alias already exists`
LiteLLM enforces unique `key_alias` across all keys. On every re-provision of the same tenant, `key/generate` with `key_alias: tenant-{id}` fails with:
```json
{"error": {"message": "Key with alias 'tenant-bac670a1' already exists."}}
```
The Lambda silently sets `litellmVirtualKey = ''` and falls back to the raw OpenAI key, bypassing LiteLLM entirely. Fix: on "already exists" error, fetch all keys matching the alias via `GET /key/list?key_alias=tenant-{id}`, delete them via `POST /key/delete`, then create fresh. The `keys` array in `/key/list` contains hashed key IDs — these are accepted by `/key/delete`. The actual virtual key (`sk-...`) is never returned after creation; always delete-and-recreate rather than trying to retrieve and reuse.

### `dashboard_url` is NULL after provisioning — "Stored dashboard URL in Supabase" is a lie
`entrypoint.sh` stores the tokenized URL with:
```bash
curl -s -X PATCH ... > /dev/null 2>&1 && echo "Stored dashboard URL in Supabase" || echo "Warning: ..."
```
`curl` exits 0 even on HTTP 4xx/5xx errors, so the success message always prints regardless of whether Supabase actually accepted the write. If `dashboard_url` is still NULL after the container starts, it means the Supabase PATCH returned an error (e.g., column didn't exist yet). Recovery: read the tokenized URL from CloudWatch logs (look for "Tokenized dashboard URL: https://...") and PATCH Supabase manually:
```bash
curl -X PATCH "https://xfklynglppislmdhjtut.supabase.co/rest/v1/instances?tenant_id=eq.{TENANT_ID}" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dashboard_url": "https://tenant-XXXX.claw-me.com/#token=..."}'
```

### ECS Exec output not captured in bash scripts
`aws ecs execute-command --interactive --command "..."` sends output through the SSM Session Manager channel — not to bash stdout. The exit code is 0 and bash receives no output. To inspect container state, write output to a file inside the container with one command, then read it with a second. Better yet: read from CloudWatch Logs, which captures all container stdout/stderr. The CloudWatch log stream name matches the ECS task ID: `openclaw/openclaw/{TASK_ID}`.

The Session Manager plugin must be installed for ECS Exec to work at all:
```bash
# macOS
brew install --cask session-manager-plugin

# Linux (no sudo available)
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o /tmp/ssm.deb
dpkg -x /tmp/ssm.deb /tmp/ssm-plugin
cp /tmp/ssm-plugin/usr/local/sessionmanagerplugin/bin/session-manager-plugin ~/.local/bin/
chmod +x ~/.local/bin/session-manager-plugin
```

### `openclaw dashboard --no-open` must NOT run while the gateway is live
This command modifies `gateway.auth.token` in `openclaw.json`. The gateway file-watches its config and performs a full process restart on any change — wiping all device state including the tokenized URL credential. Always run `openclaw dashboard --no-open` in `entrypoint.sh` before `exec openclaw gateway`, never via ECS Exec on a running container. If you need the tokenized URL from a running container, read it from CloudWatch startup logs instead.

### Tenants stuck as "pending" despite running instances
EventBridge or Lambda errored during provisioning and never flipped the status. Fix with SQL:
```sql
UPDATE tenants SET status = 'active'
WHERE status = 'pending'
AND id IN (SELECT tenant_id FROM instances WHERE status = 'running');
```

### Admin portal showing "—" for endpoint/ARN columns
Column names in the query were wrong. Correct names: `endpoint_url` (not `endpoint`), `ecs_task_arn` (not `task_arn`).

### Channels flash then disappear on tenant channels page
Channels configured with `enabled: false` in `openclaw.json` are briefly rendered by the dashboard, then hidden after the `channels.status` WebSocket response confirms they're disabled. Fix: set all channels to `enabled: true` — even those without tokens configured yet. The dashboard will show them as "not connected" but keep them visible so tenants can configure tokens from the UI.

### `sed` entrypoint overrides break channel config (task defs :46–:50)
Task definitions using `sed` to patch entrypoint.sh at runtime are fragile. The WhatsApp `sed` patch replaced the Telegram line instead of appending after it, causing Telegram to vanish from the channels page. Fix: build a new Docker image (v13) with all config baked into entrypoint.sh and use a clean task definition without any overrides. Never use `sed` entrypoint overrides for multi-line config changes.

### WhatsApp 401 Unauthorized after QR scan
WhatsApp QR generates and displays, tenant-side shows "linked", but WhatsApp servers reject the encrypted session with 401 across multiple DCs. Auto-retry loop (10 attempts with exponential backoff) all fail. Possible causes: (1) headless Chromium detection by WhatsApp, (2) GC pressure corrupting Noise Protocol crypto ops (Curve25519, AES-GCM, HKDF), (3) insufficient memory for the WhatsApp Web bridge. Memory was increased to 4GB to rule out (3). Still under investigation.

### JavaScript heap out of memory (OOM) in tenant container
WhatsApp Web bridge + headless Chromium spawns three Node.js processes (`openclaw-models`, `openclaw-dashboard`, `openclaw-gateway`) each hitting ~505MB. With only 1GB container memory, all three crash. Fix: increase to 4GB minimum (2048 CPU / 4096 memory). Update both the task definition AND the Lambda `PLAN_RESOURCES` — the Lambda's container overrides take precedence over task def defaults.

### "Secret scheduled for deletion" on re-provision
AWS Secrets Manager has a 7-day recovery window. If you deprovision and immediately re-provision the same tenant, catch `InvalidRequestException` and call `RestoreSecretCommand` before `UpdateSecretCommand`.

---

## Pending / Next Steps

### Completed
- [x] **LiteLLM end-to-end metering** — virtual keys created per tenant, spend tracked in `litellm_spendlogs`, verified via `/global/spend/keys` endpoint (March 22, 2026)
- [x] **Lambda deployed** with LiteLLM virtual key creation + `LITELLM_INTERNAL_URL` support
- [x] **OpenClaw LiteLLM provider config** — `models.providers.openai` with baseUrl, apiKey, and models array
- [x] **trustedProxies localhost fix** — `127.0.0.1/8` added so internal health checks pass
- [x] **Docker image v13 built and deployed** — all fixes baked in, clean task def `:51` (no sed overrides), 2048 CPU / 4096 memory
- [x] **4-channel support** — Telegram, WhatsApp, Discord, Slack all `enabled: true` in `openclaw.json`. Tenants configure tokens from the dashboard UI.
- [x] **Container memory increased to 4GB** — required for WhatsApp Web bridge (headless Chromium + Baileys crypto ops). `PLAN_RESOURCES` in Lambda aligned at 2048/4096 for all plans.
- [x] **Channels page fix** — channels with `enabled: false` flash then disappear. Set all to `true` so they persist on the page.
- [x] **Dual-layer tenant security** — Cloudflare Worker (`tenant-guard`) at edge + container auth proxy (`auth-proxy.py`) for defense in depth
- [x] **Tenant login gateway** — `claw-me.com/login/` page + `claw-auth` Worker with Google OAuth + password/MFA, JWT session cookies
- [x] **Landing page early access buttons** — "Early Access Login" in top nav + mid-page "Log in to your claw-me instance" button
- [x] **Docker image v15 built and deployed** — includes auth-proxy.py, updated entrypoint with owner email fetch, tokenized dashboard URL generation, task def `:53`
- [x] **Old Transform Rule removed** — deleted "Inject user header for OpenClaw" (static `X-Forwarded-User: user` header)
- [x] **`dashboard_url` column** added to `instances` table in Supabase
- [x] **tenant-guard dual-header injection** — injects both `X-Forwarded-User` and `Cf-Access-Authenticated-User-Email` for backward compatibility
- [x] **Welcome email login URL** — includes `?instance=` and `?email=` params to pre-fill login form
- [x] **End-to-end flow verified** — Stripe checkout → n8n → Lambda provision → welcome email → login → tokenized dashboard URL → OpenClaw (March 24, 2026)
- [x] **All code pushed to GitHub** — Worker, auth proxy, login page, landing page, Docker changes
- [x] **LiteLLM master key mismatch fixed** — Lambda `LITELLM_MASTER_KEY` now matches LiteLLM task def. Virtual key creation confirmed working (March 25, 2026)
- [x] **Metering end-to-end working** — Lambda creates LiteLLM virtual key via public URL → passes to ECS container as `OPENAI_API_KEY` + `OPENAI_API_BASE=http://litellm.claw-me.local:4000` → container uses VPC-internal route for all API traffic (March 25, 2026)
- [x] **Direct-path fallback fixed** — `entrypoint.sh` direct path (no LiteLLM) now writes `models.providers.openai.apiKey` into `openclaw.json`, bypassing `auth-profiles.json` and the non-automatable `paste-token` TUI (March 25, 2026)
- [x] **S3 wrapper-entrypoint.sh updated** — `docker/entrypoint.sh` is the source of truth; synced to `s3://claw-me-config-204128836886/wrapper-entrypoint.sh`

### Infrastructure — High Priority
- [ ] **Rebuild Docker image to `:v16`** — bake `docker/entrypoint.sh` into the image so the S3 download step in the task command is no longer needed. Requires Docker on Mac: `bash docker/build-v16.sh && bash docker/push-v16.sh`
- [ ] **Fix service discovery DNS** — Lambda resolves using public URL (works), but LiteLLM task IP is hardcoded in Route53 A record. If LiteLLM task restarts, its IP changes and the A record goes stale. Options: (1) add internal NLB in front of LiteLLM (~$16/mo, stable IP), (2) update Route53 A record in Lambda after each LiteLLM task start via EventBridge, (3) use ECS service with static private IP
- [ ] **Add UNIQUE constraints** on LiteLLM daily spend tables — prevents duplicate aggregation rows. See `litellm/fix-missing-columns.sql` for reference.
- [ ] **WhatsApp 401 Unauthorized on QR peering** — QR generates and scans, but WhatsApp servers reject the encrypted session. May be headless Chromium detection or memory pressure during Noise Protocol handshake. Under investigation.
- [ ] **Reprovision existing tenants with v15 image** — old containers use `X-Forwarded-User`; new containers use `Cf-Access-Authenticated-User-Email`. Both work now (tenant-guard injects both), but reprovisioning cleans up the inconsistency.
- [ ] **Fix `dashboard_url` PATCH verification** — entrypoint.sh logs "Stored dashboard URL in Supabase" even when the PATCH fails (curl exits 0 on HTTP errors). Add `-f` flag to curl or check HTTP response code.

### Features — Medium Priority
- [ ] **Surface `dashboard_url`** as a "Launch Dashboard" button in the admin portal
- [x] **Protect admin portal** — `admin-guard` Worker on `claw-me.com/admin/*`; JWT + `ADMIN_EMAILS` check; deploy with `wrangler-admin.toml`
- [ ] **Customer self-service portal** — tenant login, instance status, credentials, launch dashboard button
- [ ] **Additional channels** — Signal, Microsoft Teams, LINE, Mattermost available in OpenClaw. Enable as tenant demand requires.
- [ ] **Fix login page logo** — SVG logo shows alt text instead of rendering on the `/login/` page

### Integrations — Lower Priority
- [ ] **n8n Flow 3** — usage alerts (email at 80% of plan limit, query `litellm_spendlogs`)
- [ ] **n8n Flow 4** — health checks (ping each ECS task every 5 min, restart on failure)
- [ ] **Auto-deprovision** on Stripe `customer.subscription.deleted` webhook
- [ ] **Langfuse integration** — add `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` to LiteLLM task env, uncomment callbacks in `litellm_config.yaml`
