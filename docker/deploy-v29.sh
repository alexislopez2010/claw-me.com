#!/bin/bash
# claw-me.com — Deploy v29 task definition and update Lambda

set -euo pipefail

ECR_REPO="204128836886.dkr.ecr.us-east-1.amazonaws.com/claw-me/openclaw"
TAG="v29"
REGION="us-east-1"

echo "=== Registering new ECS task definition with image:${TAG} ==="

# Get current task definition
CURRENT_TD=$(aws ecs describe-task-definition \
  --task-definition openclaw-task \
  --region "$REGION" \
  --query 'taskDefinition' \
  --output json)

# Build new task def with updated image
NEW_TD=$(echo "$CURRENT_TD" | python3 -c "
import sys, json
td = json.load(sys.stdin)
# Update image tag
for c in td['containerDefinitions']:
    c['image'] = c['image'].rsplit(':', 1)[0] + ':${TAG}'
# Remove fields that can't be in register call
for f in ['taskDefinitionArn','revision','status','requiresAttributes',
          'compatibilities','registeredAt','registeredBy']:
    td.pop(f, None)
print(json.dumps(td))
")

NEW_REVISION=$(echo "$NEW_TD" | aws ecs register-task-definition \
  --region "$REGION" \
  --cli-input-json /dev/stdin \
  --query 'taskDefinition.revision' \
  --output text)

echo "New task definition: openclaw-task:${NEW_REVISION}"

echo "=== Updating Lambda ECS_TASK_DEFINITION env var ==="
aws lambda update-function-configuration \
  --function-name claw-me-provision-instance \
  --region "$REGION" \
  --environment "$(aws lambda get-function-configuration \
    --function-name claw-me-provision-instance \
    --region "$REGION" \
    --query 'Environment' \
    --output json | python3 -c "
import sys, json
env = json.load(sys.stdin)
env['Variables']['ECS_TASK_DEFINITION'] = 'openclaw-task:${NEW_REVISION}'
print(json.dumps(env))
")" \
  --query 'Environment.Variables.ECS_TASK_DEFINITION' \
  --output text

echo "=== Deploy complete ==="
echo "Task definition: openclaw-task:${NEW_REVISION}"
