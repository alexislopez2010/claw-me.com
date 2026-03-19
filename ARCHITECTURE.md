# claw-me.com — Multi-Tenant Management Portal Architecture

## Recommended Stack (No-Code / Low-Code on AWS)

| Layer | Tool | Why |
|---|---|---|
| Database + Auth | **Supabase** | Postgres + Row Level Security = multi-tenancy built-in |
| Admin Portal | **Retool** | Drag-and-drop internal dashboards, connects to Supabase + AWS |
| Client Portal | **Retool (External)** | Retool's "Apps for external users" covers the self-service dashboard |
| Instance Orchestration | **AWS ECS Fargate** | Each OpenClaw instance = isolated container, serverless scaling |
| Provisioning API | **AWS Lambda + API Gateway** | Serverless endpoints to spin up/down instances |
| Billing | **Stripe** | Subscriptions, usage billing, webhooks back to Supabase |
| Automation Glue | **n8n (self-hosted on AWS)** | Connects Stripe → Supabase → ECS provisioning automatically |
| Secrets per tenant | **AWS Secrets Manager** | Encrypted API keys/tokens per client instance |
| Monitoring | **AWS CloudWatch + Supabase Edge Functions** | Usage tracking per tenant |

---

## System Architecture Overview

```
                          ┌─────────────────────────────┐
                          │        claw-me.com          │
                          │    (GitHub Pages / CDN)     │
                          └──────────┬──────────────────┘
                                     │ signs up / pays
                          ┌──────────▼──────────────────┐
                          │         Stripe               │
                          │  (subscriptions + billing)   │
                          └──────────┬──────────────────┘
                                     │ webhook: payment succeeded
                          ┌──────────▼──────────────────┐
                          │      n8n (automation)        │
                          │  Stripe → provision tenant   │
                          └──────┬────────────┬─────────┘
                                 │            │
               ┌─────────────────▼──┐  ┌─────▼──────────────────┐
               │  Supabase           │  │  AWS Lambda             │
               │  - tenants table    │  │  Provisioning API       │
               │  - instances table  │  │  POST /provision        │
               │  - users table      │  │  DELETE /deprovision    │
               │  - usage table      │  │  GET /status            │
               │  - Row Level Sec.   │  └─────┬──────────────────┘
               └─────────┬──────────┘        │ creates
                         │                   │
               ┌──────── ▼──────────┐  ┌────▼───────────────────┐
               │  Retool             │  │  AWS ECS Fargate        │
               │  Admin Portal       │  │  ┌─────────────────┐   │
               │  - manage tenants   │  │  │ tenant-001 🦞   │   │
               │  - view usage       │  │  │ openclaw:latest │   │
               │  - billing overview │  │  └─────────────────┘   │
               │                     │  │  ┌─────────────────┐   │
               │  Client Portal      │  │  │ tenant-002 🦞   │   │
               │  - instance status  │  │  │ openclaw:latest │   │
               │  - connect tools    │  │  └─────────────────┘   │
               │  - usage dashboard  │  │  ┌─────────────────┐   │
               │  - manage account   │  │  │ tenant-N 🦞     │   │
               └─────────────────────┘  │  │ openclaw:latest │   │
                                        │  └─────────────────┘   │
                                        └────────────────────────┘
```

---

## Database Schema (Supabase / Postgres)

### `tenants`
```sql
id            uuid primary key
name          text
email         text unique
plan          text  -- 'starter' | 'pro' | 'enterprise'
status        text  -- 'active' | 'suspended' | 'cancelled'
stripe_id     text  -- Stripe customer ID
created_at    timestamptz
```

### `instances`
```sql
id            uuid primary key
tenant_id     uuid references tenants(id)
ecs_task_arn  text  -- AWS ECS task ARN
endpoint_url  text  -- https://tenant-001.claw-me.com
region        text  -- e.g. us-east-1
status        text  -- 'provisioning' | 'running' | 'stopped' | 'error'
created_at    timestamptz
updated_at    timestamptz
```

### `users`
```sql
id            uuid primary key  -- matches Supabase auth.users
tenant_id     uuid references tenants(id)
email         text
role          text  -- 'owner' | 'member' | 'viewer'
created_at    timestamptz
```

### `usage`
```sql
id            uuid primary key
tenant_id     uuid references tenants(id)
period_start  date
period_end    date
tasks_run     int
tokens_used   bigint
integrations  jsonb
```

### Row Level Security (the multi-tenancy magic)
```sql
-- Users can only see their own tenant's data
ALTER TABLE instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON instances
  USING (tenant_id = auth.jwt() -> 'tenant_id');
```

---

## Phase 1 — Foundation (Week 1–2)

**Goal:** Tenants can sign up, pay, and get a running OpenClaw instance.

- [ ] Set up Supabase project — create schema above
- [ ] Create Stripe products: Starter ($29), Pro ($99), Enterprise
- [ ] Build n8n workflow: Stripe `payment_intent.succeeded` → insert tenant row → call Lambda
- [ ] Write Lambda function `provision-instance`:
  - Registers new tenant in `instances` table
  - Spins up ECS Fargate task from `openclaw:latest` image
  - Stores per-tenant secrets in AWS Secrets Manager
  - Updates instance status to `running`
- [ ] Containerize OpenClaw → push to Amazon ECR
- [ ] Map tenant subdomain: `tenant-{id}.claw-me.com` → ECS task IP (via Route53)

---

## Phase 2 — Admin Portal (Week 2–3)

