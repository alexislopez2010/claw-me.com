/**
 * claw-me.com — Provision Instance Lambda
 *
 * Triggered by: n8n automation (POST) after Stripe payment confirmed
 *               Admin portal (POST /provision, /deprovision, /status)
 *               AWS EventBridge on ECS Task State Change
 *
 * Current state (March 22, 2026):
 *   ECS_TASK_DEFINITION  = openclaw-task:51  (v13 image, clean — no sed overrides)
 *   PLAN_RESOURCES       = 2048 CPU / 4096 memory for all plans
 *   Docker image          = :v13 with 4-channel support (Telegram, WhatsApp, Discord, Slack)
 *
 * Environment variables:
 *   ECS_TASK_DEFINITION  = openclaw-task:51 (current revision)
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = service role key
 *   SUBNET_IDS           = subnet-aaa,subnet-bbb  (MUST use comma separator)
 *   SECURITY_GROUP_ID    = sg-xxxxxxxx
 *   VPC_ID               = vpc-xxxxxxxx
 *   ALB_LISTENER_ARN     = arn:aws:elasticloadbalancing:...
 *   BASE_DOMAIN          = claw-me.com
 *   LITELLM_URL          = https://litellm.claw-me.com     (public — used by Lambda for /key/generate)
 *   LITELLM_INTERNAL_URL = http://litellm.claw-me.local:4000 (VPC-internal — passed to containers as OPENAI_API_BASE)
 *   LITELLM_MASTER_KEY   = sk-litellm-master-...
 *   OPENAI_API_KEY       = sk-...   (real key — fallback if LiteLLM not available)
 *
 * LiteLLM metering flow:
 *   1. Lambda calls LITELLM_URL/key/generate to create a virtual key per tenant
 *   2. Virtual key + LITELLM_INTERNAL_URL are injected into the ECS task as env vars
 *   3. OpenClaw container routes LLM requests through LiteLLM proxy
 *   4. LiteLLM logs spend per virtual key to Supabase litellm_spendlogs table
 *
 * IMPORTANT: Container-to-container traffic MUST use LITELLM_INTERNAL_URL (VPC-internal).
 * The public domain (litellm.claw-me.com) is proxied by Cloudflare which blocks non-browser traffic.
 *
 * IMPORTANT: PLAN_RESOURCES container overrides take precedence over task def defaults.
 * Both must be aligned — if task def says 4096 but Lambda sends 1024, the container gets 1024.
 */

const { resolveRegion } = require('./regions');

const {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
} = require('@aws-sdk/client-ecs');

const {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
  RestoreSecretCommand,
  UpdateSecretCommand,
} = require('@aws-sdk/client-secrets-manager');

const {
  ElasticLoadBalancingV2Client,
  CreateTargetGroupCommand,
  DeleteTargetGroupCommand,
  DescribeTargetGroupsCommand,
  CreateRuleCommand,
  ModifyRuleCommand,
  DeleteRuleCommand,
  DescribeRulesCommand,
} = require('@aws-sdk/client-elastic-load-balancing-v2');

const { createClient } = require('@supabase/supabase-js');

// ── Clients ──────────────────────────────────────────────────
const secrets = new SecretsManagerClient({ region: 'us-east-1' });
const alb     = new ElasticLoadBalancingV2Client({ region: 'us-east-1' });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ecsClients = {};
function getEcsClient(region) {
  if (!ecsClients[region]) ecsClients[region] = new ECSClient({ region });
  return ecsClients[region];
}

// ── Plan resource mapping ─────────────────────────────────────
const PLAN_RESOURCES = {
  starter:    { cpu: '2048', memory: '4096' },  // 4GB — WhatsApp Web bridge + headless Chromium needs headroom for crypto ops
  pro:        { cpu: '2048', memory: '4096' },
  enterprise: { cpu: '2048', memory: '4096' },
};

