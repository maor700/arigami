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

{{- define "arigami-tenant.secretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- include "arigami-tenant.fullname" . -}}
{{- end -}}
{{- end -}}