**Goal:** You can see and manage all tenants from one dashboard.

Build in **Retool** (internal app):

- [ ] **Tenants table** — list all, filter by plan/status, click to drill in
- [ ] **Tenant detail** — instance status, usage stats, Stripe billing link
- [ ] **Provision button** — manually trigger Lambda for a tenant
- [ ] **Suspend / Resume** — stop/start ECS task, update status in Supabase
- [ ] **Usage overview** — chart of tasks_run and tokens_used across all tenants
- [ ] **Logs viewer** — pull CloudWatch logs for a specific tenant's container

---

## Phase 3 — Client Portal (Week 3–4)

**Goal:** Each client can log in and manage their own claw.

Build in **Retool (External Apps)** — published under `app.claw-me.com`:

- [ ] **Login / signup** — Supabase Auth (magic link or Google OAuth)
- [ ] **Dashboard** — instance status (green/red pill), uptime, last activity
- [ ] **Integrations** — list connected tools, OAuth connect/disconnect buttons
- [ ] **Usage** — tasks run this month, token usage chart, vs. plan limit
- [ ] **Settings** — change display name, update notification preferences
- [ ] **Billing** — Stripe Customer Portal link (manage plan, cancel, invoices)
- [ ] **Chat shortcut** — deep link to their OpenClaw web interface

---

## Phase 4 — Automation & Polish (Week 4+)

- [ ] **Auto-deprovision** on Stripe `customer.subscription.deleted` webhook
- [ ] **Usage alerts** — n8n workflow emails client at 80% of plan limit
- [ ] **Onboarding flow** — post-signup wizard in client portal (connect first tool)
- [ ] **Health checks** — Lambda pings each ECS task every 5 min, updates status
- [ ] **Auto-restart** — if health check fails 3x, restart the ECS task + alert you
- [ ] **Upgrade prompts** — in-portal nudge when client hits 90% usage

---

## Provisioning Lambda (pseudo-code)

```javascript
// provision-instance/index.js
exports.handler = async (event) => {
  const { tenantId, plan } = JSON.parse(event.body);

  // 1. Define CPU/memory by plan
  const resources = {
    starter:    { cpu: 512,  memory: 1024 },
    pro:        { cpu: 1024, memory: 2048 },
    enterprise: { cpu: 2048, memory: 4096 },
  }[plan];

  // 2. Store tenant secrets in AWS Secrets Manager
  await secretsManager.createSecret({
    Name: `openclaw/${tenantId}`,
    SecretString: JSON.stringify({ tenantId, apiKeys: {} }),
  });

  // 3. Run ECS Fargate task
  const task = await ecs.runTask({
    cluster: 'claw-me-cluster',
    taskDefinition: 'openclaw-task',
    launchType: 'FARGATE',
    overrides: {
      containerOverrides: [{
        name: 'openclaw',
        environment: [
          { name: 'TENANT_ID', value: tenantId },
          { name: 'PLAN',      value: plan },
        ],
      }],
    },
    networkConfiguration: { /* VPC config */ },
  });

  // 4. Update Supabase instance record
  await supabase.from('instances').upsert({
    tenant_id:    tenantId,
    ecs_task_arn: task.tasks[0].taskArn,
    status:       'provisioning',
  });

  return { statusCode: 200, body: JSON.stringify({ taskArn: task.tasks[0].taskArn }) };
};
```

---

## n8n Automation Flows

### Flow 1: New Customer → Provision Instance
```
Stripe Webhook (payment_intent.succeeded)
  → Extract customer email + plan
  → Supabase: INSERT tenant record
  → HTTP: POST /provision-instance (Lambda)
  → Wait for status = 'running' (poll Supabase)
  → Send welcome email with instance URL
```

### Flow 2: Cancellation → Deprovision
```
Stripe Webhook (customer.subscription.deleted)
  → Supabase: get tenant's ECS task ARN
  → AWS ECS: stopTask(taskArn)
  → Supabase: UPDATE instance status = 'stopped'
  → Send cancellation confirmation email
```

### Flow 3: Usage Alert
```
Schedule: every hour
  → Supabase: query tenants near plan limit (>80%)
  → For each: send email "You're at X% of your plan"
  → Log alert sent (avoid duplicate emails)
```

---

## Cost Estimate (at 100 tenants)

| Service | Cost/mo (est.) |
|---|---|
| AWS ECS Fargate (100 tasks, 0.5 vCPU ea.) | ~$180 |
| AWS Lambda (provisioning API) | ~$5 |
| AWS Secrets Manager (100 secrets) | ~$4 |
| Supabase Pro | $25 |
| Retool (up to 5 users) | $0–$50 |
| n8n (self-hosted on t3.small) | ~$15 |
| **Total infra** | **~$280/mo** |
| **Revenue at 100 × $29** | **$2,900/mo** |

---

## Quick Start — What to Do First

1. **Today:** Create Supabase project at supabase.com, run the schema SQL above
2. **Day 2:** Set up Stripe, create the 3 products, configure webhook endpoint
3. **Day 3:** Install n8n on a free AWS EC2 t3.micro, build Flow 1
4. **Day 4:** Push OpenClaw Docker image to Amazon ECR, create ECS cluster + task definition
5. **Day 5:** Write and deploy the provision-instance Lambda
6. **Week 2:** Build Retool admin portal (3–4 hours once data is in Supabase)
7. **Week 3:** Build Retool client portal, publish under app.claw-me.com