// ── Main handler ─────────────────────────────────────────────
exports.handler = async (event) => {

  // ── EventBridge: ECS Task State Change ───────────────────────
  if (event.source === 'aws.ecs' && event['detail-type'] === 'ECS Task State Change') {
    const detail  = event.detail || {};
    const taskArn = detail.taskArn;
    const status  = detail.lastStatus;

    console.log(`EventBridge ECS state change: ${taskArn} → ${status}`);

    const mapped = status === 'RUNNING' ? 'running'
                 : status === 'STOPPED' ? 'stopped'
                 : 'provisioning';

    const { data: instance, error: findError } = await supabase
      .from('instances')
      .select('tenant_id')
      .eq('ecs_task_arn', taskArn)
      .single();

    if (findError || !instance) {
      console.log(`No instance found for taskArn: ${taskArn}`);
      return { statusCode: 200, body: 'No matching instance' };
    }

    await supabase.from('instances').update({
      status:         mapped,
      last_health_at: mapped === 'running' ? new Date().toISOString() : null,
      updated_at:     new Date().toISOString(),
    }).eq('ecs_task_arn', taskArn);

    await logAudit(instance.tenant_id, 'eventbridge', `instance.${mapped}`, { taskArn, ecsStatus: status });
    return { statusCode: 200, body: `Updated to ${mapped}` };
  }

  // ── API Gateway: manual actions ───────────────────────────────
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || event;
  const { action, tenantId, plan, telegramBotToken, telegramDmPolicy, telegramAllowFrom } = body;

  try {
    switch (action) {
      case 'provision':   return await provision(tenantId, plan, body.countryCode, telegramBotToken, telegramDmPolicy, telegramAllowFrom);
      case 'deprovision': return await deprovision(tenantId);
      case 'status':      return await getStatus(tenantId);
      default:
        return respond(400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('Lambda error:', err);
    await logAudit(tenantId, 'system', 'instance.error', { error: err.message, action });
    return respond(500, { error: err.message });
  }
};

// ── PROVISION ────────────────────────────────────────────────
async function provision(tenantId, plan = 'starter', countryCode = null, telegramBotToken = '', telegramDmPolicy = 'pairing', telegramAllowFrom = '') {
  const { region, name: regionName, cluster } = resolveRegion(countryCode);
  console.log(`Provisioning tenant: ${tenantId} (${plan}) → ${region}${telegramBotToken ? ' [telegram token provided]' : ''}${telegramAllowFrom ? ` [allowFrom: ${telegramAllowFrom}]` : ''}`);

  const ecs       = getEcsClient(region);
  const resources = PLAN_RESOURCES[plan] || PLAN_RESOURCES.starter;
  const subdomain = `tenant-${tenantId.split('-')[0]}`;
  const httpsEndpoint = `https://${subdomain}.${process.env.BASE_DOMAIN}`;

  // 1. Create / restore Secrets Manager entry
  const secretName  = `openclaw/tenants/${tenantId}`;
  const secretValue = JSON.stringify({
    tenantId,
    plan,
    createdAt: new Date().toISOString(),
    integrations: {},
    ...(telegramBotToken ? { telegramBotToken } : {}),
  });
  try {
    await secrets.send(new CreateSecretCommand({
      Name: secretName, Description: `Config for tenant ${tenantId}`, SecretString: secretValue,
    }));
  } catch (e) {
    if (e.name === 'ResourceExistsException') {
      await secrets.send(new UpdateSecretCommand({ SecretId: secretName, SecretString: secretValue }));
    } else if (e.name === 'InvalidRequestException' && e.message.includes('scheduled for deletion')) {
      console.log(`Restoring secret: ${secretName}`);
      await secrets.send(new RestoreSecretCommand({ SecretId: secretName }));
      await secrets.send(new UpdateSecretCommand({ SecretId: secretName, SecretString: secretValue }));
    } else {
      throw e;
    }
  }

  // 2. Create ALB target group for this tenant
  const tgName = `oclaw-${tenantId.split('-')[0]}`; // e.g. oclaw-f306cee8 (14 chars)
  let tgArn;
  try {
    const tgResult = await alb.send(new CreateTargetGroupCommand({
      Name:                       tgName,
      Protocol:                   'HTTP',
      Port:                       18789,
      VpcId:                      process.env.VPC_ID,
      TargetType:                 'ip',
      HealthCheckProtocol:        'HTTP',
      HealthCheckPort:            '18789',
      HealthCheckPath:            '/',
      HealthCheckIntervalSeconds: 30,
      HealthCheckTimeoutSeconds:  10,
      HealthyThresholdCount:      2,
      UnhealthyThresholdCount:    3,
      Matcher:                    { HttpCode: '200-404' },
    }));
    tgArn = tgResult.TargetGroups[0].TargetGroupArn;
    console.log(`Created target group: ${tgArn}`);
  } catch (e) {
    if (e.name === 'DuplicateTargetGroupNameException') {
      // Target group already exists — look it up by name
      const { TargetGroups: tgs } = await alb.send(new DescribeTargetGroupsCommand({ Names: [tgName] }));
      tgArn = tgs[0].TargetGroupArn;
      console.log(`Reusing existing target group: ${tgArn}`);
    } else {
      throw e;
    }
  }

  // 3. Create ALB listener rule: tenant-{id}.claw-me.com → target group
  // Check for existing rules first — re-provision must not create duplicates.
  let ruleArn;
  try {
    const hostname = `${subdomain}.${process.env.BASE_DOMAIN}`;
    const { Rules } = await alb.send(new DescribeRulesCommand({ ListenerArn: process.env.ALB_LISTENER_ARN }));

    // Find all existing rules for this hostname
    const existing = Rules.filter(r =>
      r.Conditions.some(c => c.HostHeaderConfig?.Values?.includes(hostname))
    );

    if (existing.length > 0) {
      // Reuse the first (lowest priority) rule; delete any extras
      existing.sort((a, b) => parseInt(a.Priority) - parseInt(b.Priority));
      ruleArn = existing[0].RuleArn;
      // Update it to point to current target group (may have changed)
      await alb.send(new ModifyRuleCommand({
        RuleArn: ruleArn,
        Actions: [{ Type: 'forward', TargetGroupArn: tgArn }],
      }));
      console.log(`Reusing existing listener rule (priority ${existing[0].Priority}): ${ruleArn}`);
      // Delete any duplicate rules beyond the first
      for (const dup of existing.slice(1)) {
        try {
          await alb.send(new DeleteRuleCommand({ RuleArn: dup.RuleArn }));
          console.log(`Deleted duplicate rule (priority ${dup.Priority})`);
        } catch (e) { console.warn('Duplicate rule delete skipped:', e.message); }
      }
    } else {
      // No existing rule — create one with next available priority
      const usedPriorities = Rules.map(r => parseInt(r.Priority)).filter(p => !isNaN(p));
      const priority = usedPriorities.length > 0 ? Math.max(...usedPriorities) + 1 : 1;
      const ruleResult = await alb.send(new CreateRuleCommand({
        ListenerArn: process.env.ALB_LISTENER_ARN,
        Priority:    priority,
        Conditions:  [{ Field: 'host-header', Values: [hostname] }],
        Actions:     [{ Type: 'forward', TargetGroupArn: tgArn }],
      }));
      ruleArn = ruleResult.Rules[0].RuleArn;
      console.log(`Created listener rule (priority ${priority}): ${ruleArn}`);
    }
  } catch (e) {
    console.warn('Listener rule setup failed:', e.message);
  }

  // 4. Create or retrieve LiteLLM virtual key for this tenant.
  // Lambda is NOT in the VPC, so use public LITELLM_URL for key generation.
  // ECS containers (in VPC) will use LITELLM_INTERNAL_URL for actual API traffic.
  let litellmVirtualKey = '';
  const litellmKeygenUrl = process.env.LITELLM_URL;
  const ALLOWED_MODELS = [
    'gpt-4.1-mini', 'gpt-4.1', 'openai/gpt-4.1-mini', 'openai/gpt-4.1',
  ];
  if (litellmKeygenUrl && process.env.LITELLM_MASTER_KEY) {
    const authHeader = { 'Authorization': `Bearer ${process.env.LITELLM_MASTER_KEY}`, 'Content-Type': 'application/json' };
    try {
      // Try to create a new key
      const litellmRes = await fetch(`${litellmKeygenUrl}/key/generate`, {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          key_alias:       `tenant-${tenantId}`,
          metadata:        { tenant_id: tenantId, plan },
          models:          ALLOWED_MODELS,
          max_budget:      plan === 'starter' ? 10 : plan === 'pro' ? 50 : null,
          budget_duration: 'monthly',
        }),
      });
      const litellmData = await litellmRes.json();

      if (litellmData.key) {
        litellmVirtualKey = litellmData.key;
        console.log(`Created LiteLLM virtual key for tenant ${tenantId}: ${litellmVirtualKey.slice(0, 12)}...`);
      } else if (litellmData.error?.message?.includes('already exists')) {
        // Key alias already exists — delete the old key(s) then recreate fresh.
        // LiteLLM /key/list returns hashed key IDs; pass them to /key/delete.
        console.log(`Key alias tenant-${tenantId} exists — deleting and recreating with updated model list`);
        const listRes  = await fetch(`${litellmKeygenUrl}/key/list?key_alias=tenant-${tenantId}`, { headers: authHeader });
        const listData = await listRes.json();
        const keyHashes = listData?.keys || [];
        if (keyHashes.length > 0) {
          await fetch(`${litellmKeygenUrl}/key/delete`, {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({ keys: keyHashes }),
          });
          console.log(`Deleted ${keyHashes.length} old key(s) for tenant ${tenantId}`);
        }
        // Now create fresh
        const retryRes  = await fetch(`${litellmKeygenUrl}/key/generate`, {
          method: 'POST',
          headers: authHeader,
          body: JSON.stringify({
            key_alias:       `tenant-${tenantId}`,
            metadata:        { tenant_id: tenantId, plan },
            models:          ALLOWED_MODELS,
            max_budget:      plan === 'starter' ? 10 : plan === 'pro' ? 50 : null,
            budget_duration: 'monthly',
          }),
        });
        const retryData = await retryRes.json();
        litellmVirtualKey = retryData.key || '';
        if (litellmVirtualKey) {
          console.log(`Recreated LiteLLM virtual key for tenant ${tenantId}: ${litellmVirtualKey.slice(0, 12)}...`);
        } else {
          console.warn(`LiteLLM key recreation failed for tenant ${tenantId}. Response:`, JSON.stringify(retryData));
        }
      } else {
        console.warn(`LiteLLM key generation returned no key for tenant ${tenantId}. Response:`, JSON.stringify(litellmData));
      }
    } catch (e) {
      console.warn('LiteLLM key creation failed (will use direct API key):', e.message, e.cause ? JSON.stringify(e.cause) : '');
    }
  }

  // 5. Run ECS Fargate task
  const runResult = await getEcsClient(region).send(new RunTaskCommand({
    cluster:        cluster,
    taskDefinition: process.env.ECS_TASK_DEFINITION,
    launchType:     'FARGATE',
    count:          1,
    overrides: {
      containerOverrides: [{
        name:   'openclaw',
        cpu:    parseInt(resources.cpu),
        memory: parseInt(resources.memory),
        environment: [
          { name: 'TENANT_ID',            value: tenantId },
          { name: 'PLAN',                 value: plan },
          { name: 'SUBDOMAIN',            value: subdomain },
          { name: 'REGION',               value: region },
          { name: 'SECRET_NAME',          value: secretName },
          { name: 'AWS_DEFAULT_REGION',   value: region },
          { name: 'GATEWAY_PORT',         value: '18789' },
          { name: 'SUPABASE_URL',         value: process.env.SUPABASE_URL },
          { name: 'SUPABASE_SERVICE_KEY', value: process.env.SUPABASE_SERVICE_KEY },
          { name: 'TARGET_GROUP_ARN',     value: tgArn || '' },
          { name: 'HTTPS_ENDPOINT',       value: httpsEndpoint },
          // LiteLLM metering architecture (original working design from transcript):
          //   OPENAI_API_KEY  = real OpenAI key always.
          //                     OpenClaw's embedded agent calls api.openai.com directly using
          //                     this env var, ignoring baseUrl. The inline MITM proxy in the
          //                     entrypoint intercepts those calls and replaces the auth header
          //                     with LITELLM_VIRTUAL_KEY before forwarding to LiteLLM.
          //                     If the proxy is down, OpenClaw falls back to api.openai.com
          //                     with the real key (unmetered but functional).
          //   OPENAI_API_BASE = LiteLLM internal URL. Belt-and-suspenders for any code path
          //                     that does respect the base URL.
          //   LITELLM_VIRTUAL_KEY = per-tenant virtual key. Entrypoint proxy uses this to
          //                     replace the auth header on intercepted API calls → LiteLLM
          //                     meters all traffic against this key.
          //   Direct mode (no virtual key): OPENAI_API_KEY = real key, no proxy started.
          { name: 'OPENAI_API_BASE',     value: litellmVirtualKey ? (process.env.LITELLM_INTERNAL_URL || process.env.LITELLM_URL) : '' },
          { name: 'OPENAI_API_KEY',      value: process.env.OPENAI_API_KEY || '' },
          { name: 'LITELLM_VIRTUAL_KEY', value: litellmVirtualKey || '' },
          { name: 'ANTHROPIC_API_KEY',   value: litellmVirtualKey ? '' : (process.env.ANTHROPIC_API_KEY || '') },
          { name: 'TELEGRAM_BOT_TOKEN',  value: telegramBotToken  || '' },
          { name: 'TELEGRAM_DM_POLICY',  value: telegramDmPolicy  || 'pairing' },
          { name: 'TELEGRAM_ALLOW_FROM', value: telegramAllowFrom || '' },
        ],
      }],
    },
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets:        process.env.SUBNET_IDS.split(','),
        securityGroups: [process.env.SECURITY_GROUP_ID],
        assignPublicIp: 'ENABLED',
      },
    },
    enableExecuteCommand: true,
    tags: [
      { key: 'tenantId', value: tenantId },
      { key: 'plan',     value: plan },
      { key: 'service',  value: 'claw-me' },
    ],
  }));

  const taskArn = runResult.tasks[0].taskArn;

  // 5. Upsert Supabase instance record
  await supabase.from('instances').upsert({
    tenant_id:              tenantId,
    ecs_task_arn:           taskArn,
    ecs_cluster:            cluster,
    endpoint_url:           httpsEndpoint,
    region:                 region,
    status:                 'provisioning',
    last_health_at:         null,
    alb_target_group_arn:   tgArn || null,
    alb_listener_rule_arn:  ruleArn || null,
  });

  await logAudit(tenantId, 'system', 'instance.provisioned', { taskArn, httpsEndpoint, plan, region });
  return respond(200, { taskArn, endpoint: httpsEndpoint, region, regionName, status: 'provisioning' });
}

