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
securityContext: { runAsNonRoot: true }
nodeSelector: { kubernetes.io/arch: amd64 }
containers:
  - name: {{ .name }}
    image: {{ include "fuelops.image" $root }}
    args: [{{ .name | quote }}]
    ports: [{ name: http, containerPort: {{ .port }} }]
    envFrom: [{ secretRef: { name: fuelops-env } }]
    env:
      - { name: HTTP_ADDR, value: ":{{ .port }}" }
      - { name: INTEL_URL, value: "http://intel:8082" }
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
