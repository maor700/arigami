# syntax=docker/dockerfile:1
# The image restricted sessions run in (docs/SANDBOX.md) — and the egress proxy. Build from the repo root:
#   docker build -t arigami-sandbox:latest -f docker/sandbox/Dockerfile docker/sandbox
# What it is NOT: no sudo, no setuid helpers worth having (containers also run with no-new-privileges and every
# capability dropped), no Arigami host code (the host mounts only docker/sandbox, skills, docs and the policy hook
# read-only), no credentials of any kind.
FROM node:22-bookworm-slim

# Tools a coding session reaches for. Deliberately no sudo, no openssh-server, no docker CLI.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates ripgrep procps less jq python3 python3-venv unzip xz-utils file patch \
    && rm -rf /var/lib/apt/lists/* \
    # su / mount / passwd & co. cannot help a non-root user under no-new-privileges, but drop their setuid bit anyway
    && (find / -xdev -perm -4000 -type f -exec chmod u-s {} + 2>/dev/null || true)

# Bun: the policy hook, the in-container init and the egress proxy are bun scripts (the host mounts them).
COPY --from=oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx && bun --version

# The engines. The image pins whatever is current at build time; rebuild to update (sessions cannot: the egress
# allowlist does not include the package registries unless a profile names them, and /usr/local is root's).
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
    && npm cache clean --force && rm -rf /root/.npm \
    && claude --version && codex --version

# Any uid runs here (the host passes its own, so files on the mounted tree keep their owner); HOME is a per-session
# dir the host mounts. /home/sandbox only exists so a stray `cd ~` before HOME is set lands somewhere harmless.
RUN mkdir -p /home/sandbox && chmod 1777 /home/sandbox
ENV HOME=/home/sandbox
WORKDIR /home/sandbox