// ── DEPROVISION ──────────────────────────────────────────────
async function deprovision(tenantId) {
  console.log(`Deprovisioning tenant: ${tenantId}`);

  const { data: instance, error } = await supabase
    .from('instances')
    .select('ecs_task_arn, ecs_cluster, region, alb_target_group_arn, alb_listener_rule_arn')
    .eq('tenant_id', tenantId)
    .eq('status', 'running')
    .single();

  if (error || !instance) return respond(404, { error: 'No running instance found' });

  const ecs = getEcsClient(instance.region || 'us-east-1');

  // Stop ECS task
  try {
    await ecs.send(new StopTaskCommand({
      cluster: instance.ecs_cluster,
      task:    instance.ecs_task_arn,
      reason:  'Tenant deprovisioned',
    }));
  } catch (e) {
    if (!['InvalidParameterException', 'ClusterNotFoundException'].includes(e.name)) throw e;
    console.warn('ECS task not found, continuing cleanup:', e.message);
  }

  // Remove ALB listener rule(s) — scan by hostname to catch any duplicates
  try {
    const subdomain = `tenant-${tenantId.split('-')[0]}`;
    const hostname  = `${subdomain}.${process.env.BASE_DOMAIN}`;
    const { Rules } = await alb.send(new DescribeRulesCommand({ ListenerArn: process.env.ALB_LISTENER_ARN }));
    const toDelete  = Rules.filter(r =>
      r.Conditions.some(c => c.HostHeaderConfig?.Values?.includes(hostname))
    );
    for (const rule of toDelete) {
      try {
        await alb.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn }));
        console.log(`Deleted listener rule (priority ${rule.Priority})`);
      } catch (e) { console.warn('Rule delete skipped:', e.message); }
    }
  } catch (e) { console.warn('Rule cleanup skipped:', e.message); }

  // Delete ALB target group
  if (instance.alb_target_group_arn) {
    try {
      await alb.send(new DeleteTargetGroupCommand({ TargetGroupArn: instance.alb_target_group_arn }));
      console.log('Deleted target group');
    } catch (e) { console.warn('Target group delete skipped:', e.message); }
  }

  // Delete secret (7-day recovery window)
  try {
    await secrets.send(new DeleteSecretCommand({
      SecretId: `openclaw/tenants/${tenantId}`, RecoveryWindowInDays: 7,
    }));
  } catch (e) { console.warn('Secret delete skipped:', e.message); }

  await supabase.from('instances')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId);

  await supabase.from('tenants')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', tenantId);

  await logAudit(tenantId, 'system', 'instance.deprovisioned', { taskArn: instance.ecs_task_arn });
  return respond(200, { status: 'stopped' });
}

