#!/bin/bash
# deploy.sh — Build, push, re-register task def, update Lambda
# Usage: ./deploy.sh [version-tag]
#   e.g. ./deploy.sh v6
#   If no tag given, auto-increments from the latest ECR tag.

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────────
REGION="us-east-1"
ACCOUNT_ID="204128836886"
ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/claw-me/openclaw"
TASK_FAMILY="openclaw-task"
LAMBDA_FUNCTION="claw-me-provision-instance"  # update if different: aws lambda list-functions --region us-east-1 --query 'Functions[].FunctionName' --output text
CLUSTER="claw-me-cluster-use1"
DOCKER_DIR="$(cd "$(dirname "$0")/docker" && pwd)"

# ── Resolve version tag ─────────────────────────────────────────────────────
if [ -n "${1:-}" ]; then
  TAG="$1"
else
  # Auto-increment: find highest vN tag in ECR
  LATEST=$(aws ecr describe-images \
    --repository-name claw-me/openclaw \
    --region "$REGION" \
    --query 'sort_by(imageDetails, &imagePushedAt)[-1].imageTags[0]' \
    --output text 2>/dev/null || echo "v0")
  NUM="${LATEST#v}"
  TAG="v$((NUM + 1))"
fi

IMAGE="${ECR_REPO}:${TAG}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  claw-me deploy  →  ${TAG}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Step 1: ECR login ───────────────────────────────────────────────────────
echo "[1/5] Logging into ECR..."
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# ── Step 2: Build ───────────────────────────────────────────────────────────
echo "[2/5] Building image ${IMAGE}..."
docker build \
  --platform linux/amd64 \
  --build-arg CACHEBUST="$(date +%s)" \
  -t "$IMAGE" \
  "$DOCKER_DIR"

# ── Step 3: Push ────────────────────────────────────────────────────────────
echo "[3/5] Pushing ${IMAGE}..."
docker push "$IMAGE"

# ── Step 4: Register new task definition revision ───────────────────────────
echo "[4/5] Registering new task definition..."

# Fetch current task def, swap image, strip read-only fields
NEW_TASK_DEF=$(aws ecs describe-task-definition \
  --task-definition "$TASK_FAMILY" \
  --region "$REGION" \
  --query 'taskDefinition' \
  --output json \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
# Update image
for c in d.get('containerDefinitions', []):
    if c.get('name') == 'openclaw':
        c['image'] = '${IMAGE}'
# Strip read-only fields
for key in ['taskDefinitionArn','revision','status','requiresAttributes',
            'compatibilities','registeredAt','registeredBy']:
    d.pop(key, None)
print(json.dumps(d))
")

NEW_REVISION=$(aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json "$NEW_TASK_DEF" \
  --query 'taskDefinition.revision' \
  --output text)

TASK_DEF_REF="${TASK_FAMILY}:${NEW_REVISION}"
echo "    → Registered ${TASK_DEF_REF}"

# ── Step 5: Update Lambda env var ───────────────────────────────────────────
echo "[5/5] Updating Lambda ${LAMBDA_FUNCTION}..."

# Merge just ECS_TASK_DEFINITION into existing env vars
CURRENT_ENV=$(aws lambda get-function-configuration \
  --function-name "$LAMBDA_FUNCTION" \
  --region "$REGION" \
  --query 'Environment.Variables' \
  --output json)

NEW_ENV=$(echo "$CURRENT_ENV" | python3 -c "
import sys, json
d = json.load(sys.stdin)
d['ECS_TASK_DEFINITION'] = '${TASK_DEF_REF}'
print(json.dumps({'Variables': d}))
")

aws lambda update-function-configuration \
  --function-name "$LAMBDA_FUNCTION" \
  --region "$REGION" \
  --environment "$NEW_ENV" \
  --query 'Environment.Variables.ECS_TASK_DEFINITION' \
  --output text

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Done! Image:   ${IMAGE}"
echo "  ✓ Task def:      ${TASK_DEF_REF}"
echo "  ✓ Lambda env:    ECS_TASK_DEFINITION=${TASK_DEF_REF}"
echo ""
echo "  Next: deprovision + reprovision the tenant to pick up the new image."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
