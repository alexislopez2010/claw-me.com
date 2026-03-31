#!/bin/bash
# claw-me.com — Build and push OpenClaw Docker image v29
#
# v29 changes (over v28):
#   - entrypoint.sh now reads TELEGRAM_DM_POLICY and TELEGRAM_ALLOW_FROM
#     environment variables and writes them into openclaw.json at startup.
#   - This enables per-tenant dmPolicy (allowlist/pairing) and allowFrom
#     to be set via ECS task environment variables at provision time.
#   - TELEGRAM_BOT_TOKEN was already read from env; this extends that
#     pattern to the remaining Telegram config fields.
#
# Run from: claw-me.com/docker/
# Requires: Docker, AWS CLI with ECR credentials

set -euo pipefail

ECR_REPO="204128836886.dkr.ecr.us-east-1.amazonaws.com/claw-me/openclaw"
TAG="v29"

echo "=== Building claw-me/openclaw:${TAG} ==="

aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "$(echo $ECR_REPO | cut -d/ -f1)"

docker build \
  --platform linux/amd64 \
  --build-arg CACHEBUST="$(date +%s)" \
  --no-cache \
  -t "${ECR_REPO}:${TAG}" \
  -t "${ECR_REPO}:latest" \
  -f Dockerfile \
  .

echo "=== Pushing ${ECR_REPO}:${TAG} ==="
docker push "${ECR_REPO}:${TAG}"
docker push "${ECR_REPO}:latest"

echo "=== Done ==="
echo "Image: ${ECR_REPO}:${TAG}"
echo "Next step: run deploy-v29.sh"