// ── STATUS ───────────────────────────────────────────────────
async function getStatus(tenantId) {
  const { data: instance, error } = await supabase.from('instances').select('*').eq('tenant_id', tenantId).single();
  if (error || !instance) return respond(404, { error: 'Instance not found' });

  if (instance.ecs_task_arn) {
    try {
      const ecs = getEcsClient(instance.region || 'us-east-1');
      const { tasks } = await ecs.send(new DescribeTasksCommand({ cluster: instance.ecs_cluster, tasks: [instance.ecs_task_arn] }));
      if (tasks?.length) {
        const mapped = tasks[0].lastStatus === 'RUNNING' ? 'running' : tasks[0].lastStatus === 'STOPPED' ? 'stopped' : 'provisioning';
        if (mapped !== instance.status) {
          await supabase.from('instances').update({ status: mapped }).eq('tenant_id', tenantId);
          instance.status = mapped;
        }
      }
    } catch (e) { console.warn('ECS status check failed:', e.message); }
  }

  return respond(200, { tenantId, status: instance.status, endpointUrl: instance.endpoint_url });
}

// ── HELPERS ──────────────────────────────────────────────────
async function logAudit(tenantId, actor, action, payload = {}) {
  try { await supabase.from('audit_log').insert({ tenant_id: tenantId, actor, action, payload }); }
  catch (e) { console.error('Audit log error:', e.message); }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}
