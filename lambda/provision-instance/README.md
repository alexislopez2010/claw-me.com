# lambda/provision-instance — Tenant Lifecycle Lambda

## Purpose

Handles tenant provisioning, deprovisioning, and status queries for the claw-me.com multi-tenant SaaS platform. Also processes EventBridge ECS Task State Change events.

## Endpoints (via API Gateway)

| Action | Method | Description |
|--------|--------|-------------|
| `provision` | POST | Creates Secrets Manager secret, ALB target group + rule, LiteLLM virtual key, runs ECS Fargate task |
| `deprovision` | POST | Stops ECS task, deletes ALB rule + TG, schedules secret deletion, updates Supabase |
| `status` | POST | Reads instance status from Supabase |
| EventBridge | Auto | Updates Supabase on ECS task state changes (RUNNING → running, STOPPED → stopped) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ECS_TASK_DEFINITION` | Task def family:revision (e.g., `openclaw-task:53`) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `SUBNET_IDS` | Comma-separated subnet IDs (**must use commas, not colons**) |
| `SECURITY_GROUP_ID` | VPC security group |
| `VPC_ID` | VPC ID |
| `ALB_LISTENER_ARN` | HTTPS listener ARN |
| `BASE_DOMAIN` | `claw-me.com` |
| `LITELLM_URL` | Public LiteLLM URL (used by Lambda for `/key/generate`) |
| `LITELLM_INTERNAL_URL` | VPC-internal LiteLLM URL (passed to containers as `OPENAI_API_BASE`) |
| `LITELLM_MASTER_KEY` | LiteLLM admin key |
| `OPENAI_API_KEY` | Real OpenAI key (fallback when LiteLLM unavailable) |

## LiteLLM Metering Flow

1. Lambda calls `LITELLM_URL/key/generate` → creates per-tenant virtual key with monthly budget
2. Virtual key injected as `OPENAI_API_KEY` in ECS task container override
3. `LITELLM_INTERNAL_URL` (or fallback `LITELLM_URL`) injected as `OPENAI_API_BASE`
4. OpenClaw routes all LLM requests through LiteLLM → spend tracked per virtual key

**Critical:** Container-to-container traffic MUST use `LITELLM_INTERNAL_URL` (VPC-internal). The public domain (`litellm.claw-me.com`) is proxied by Cloudflare which blocks non-browser traffic with 403.

## Deploy

```bash
cd lambda/provision-instance
npm install
zip -r function.zip .
aws lambda update-function-code \
  --function-name claw-me-provision-instance \
  --zip-file fileb://function.zip \
  --region us-east-1
```

## Per-Plan Budget Caps

| Plan | Monthly Budget |
|------|---------------|
| Starter | $10 |
| Pro | $50 |
| Enterprise | No limit |

## Resource Allocation

All plans currently use the same resources (WhatsApp Web bridge + headless Chromium needs headroom):

| Plan | CPU | Memory | Notes |
|------|-----|--------|-------|
| Starter | 2048 (2 vCPU) | 4096 (4 GB) | WhatsApp crypto ops need GC headroom |
| Pro | 2048 | 4096 | |
| Enterprise | 2048 | 4096 | |

**Important:** The Lambda's `PLAN_RESOURCES` container overrides take precedence over the task definition's CPU/memory defaults. Both must be aligned.

## Key Code Sections

- **Lines 76-80:** `PLAN_RESOURCES` — CPU/memory per plan (container overrides take precedence over task def)
- **Lines 220-242:** LiteLLM virtual key creation with `models` array (required by OpenClaw schema validation)
- **Lines 245-289:** ECS RunTask with container overrides injecting all env vars
- **Line 270:** `OPENAI_API_BASE` uses `LITELLM_INTERNAL_URL` with fallback to `LITELLM_URL`
