{{/*
Chart name, truncated/sanitized per Helm convention.
*/}}
{{- define "arigami-tenant.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Full release name — defaults to the tenant id so objects read as
"arigami-u-<id>" rather than a generic release name.
*/}}
{{- define "arigami-tenant.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "arigami-%s" .Values.tenant.id | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "arigami-tenant.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "arigami-tenant.labels" -}}
helm.sh/chart: {{ include "arigami-tenant.chart" . }}
{{ include "arigami-tenant.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
arigami.dev/tenant: {{ .Values.tenant.id | quote }}
{{- end -}}

{{- define "arigami-tenant.selectorLabels" -}}
app.kubernetes.io/name: {{ include "arigami-tenant.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "arigami-tenant.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "arigami-tenant.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Ingress host: explicit .Values.ingress.host wins, else derived from the
tenant id + domain (u-<id>.<domain> — PRD-ARIGAMI-K8S.md §2).
*/}}
{{- define "arigami-tenant.ingressHost" -}}
{{- if .Values.ingress.host -}}
{{- .Values.ingress.host -}}
{{- else -}}
{{- printf "u-%s.%s" .Values.tenant.id .Values.ingress.domain -}}
{{- end -}}
{{- end -}}

{{/*
Public origin (ARIGAMI_PUBLIC_URL): https when ingress TLS is on, http
otherwise — e.g. for the plain k3d/localtest.me mechanics proof.
*/}}
{{- define "arigami-tenant.publicUrl" -}}
{{- $scheme := "http" -}}
{{- if .Values.ingress.tls.enabled -}}
{{- $scheme = "https" -}}
{{- end -}}
{{- printf "%s://%s" $scheme (include "arigami-tenant.ingressHost" .) -}}
{{- end -}}

{{/*
Image reference. K8S-3: the control-plane pins tenants to a DIGEST
(`desired_digest`, e.g. "sha256:ab…") — a digest is joined with `@`, a plain
tag with `:`. Without this, `image.tag=sha256:…` would render the invalid
"repo:sha256:…" and every provision/upgrade with a pinned digest would fail
at pull time.
*/}}
{{- define "arigami-tenant.imageRef" -}}
{{- if hasPrefix "sha256:" .Values.image.tag -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.tag -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "arigami-tenant.secretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- include "arigami-tenant.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
Namespaces whose pods may reach this tenant. Returns a JSON array so the
NetworkPolicy can range over it.

`networkPolicy.ingressNamespaces` is the current key. The older singular
`networkPolicy.ingressNamespace` still works and is appended, so an existing
values file keeps rendering the same policy — this used to be a single
namespace, which is wrong wherever the request path crosses two of them (an
Envoy/Contour namespace plus an auth proxy such as Pomerium, for instance).
*/}}
{{- define "arigami-tenant.ingressNamespaces" -}}
{{- $out := list -}}
{{- range (.Values.networkPolicy.ingressNamespaces | default list) -}}
{{- $out = append $out . -}}
{{- end -}}
{{- if .Values.networkPolicy.ingressNamespace -}}
{{- $out = append $out .Values.networkPolicy.ingressNamespace -}}
{{- end -}}
{{- if not $out -}}
{{- fail "networkPolicy.ingressNamespaces must list at least one namespace (the ingress controller's) — with none, the policy makes the tenant unreachable" -}}
{{- end -}}
{{- $out | uniq | toJson -}}
{{- end -}}

{{/*
Tenant isolation (values `isolation`, off by default). Everything below renders only when it is on; with it off the
chart's output is byte-identical to before it existed.
*/}}
{{- define "arigami-tenant.egressProxyOn" -}}
{{- if and .Values.isolation.enabled .Values.isolation.egressProxy.enabled -}}true{{- end -}}
{{- end -}}

{{- define "arigami-tenant.gatekeeperOn" -}}
{{- if and .Values.isolation.enabled .Values.isolation.gatekeeper.enabled -}}true{{- end -}}
{{- end -}}

{{/* Name of this tenant's egress proxy objects (in isolation.egressProxy.namespace). */}}
{{- define "arigami-tenant.egressName" -}}
{{- printf "arigami-egress-%s" .Values.tenant.id | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "arigami-tenant.egressUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%v" (include "arigami-tenant.egressName" .) .Values.isolation.egressProxy.namespace .Values.isolation.egressProxy.port -}}
{{- end -}}

{{/*
The gatekeeper's proxy password: kept across upgrades (read back from the Secret it lives in), random on first install.
*/}}
{{- define "arigami-tenant.egressPassword" -}}
{{- $ep := .Values.isolation.egressProxy -}}
{{- if not (hasKey $ep "_password") -}}
{{- $name := printf "%s-egress-auth" (include "arigami-tenant.fullname" .) -}}
{{- $have := lookup "v1" "Secret" .Release.Namespace $name -}}
{{- if and $have $have.data (hasKey $have.data "password") -}}
{{- $_ := set $ep "_password" (index $have.data "password" | b64dec) -}}
{{- else -}}
{{- $_ := set $ep "_password" (randAlphaNum 40) -}}
{{- end -}}
{{- end -}}
{{- $ep._password -}}
{{- end -}}

{{/*
Egress to the cluster DNS — shared by the tenant policy and its egress proxy's policy.
*/}}
{{- define "arigami-tenant.dnsEgressRule" -}}
# Cluster DNS. Without this nothing resolves and every other rule is moot.
#
# Two ways a pod reaches DNS, and a policy must allow both:
#   - the kube-dns pods themselves (the namespaceSelector), and
#   - the kube-dns Service IP. With NodeLocal DNSCache (GKE's default) the node answers on that IP locally, so the
#     packet is never rewritten to a kube-dns pod and the selector above does not match it — every lookup times out
#     while egress by IP works. The Service IP is read from the cluster when the chart is rendered against one
#     (`lookup`), and `networkPolicy.egress.dnsServiceCidrs` adds any others.
- to:
    - namespaceSelector:
        matchLabels:
          {{ .Values.networkPolicy.ingressNamespaceLabelKey }}: {{ .Values.networkPolicy.egress.dnsNamespace | quote }}
    {{- $dnsSvc := lookup "v1" "Service" .Values.networkPolicy.egress.dnsNamespace "kube-dns" }}
    {{- if and $dnsSvc $dnsSvc.spec $dnsSvc.spec.clusterIP }}
    - ipBlock:
        cidr: {{ printf "%s/32" $dnsSvc.spec.clusterIP }}
    {{- end }}
    {{- range .Values.networkPolicy.egress.dnsServiceCidrs }}
    - ipBlock:
        cidr: {{ . | quote }}
    {{- end }}
  ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
{{- end -}}

{{/* The egress proxy's squid.conf (templates/egress-proxy.yaml). */}}
{{- define "arigami-tenant.squidConf" -}}
http_port {{ .Values.isolation.egressProxy.port }}
auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/auth/passwd
auth_param basic realm arigami-egress
auth_param basic children 2
acl gatekeeper proxy_auth gatekeeper
acl CONNECT method CONNECT
acl tls_port port 443
acl ip_literal dstdom_regex ^[0-9.]+$ ^\[?[0-9a-fA-F:]+\]?$
acl private_dst dst {{ join " " (concat .Values.networkPolicy.egress.exceptCidrs (list "169.254.0.0/16" "127.0.0.0/8" "fc00::/7" "fe80::/10" "::1")) }}
acl session_sites dstdomain {{ join " " .Values.isolation.egressProxy.sessionDomains }}
acl gatekeeper_sites dstdomain {{ join " " .Values.isolation.egressProxy.gatekeeperDomains }}
http_access deny !CONNECT
http_access deny !tls_port
http_access deny ip_literal
http_access deny private_dst
http_access allow session_sites
http_access allow gatekeeper_sites gatekeeper
http_access deny all
# The access log on stdout is the evidence: every allowed and denied destination (kubectl logs).
logformat arigami %{%Y-%m-%dT%H:%M:%S}tl %>a %Ss/%03>Hs %rm %ru %un
# hasRequest: a TCP connect with no request (the readiness probe) is not a destination — keep it out of the log.
acl hasRequest has request
access_log stdio:/dev/stdout arigami hasRequest
cache_log stdio:/dev/stderr
cache deny all
logfile_rotate 0
pid_filename none
coredump_dir /tmp
shutdown_lifetime 2 seconds
pinger_enable off
{{- end -}}
