{{- define "arigami-control-plane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "arigami-control-plane.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "arigami-control-plane.name" . -}}
{{- end -}}
{{- end -}}

{{- define "arigami-control-plane.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "arigami-control-plane.labels" -}}
helm.sh/chart: {{ include "arigami-control-plane.chart" . }}
{{ include "arigami-control-plane.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: control-plane
{{- end -}}

{{- define "arigami-control-plane.selectorLabels" -}}
app.kubernetes.io/name: {{ include "arigami-control-plane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "arigami-control-plane.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "arigami-control-plane.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Same digest-vs-tag rule as the tenant chart: a value starting with "sha256:"
is joined with @, anything else with :.
*/}}
{{- define "arigami-control-plane.imageRef" -}}
{{- if hasPrefix "sha256:" .Values.image.tag -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.tag -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "arigami-control-plane.secretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- include "arigami-control-plane.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
The control-plane's own public origin (CP_PUBLIC_URL) — it is baked into the
OIDC redirect_uri, so it must match what the IdP has registered exactly.
Explicit config.publicUrl wins; otherwise it is derived from the ingress host.
*/}}
{{- define "arigami-control-plane.publicUrl" -}}
{{- if .Values.config.publicUrl -}}
{{- .Values.config.publicUrl | trimSuffix "/" -}}
{{- else if .Values.ingress.enabled -}}
{{- $scheme := "http" -}}
{{- if .Values.ingress.tls.enabled -}}
{{- $scheme = "https" -}}
{{- end -}}
{{- printf "%s://%s" $scheme (required "ingress.host is required when ingress is enabled and config.publicUrl is unset" .Values.ingress.host) -}}
{{- else -}}
{{- printf "http://localhost:%d" (int .Values.service.port) -}}
{{- end -}}
{{- end -}}
