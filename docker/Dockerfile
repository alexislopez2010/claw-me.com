FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TENANT_ID=""
ENV PLAN="starter"
ENV SUBDOMAIN=""
ENV GATEWAY_PORT=18789
ENV MODEL_PRIMARY="openai/gpt-4.1-mini"
ENV TELEGRAM_ENABLED=false

# Install dependencies: AWS CLI, Python, curl
RUN apt-get update && apt-get install -y \
    curl ca-certificates bash python3 unzip \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# Install OpenClaw (non-interactive)
RUN CI=true NONINTERACTIVE=1 curl -fsSL https://openclaw.ai/install.sh | bash || true

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 18789

ENTRYPOINT ["/entrypoint.sh"]
