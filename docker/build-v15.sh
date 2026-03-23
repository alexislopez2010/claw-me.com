#!/bin/bash
# claw-me.com — Build and push OpenClaw Docker image v15
#
# v15 changes from v14:
# - Adds container-level auth proxy (auth-proxy.py) for defense in depth
#   The auth proxy validates Cf-Access-Authenticated-User-Email against
#   tenant owner/member emails from Supabase before forwarding to OpenClaw
# - Entrypoint fetches TENANT_OWNER_EMAILS from Supabase at startup
# - If owner emails found: auth-proxy listens on 18789, OpenClaw on 18790
# - If no owner emails: OpenClaw runs directly on 18789 (backward compatible)
#
# Combined with the Cloudflare Worker (tenant-guard), this provides
# dual-layer tenant isolation: edge check + container check.
#
# Run from: claw-me.com/docker/
# Requires: Docker, AWS CLI with ECR credentials
# Must be run from a machine with Docker (not the Cowork VM)

set -euo pipefail

ECR_REPO="204128836886.dkr.ecr.us-east-1.amazonaws.com/claw-me/openclaw"
TAG="v15"

echo "=== Building claw-me/openclaw:${TAG} ==="

# Login to ECR
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "$(echo $ECR_REPO | cut -d/ -f1)"

# Build for linux/amd64 (required by Fargate) with cache bust
docker build \
  --platform linux/amd64 \
  --build-arg CACHEBUST="$(date +%s)" \
  --no-cache \
  -t "${ECR_REPO}:${TAG}" \
  -f Dockerfile \
  .

echo "=== Pushing ${ECR_REPO}:${TAG} ==="
docker push "${ECR_REPO}:${TAG}"

echo "=== Done ==="
echo "Image: ${ECR_REPO}:${TAG}"
echo ""
echo "Next step: run deploy-v15.sh to register task definition and update Lambda."
