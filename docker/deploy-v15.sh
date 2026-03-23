#!/bin/bash
# claw-me.com — Deploy v15 task definition + update Lambda
#
# Run AFTER build-v15.sh has pushed the :v15 image to ECR.
#
# v15 adds container-level auth proxy for dual-layer tenant security:
# - Layer 1: Cloudflare Worker (tenant-guard) checks ownership at the edge
# - Layer 2: auth-proxy.py checks ownership inside the container
#
# Task definition uses 2048 CPU / 4096 memory as the base — the Lambda's
# PLAN_RESOURCES container overrides can increase this per plan but never
# go below this floor.
#
# Required env vars (set these before running, or export from a .env file):
#   SUPABASE_SERVICE_KEY, OPENAI_API_KEY, LITELLM_MASTER_KEY
set -euo pipefail

ECR_REPO="204128836886.dkr.ecr.us-east-1.amazonaws.com/claw-me/openclaw"
TAG="v15"

# Validate required secrets are set
for var in SUPABASE_SERVICE_KEY OPENAI_API_KEY LITELLM_MASTER_KEY; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: ${var} is not set. Export it before running this script."
    exit 1
  fi
done

echo "=== Registering task definition for ${TAG} (dual-layer auth: Worker + container proxy) ==="
REVISION=$(aws ecs register-task-definition --family openclaw-task \
  --task-role-arn arn:aws:iam::204128836886:role/claw-me-ecs-task-role \
  --execution-role-arn arn:aws:iam::204128836886:role/claw-me-ecs-task-role \
  --network-mode awsvpc --requires-compatibilities FARGATE \
  --cpu 2048 --memory 4096 \
  --container-definitions "[{\"name\":\"openclaw\",\"image\":\"${ECR_REPO}:${TAG}\",\"portMappings\":[{\"containerPort\":18789,\"hostPort\":18789,\"protocol\":\"tcp\"}],\"essential\":true,\"logConfiguration\":{\"logDriver\":\"awslogs\",\"options\":{\"awslogs-group\":\"/ecs/openclaw\",\"awslogs-region\":\"us-east-1\",\"awslogs-stream-prefix\":\"openclaw\"}}}]" \
  --query 'taskDefinition.revision' --output text)

echo "Registered openclaw-task:${REVISION}"

echo "=== Updating Lambda to use openclaw-task:${REVISION} ==="
aws lambda update-function-configuration \
  --function-name claw-me-provision-instance \
  --environment "{\"Variables\": {\"LITELLM_URL\": \"https://litellm.claw-me.com\", \"SUBNET_IDS\": \"subnet-099c37f1370e66dc9,subnet-084bca9516e001a4c\", \"BASE_DOMAIN\": \"claw-me.com\", \"SUPABASE_SERVICE_KEY\": \"${SUPABASE_SERVICE_KEY}\", \"ECS_TASK_DEFINITION\": \"openclaw-task:${REVISION}\", \"VPC_ID\": \"vpc-05680ab38e5751715\", \"OPENAI_API_KEY\": \"${OPENAI_API_KEY}\", \"SECURITY_GROUP_ID\": \"sg-0b8a155730a60d71d\", \"ALB_LISTENER_ARN\": \"arn:aws:elasticloadbalancing:us-east-1:204128836886:listener/app/claw-me-alb/91aae942341e10a4/03eda1357867fd46\", \"SUPABASE_URL\": \"https://xfklynglppislmdhjtut.supabase.co\", \"LITELLM_MASTER_KEY\": \"${LITELLM_MASTER_KEY}\", \"LITELLM_INTERNAL_URL\": \"http://litellm.claw-me.local:4000\"}}" \
  --query '{FunctionName:FunctionName,TaskDef:Environment.Variables.ECS_TASK_DEFINITION}' 2>&1

echo ""
echo "=== Done ==="
echo "Lambda now uses openclaw-task:${REVISION} with ${TAG} image (dual-layer auth)"
echo ""
echo "To reprovision the current tenant:"
echo "  curl -X POST https://YOUR_API_GW/provision -d '{\"action\":\"deprovision\",\"tenantId\":\"TENANT_ID\"}'"
echo "  curl -X POST https://YOUR_API_GW/provision -d '{\"action\":\"provision\",\"tenantId\":\"TENANT_ID\",\"plan\":\"starter\"}'"
