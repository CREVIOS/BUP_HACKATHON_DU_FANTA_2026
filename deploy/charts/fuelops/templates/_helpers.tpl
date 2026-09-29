{{- define "fuelops.image" -}}{{ .Values.image.repository }}:{{ .Values.image.tag }}{{- end -}}
{{- define "fuelops.labels" -}}
app.kubernetes.io/part-of: fuelops
app: {{ . }}
{{- end -}}
{{- define "fuelops.probes" -}}
readinessProbe:
  httpGet: { path: /healthz, port: http }
  periodSeconds: 5
  failureThreshold: 2
# Liveness is TCP only: /healthz pings the DB, and a DB outage must degrade, not restart-loop.
livenessProbe:
  tcpSocket: { port: http }
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 6
{{- end -}}
{{- define "fuelops.pod" -}}
{{- $root := .root -}}
securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532 }
nodeSelector: { kubernetes.io/arch: amd64 }
containers:
  - name: {{ .name }}
    image: {{ include "fuelops.image" $root }}
    args: [{{ .name | quote }}]
    ports: [{ name: http, containerPort: {{ .port }} }]
    # Shared infrastructure settings; bearer tokens are injected only into api below.
    envFrom: [{ secretRef: { name: fuelops-env } }]
    env:
      - { name: HTTP_ADDR, value: ":{{ .port }}" }
      - { name: INTEL_URL, value: "http://intel:8082" }
      {{- if eq .name "api" }}
      - { name: REQUIRE_AUTH, value: "true" }
      - name: OPERATOR_TOKEN
        valueFrom:
          secretKeyRef: { name: fuelops-auth, key: OPERATOR_TOKEN, optional: false }
      - name: ADMIN_TOKEN
        valueFrom:
          secretKeyRef: { name: fuelops-auth, key: ADMIN_TOKEN, optional: false }
      {{- end }}
      {{- with $root.Values.otel }}{{- if .endpoint }}
      - { name: OTEL_EXPORTER_OTLP_ENDPOINT, value: {{ .endpoint | quote }} }
      - { name: OTEL_EXPORTER_OTLP_PROTOCOL, value: "grpc" }
      - { name: OTEL_RESOURCE_ATTRIBUTES, value: "deployment.environment={{ .environment | default "prod" }}" }
      {{- end }}{{- end }}
      {{- range $k, $v := .env }}
      - { name: {{ $k }}, value: {{ $v | quote }} }
      {{- end }}
      {{- with .extraEnv }}{{ toYaml . | nindent 6 }}{{ end }}
    resources:
      requests: { cpu: {{ .cpu | default "100m" }}, memory: 128Mi }
      limits: { memory: 512Mi }
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
    {{- include "fuelops.probes" . | nindent 4 }}
{{- end -}}
