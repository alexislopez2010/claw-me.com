# docker/ — OpenClaw Tenant Container

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Ubuntu 22.04 base, installs AWS CLI v2, OpenClaw, copies entrypoint.sh + auth-proxy.py. Uses `tini` as PID 1. |
| `entrypoint.sh` | Container startup script — pulls secrets, configures OpenClaw, registers with ALB, fetches owner emails, starts auth proxy + gateway. |
| `auth-proxy.py` | Container-level auth proxy (Layer 2) — validates `Cf-Access-Authenticated-User-Email` against tenant owner/member emails before forwarding to OpenClaw. |
| `build-v15.sh` | Builds and pushes `:v15` image with dual-layer auth. Requires Docker + `--platform linux/amd64`. |
| `deploy-v15.sh` | Registers task def + updates Lambda. Reads secrets from env vars (not hardcoded). |
| `build-v14.sh` | (Legacy) Builds `:v14` — Cloudflare Access header but no auth proxy. |
| `deploy-v14.sh` | (Legacy) Registers task def for v14. |
| `build-v13.sh` | (Legacy) Builds `:v13` — all fixes baked in but no Cloudflare Access or auth proxy. |
| `deploy-v13.sh` | (Legacy) Registers task def for v13. **Contains hardcoded secrets — do not commit publicly.** |
| `build-v12.sh` | (Legacy) Missing WhatsApp channels and trustedProxies fix. |
| `deploy-v12.sh` | (Legacy) **Contains secrets.** |
| `openclaw.json.template` | Legacy template (superseded by Python config generation in entrypoint.sh). |

## Current State (March 25, 2026)

- **ECR image:** `:v15` — dual-layer tenant security (Cloudflare Worker + container auth proxy)
- **Task definition:** `openclaw-task:54` (2048 CPU / 4096 memory) — wrapper that calls `paste-token` before entrypoint.sh
- **Lambda:** `claw-me-provision-instance` points to `:54`
- **Auth headers:** `Cf-Access-Authenticated-User-Email` AND `X-Forwarded-User` — both injected by `tenant-guard` Worker for backward compat with old/new containers
- **Auth proxy:** `auth-proxy.py` on port 18789 → OpenClaw on port 18790 (in updated entrypoint; old ECR `:v15` image may not start it)
- **Post-login redirect:** `claw-auth` Worker redirects to `instances.dashboard_url` (tokenized URL with `#token=`) after successful login
- **Channels:** Telegram, WhatsApp, Discord, Slack — all `enabled: true`, tenants configure tokens from dashboard
- **Legacy:** `:v12`/`:v13`/`:v14` images and task defs `:46`–`:53` are deprecated.

### Task Definition History

| Task Def | Image | Notes |
|----------|-------|-------|
| `:53` | `:v15` (old) | Missing `paste-token` in entrypoint — OpenAI API key not written to auth-profiles.json |
| `:54` | `:v15` (old) | **Current** — wrapper downloads `s3://claw-me-config-204128836886/wrapper-entrypoint.sh`, runs paste-token, then calls entrypoint.sh |
| _`:55`_ | _`:v16` (pending)_ | _Rebuild Docker image with updated entrypoint.sh (paste-token + TENANT_OWNER_EMAILS + all channels) — requires Docker on Mac_ |

### Deploying Updates

```bash
cd docker
bash build-v15.sh    # Build & push image (requires Docker — run from Mac)

# Set secrets as env vars first:
export SUPABASE_SERVICE_KEY="sb_secret_..."
export OPENAI_API_KEY="sk-proj-..."
export LITELLM_MASTER_KEY="sk-litellm-..."
bash deploy-v15.sh   # Register task def + update Lambda

# Then deprovision/reprovision tenants to pick up the new image
```

## Quick Commands

```bash
# Build and push (from Mac with Docker)
cd docker && bash build-v15.sh

# Register task def + update Lambda
bash deploy-v15.sh

# View tenant container logs
aws logs tail /ecs/openclaw --since 10m --follow --region us-east-1

# Shell into a running container
aws ecs execute-command --cluster claw-me-cluster-use1 --region us-east-1 \
  --task <TASK_ID> --container openclaw --interactive --command '/bin/bash'
```

## How entrypoint.sh Works (v15)

