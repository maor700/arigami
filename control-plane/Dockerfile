# syntax=docker/dockerfile:1
#
# Control-plane image (docs/CONTROL-PLANE.md, docs/DEVOPS-HANDOFF.md).
#
# BUILD CONTEXT IS THE REPO ROOT, not control-plane/ — the image bakes
# deploy/helm/arigami-tenant so the shipped chart is pinned to the
# control-plane version that provisions with it:
#
#     docker build -f control-plane/Dockerfile -t <registry>/arigami-control-plane:<tag> .
#
# Unlike the arigami host image this one runs as a plain non-root user with no
# root pass at all: nothing here chowns a volume (the chart's fsGroup does it),
# so the pod satisfies the `restricted` Pod Security Standard as-is.

#############################################
# Stage 1 — dependencies
#############################################
FROM oven/bun:1-debian AS deps
WORKDIR /app
COPY control-plane/package.json control-plane/bun.lock ./
RUN bun install --frozen-lockfile

#############################################
# Stage 2 — runtime
#############################################
FROM oven/bun:1-debian AS runtime
ARG TARGETARCH

# Keep these within one minor of the target cluster's API server; both are
# plain static binaries, so bumping is a rebuild with a new --build-arg.
ARG KUBECTL_VERSION=v1.33.4
ARG HELM_VERSION=v3.18.4

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tar gzip \
    && rm -rf /var/lib/apt/lists/*

# src/provisioner.ts, src/backup.ts and src/progress.ts shell out to these two
# binaries (Bun.spawn) — there is no maintained JS Helm SDK, see the comment at
# the top of provisioner.ts. Without them every provision fails with ENOENT.
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${arch}/kubectl"; \
    chmod 0755 /usr/local/bin/kubectl; \
    curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz" \
      | tar -xz -C /tmp; \
    install -m 0755 "/tmp/linux-${arch}/helm" /usr/local/bin/helm; \
    rm -rf "/tmp/linux-${arch}"; \
    kubectl version --client >/dev/null; \
    helm version --short

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY control-plane/package.json control-plane/bun.lock control-plane/tsconfig.json ./
COPY control-plane/src ./src

# The tenant chart travels inside the image rather than being fetched at
# provision time: one artefact to promote, and a control-plane can never
# install a chart revision it was not tested against. CP_HELM_CHART_PATH can
# still be pointed elsewhere (a mounted chart, an unpacked OCI pull) if an
# operator wants to decouple them.
COPY deploy/helm/arigami-tenant /charts/arigami-tenant

# Everything writable lives on /data (the chart's PVC): the sqlite state file,
# the backup archives, and helm's own cache/config/data dirs — helm writes to
# $HOME by default and $HOME in this image is read-only image layer.
# Kubernetes credentials come from the in-cluster ServiceAccount token, so
# there is no kubeconfig to mount and KUBECONFIG stays unset on purpose.
ENV HOME=/data/home \
    CP_PORT=8090 \
    CP_DB_PATH=/data/control-plane.db \
    CP_BACKUP_DIR=/data/backups \
    CP_HELM_CHART_PATH=/charts/arigami-tenant \
    HELM_CACHE_HOME=/data/.helm/cache \
    HELM_CONFIG_HOME=/data/.helm/config \
    HELM_DATA_HOME=/data/.helm/data

# F8 parity with the host image: what the deployed service reports about itself.
ARG ARIGAMI_CP_IMAGE=arigami-control-plane:local
ARG ARIGAMI_CP_COMMIT=
ENV ARIGAMI_CP_IMAGE=${ARIGAMI_CP_IMAGE} \
    ARIGAMI_CP_COMMIT=${ARIGAMI_CP_COMMIT}

COPY control-plane/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

# Own /data in the image layer. Two reasons: a one-off `docker run <image>
# helm version` must not trip the entrypoint's writability guard, and a fresh
# named docker volume inherits the mount point's ownership — so `docker run -v
# data:/data` just works instead of needing a manual chown. Neither weakens
# the guard where it matters: a host bind-mount keeps the host's ownership,
# and under Kubernetes the PVC's owner is decided by the chart's fsGroup.
RUN install -d -o 1000 -g 1000 /data

# uid/gid 1000, shipped by the base image. The chart pins runAsUser to the same
# number and sets fsGroup so the kubelet hands over the PVC already owned.
USER bun

VOLUME ["/data"]
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bun", "src/index.ts"]
