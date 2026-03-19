/**
 * claw-me.com — Provision Instance Lambda
 *
 * Triggered by: n8n automation (POST) after Stripe payment confirmed
 * Purpose:      Spin up a new ECS Fargate task for a tenant in the
 *               nearest AWS region based on customer country code.
 *
 * Environment variables to set in Lambda console:
 *   ECS_TASK_DEFINITION  = openclaw-task
 *   SUPABASE_URL         = https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY = your-service-role-key   (bypasses RLS)
 *   SUBNET_IDS           = subnet-aaa,subnet-bbb   (comma-separated, per region)
 *   SECURITY_GROUP_ID    = sg-xxxxxxxx
 *   BASE_DOMAIN          = claw-me.com
 *   HOSTED_ZONE_ID       = your-route53-zone-id
 *
 * NOTE: Deploy this Lambda to us-east-1. It will spin up ECS tasks
 *       in other regions by instantiating region-specific ECS clients.
 *       Make sure you have ECS clusters created in each region you
 *       intend to support (see regions.js for the full list).
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
} = require('@aws-sdk/client-secrets-manager');

const {
  Route53Client,
  ChangeResourceRecordSetsCommand,
} = require('@aws-sdk/client-route-53');

const { createClient } = require('@supabase/supabase-js');

// ── Clients ──────────────────────────────────────────────────
// ECS clients are instantiated per-region at provision time (see getEcsClient)
// Secrets Manager always lives in us-east-1 (centralised)
const secrets = new SecretsManagerClient({ region: 'us-east-1' });

// Cache ECS clients per region to avoid re-instantiating on warm Lambda invocations
const ecsClients = {};
function getEcsClient(region) {
  if (!ecsClients[region]) {
    ecsClients[region] = new ECSClient({ region });
  }
  return ecsClients[region];
}
const route53 = new Route53Client({});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service role — bypasses RLS
);

// ── Plan resource mapping ─────────────────────────────────────
const PLAN_RESOURCES = {
  starter:    { cpu: '512',  memory: '1024' },
  pro:        { cpu: '1024', memory: '2048' },
  enterprise: { cpu: '2048', memory: '4096' },
};

// ── Main handler ─────────────────────────────────────────────
exports.handler = async (event) => {
  const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body || event;
  const { action, tenantId, plan } = body;

  try {
    switch (action) {
      case 'provision':   return await provision(tenantId, plan, body.countryCode);
      case 'deprovision': return await deprovision(tenantId);
      case 'status':      return await getStatus(tenantId);
      default:
        return respond(400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('Lambda error:', err);
    await logAudit(tenantId, 'system', `instance.error`, { error: err.message, action });
    return respond(500, { error: err.message });
  }
};

// ── PROVISION ────────────────────────────────────────────────
async function provision(tenantId, plan = 'starter', countryCode = null) {
  // Resolve nearest AWS region from customer country code
  const { region, name: regionName, cluster } = resolveRegion(countryCode);
  console.log(`Provisioning tenant: ${tenantId} (${plan}) → ${region} (${regionName}) [country: ${countryCode || 'unknown'}]`);

  const ecs       = getEcsClient(region);
  const resources = PLAN_RESOURCES[plan] || PLAN_RESOURCES.starter;
  const subdomain = `tenant-${tenantId.split('-')[0]}`;   // e.g. tenant-a1b2c3
  const endpoint  = `https://${subdomain}.${process.env.BASE_DOMAIN}`;

  // 1. Create per-tenant secret in Secrets Manager
  await secrets.send(new CreateSecretCommand({
    Name:         `openclaw/tenants/${tenantId}`,
    Description:  `API keys and config for tenant ${tenantId}`,
    SecretString: JSON.stringify({
      tenantId,
      plan,
      createdAt: new Date().toISOString(),
      integrations: {},
    }),
  }));

  // 2. Run ECS Fargate task
  const runResult = await ecs.send(new RunTaskCommand({
    cluster:        cluster,   // region-specific cluster (from regions.js)
    taskDefinition: process.env.ECS_TASK_DEFINITION,
    launchType:     'FARGATE',
    count:          1,
    overrides: {
      containerOverrides: [{
        name: 'openclaw',
        cpu:    parseInt(resources.cpu),
        memory: parseInt(resources.memory),
        environment: [
          { name: 'TENANT_ID',   value: tenantId },
          { name: 'PLAN',        value: plan },
          { name: 'SUBDOMAIN',   value: subdomain },
          { name: 'REGION',      value: region },
          { name: 'SECRET_NAME', value: `openclaw/tenants/${tenantId}` },
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
    tags: [
      { key: 'tenantId', value: tenantId },
      { key: 'plan',     value: plan },
      { key: 'service',  value: 'claw-me' },
    ],
  }));

  const task    = runResult.tasks[0];
  const taskArn = task.taskArn;

  // 3. Wait for task to get a public IP (poll up to 60s)
  const publicIp = await waitForPublicIp(taskArn);

  // 4. Create Route53 DNS record: subdomain.claw-me.com → public IP
  if (publicIp && process.env.HOSTED_ZONE_ID) {
    await route53.send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: process.env.HOSTED_ZONE_ID,
      ChangeBatch: {
        Changes: [{
          Action: 'UPSERT',
          ResourceRecordSet: {
            Name: `${subdomain}.${process.env.BASE_DOMAIN}`,
            Type: 'A',
            TTL:  60,
            ResourceRecords: [{ Value: publicIp }],
          },
        }],
      },
    }));
  }

  // 5. Update Supabase instance record
  await supabase.from('instances').upsert({
    tenant_id:    tenantId,
    ecs_task_arn: taskArn,
    ecs_cluster:  cluster,
    endpoint_url: endpoint,
    region:       region,
    status:       publicIp ? 'running' : 'provisioning',
    last_health_at: publicIp ? new Date().toISOString() : null,
  });

  await logAudit(tenantId, 'system', 'instance.provisioned', {
    taskArn, endpoint, plan, region, regionName, countryCode, publicIp,
  });

  return respond(200, { taskArn, endpoint, publicIp, region, regionName, status: 'provisioning' });
}

// ── DEPROVISION ──────────────────────────────────────────────
async function deprovision(tenantId) {
  console.log(`Deprovisioning instance for tenant: ${tenantId}`);

  // Get current instance from Supabase
  const { data: instance } = await supabase
    .from('instances')
    .select('ecs_task_arn, ecs_cluster, endpoint_url')
    .eq('tenant_id', tenantId)
    .eq('status', 'running')
    .single();

  if (!instance) {
    return respond(404, { error: 'No running instance found for this tenant' });
  }

  // Stop ECS task
  await ecs.send(new StopTaskCommand({
    cluster: instance.ecs_cluster || process.env.ECS_CLUSTER,
    task:    instance.ecs_task_arn,
    reason:  'Tenant subscription cancelled',
  }));

  // Delete secret
  await secrets.send(new DeleteSecretCommand({
    SecretId:                  `openclaw/tenants/${tenantId}`,
    RecoveryWindowInDays:      7,   // 7-day recovery window
  })).catch(() => {});              // non-fatal if already gone

  // Update Supabase
  await supabase.from('instances')
    .update({ status: 'stopped', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId);

  await supabase.from('tenants')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', tenantId);

  await logAudit(tenantId, 'system', 'instance.deprovisioned', {
    taskArn: instance.ecs_task_arn,
  });

  return respond(200, { status: 'stopped' });
}

// ── STATUS CHECK ─────────────────────────────────────────────
async function getStatus(tenantId) {
  const { data: instance } = await supabase
    .from('instances')
    .select('*')
    .eq('tenant_id', tenantId)
    .single();

  if (!instance) return respond(404, { error: 'Instance not found' });

  // Verify against ECS for live status
  if (instance.ecs_task_arn) {
    const { tasks } = await ecs.send(new DescribeTasksCommand({
      cluster: instance.ecs_cluster || process.env.ECS_CLUSTER,
      tasks:   [instance.ecs_task_arn],
    }));

    if (tasks?.length) {
      const ecsStatus = tasks[0].lastStatus;  // RUNNING | STOPPED | PENDING
      const mapped    = ecsStatus === 'RUNNING' ? 'running'
                      : ecsStatus === 'STOPPED' ? 'stopped'
                      : 'provisioning';

      if (mapped !== instance.status) {
        await supabase.from('instances')
          .update({ status: mapped, last_health_at: mapped === 'running' ? new Date().toISOString() : undefined })
          .eq('tenant_id', tenantId);
        instance.status = mapped;
      }
    }
  }

  return respond(200, {
    tenantId,
    status:      instance.status,
    endpointUrl: instance.endpoint_url,
    lastHealthAt: instance.last_health_at,
  });
}

// ── HELPERS ──────────────────────────────────────────────────

async function waitForPublicIp(taskArn, maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(4000);
    try {
      const { tasks } = await ecs.send(new DescribeTasksCommand({
        cluster: process.env.ECS_CLUSTER,
        tasks:   [taskArn],
      }));
      const attachment = tasks?.[0]?.attachments?.find(a => a.type === 'ElasticNetworkInterface');
      const eniDetail  = attachment?.details?.find(d => d.name === 'networkInterfaceId');
      if (eniDetail?.value) {
        // Could also query EC2 for the public IP of the ENI here
        // Simplified: return null and let DNS be set later via health check
        return null;
      }
    } catch (_) {}
  }
  return null;
}

async function logAudit(tenantId, actor, action, payload = {}) {
  await supabase.from('audit_log').insert({
    tenant_id: tenantId,
    actor,
    action,
    payload,
  }).catch(console.error);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