1. Pulls config from AWS Secrets Manager (`openclaw/tenants/{tenantId}`)
2. Preserves Lambda-injected `OPENAI_API_KEY` when LiteLLM is active (does NOT overwrite with empty SM value)
3. Generates gateway token if not in secret
4. Gets private IP from ECS metadata → registers with ALB target group
5. Updates Secrets Manager and Supabase with token + endpoint
6. Writes `~/.openclaw/openclaw.json` via Python (two paths: LiteLLM or direct)
7. Runs `openclaw models auth paste-token --provider openai` (BEFORE gateway starts)
8. **Fetches tenant owner/member emails from Supabase** → sets `TENANT_OWNER_EMAILS`
9. Generates tokenized dashboard URL → stores in Supabase
10. **If owner emails found:** starts `auth-proxy.py` on :18789 → `exec openclaw gateway --port 18790`
11. **If no owner emails:** `exec openclaw gateway --port 18789` (backward compatible)

## Dual-Layer Tenant Security

### Layer 1: Cloudflare Worker (Edge)
The `tenant-guard` Worker (in `cloudflare-worker/`) validates tenant ownership at the edge before traffic reaches the container. See `cloudflare-worker/tenant-guard.js`.

### Layer 2: Container Auth Proxy
`auth-proxy.py` runs inside the container as a second line of defense:
- Listens on port 18789 (public-facing)
- Validates `Cf-Access-Authenticated-User-Email` against `TENANT_OWNER_EMAILS`
- Forwards authorized requests to OpenClaw on port 18790
- Health check paths (`/health`, `/healthz`, `/ready`, `/api/health`) pass through
- If no owner emails configured, passes through (fail open for initial setup)
- Returns branded 403 page on denial

## LiteLLM Config Path

When `OPENAI_API_BASE` is set, the config includes:
- `models.providers.openai.baseUrl` → LiteLLM internal URL + `/v1`
- `models.providers.openai.apiKey` → LiteLLM virtual key
- `models.providers.openai.models` → **REQUIRED array** of model definitions (gpt-4.1-mini, gpt-4.1)
- `gateway.auth.trustedProxy.userHeader` → `Cf-Access-Authenticated-User-Email`
- `gateway.trustedProxies` → includes `127.0.0.1/8` for internal health checks
- `channels` → Telegram, WhatsApp, Discord, Slack (all `enabled: true`, empty tokens for tenant self-configuration)

## Known Issues

- **CloudMap DNS may not resolve** from standalone Fargate tasks. Lambda uses `LITELLM_INTERNAL_URL` but this may time out. Hardcoded IP works as fallback.
- **Cloudflare blocks container-to-container traffic** via public domain. NEVER use `https://litellm.claw-me.com` as `OPENAI_API_BASE`.
- **v12 sed overrides break channels page.** Task defs `:46`–`:50` use entrypoint `sed` patches. The WhatsApp sed replaces the Telegram line instead of appending. **Fix: use :54.**
- **WhatsApp 401 Unauthorized on QR peering.** Under investigation.
- **`trusted_proxy_user_missing` for CLI health checks.** Internal cron health check fails because CLI doesn't send the email header. Cosmetic — gateway still works for webchat clients.
- **`dashboard_url` PATCH silently fails.** `entrypoint.sh` logs "Stored dashboard URL in Supabase" regardless of HTTP response code (curl exits 0 on 4xx/5xx). If `dashboard_url` is NULL after provisioning, read the tokenized URL from CloudWatch logs and PATCH Supabase manually. See ARCHITECTURE.md troubleshooting section.
- **Old containers use `X-Forwarded-User`.** Containers built from v14 and earlier images configure `trustedProxy.userHeader: "X-Forwarded-User"` instead of `Cf-Access-Authenticated-User-Email`. The `tenant-guard` Worker now injects both headers, so all container generations work without rebuilding.
- **ECR `:v15` image missing `paste-token` step.** The ECR image in production was built before `paste-token` was added to `entrypoint.sh`. Containers started from the old image don't write `auth-profiles.json`, so OpenAI API calls fail with "No API key found". **Fix applied:** task def `:54` uses a wrapper that downloads `s3://claw-me-config-204128836886/wrapper-entrypoint.sh` and calls `paste-token` before `entrypoint.sh`. **Permanent fix:** rebuild Docker image (requires Mac) — the local `entrypoint.sh` has the correct `paste-token` step.
- **ECS Exec requires a real TTY.** `aws ecs execute-command --interactive` does not work in headless environments (no TTY). The `ExecuteCommandAgent` appears RUNNING but no SSM session is ever established. Workaround: run operations via task def overrides (see Task Definition History above).
