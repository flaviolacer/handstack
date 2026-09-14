{{- define "handstack.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "handstack.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{- else }}{{ include "handstack.name" . }}{{- end -}}
{{- end -}}
{{- define "handstack.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "handstack.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "handstack.selector" -}}
app.kubernetes.io/name: {{ include "handstack.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "handstack.secretName" -}}
{{- if .Values.externalSecrets.secretName }}{{ .Values.externalSecrets.secretName }}{{- else }}{{ include "handstack.fullname" . }}-secrets{{- end -}}
{{- end -}}
{{- define "handstack.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ include "handstack.fullname" . }}{{- else }}default{{- end -}}
{{- end -}}
{{- define "handstack.env" -}}
- name: HANDSTACK_DEPLOYMENT_PROFILE
  value: {{ .Values.deploymentProfile | quote }}
- name: HANDSTACK_DATABASE_ADAPTER
  value: {{ .Values.database.adapter | quote }}
- name: HANDSTACK_REDIS_TOPOLOGY
  value: {{ .Values.queue.topology | quote }}
- name: HANDSTACK_DATABASE_URL
  valueFrom: { secretKeyRef: { name: {{ include "handstack.secretName" . }}, key: database-url } }
- name: HANDSTACK_REDIS_URL
  valueFrom: { secretKeyRef: { name: {{ include "handstack.secretName" . }}, key: redis-url } }
{{- end -}}
{{- define "handstack.probes" -}}
readinessProbe:
  httpGet: { path: /health/ready, port: {{ .port }} }
  periodSeconds: 10
  failureThreshold: 3
livenessProbe:
  httpGet: { path: /health/live, port: {{ .port }} }
  periodSeconds: 20
  failureThreshold: 3
{{- end -}}
{{- define "handstack.spread" -}}
{{- if .Values.topologySpread }}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
    labelSelector: { matchLabels: {{ include "handstack.selector" . | nindent 26 }} }
{{- end -}}
{{- end -}}
