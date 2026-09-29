# HTTPS for FuelOps, Grafana, and Argo CD

The chosen deployment exposes `fuelops.hemal.me` and `argocd.hemal.me` through the
existing EKS Auto Mode ALB. Cloudflare manages DNS. Argo CD uses its own login;
Cloudflare Access and Tunnel are not part of this configuration.

| Hostname | Routing | Existing ACM certificate ID |
|---|---|---|
| `fuelops.hemal.me` | `/api` → `api:8000`; `/` → `web:80` in `fuelops` | `91b36eaf-9f79-4250-aac4-ae8401d5c892` |
| `argocd.hemal.me` | `/` → `argocd-server:443` in `argocd` | `97327450-e8d7-404a-8b48-dc7e5fef6039` |
| `fuelops.hemal.me/grafana/` | `/grafana` → `kps-grafana:80` in `monitoring` | Existing FuelOps certificate above |

Both certificate ARNs use the prefix
`arn:aws:acm:ap-southeast-1:373220260649:certificate/`. They are configured in
`infra/variables.tf` as `alb_certificate_arns`. Terraform references these existing
certificates; it does not create, import, renew, or delete them. Their issuance,
hostname coverage, expiry, and live attachment still require verification.

## Configuration ownership

- Terraform passes both ARNs to the platform chart's
  `IngressClassParams.spec.certificateARNs`. The ALB uses SNI to select a certificate
  for the requested hostname; the first certificate is the default.
- The platform chart owns the Argo CD Ingress. `argocd_ingress_enabled` defaults to
  `true` for the selected public deployment. Set it to `false` persistently to
  remove only this ingress and restore Argo's localhost external URL. This setting
  does not disable or delete the FuelOps Application.
- `argocd_hostname` defaults to `argocd.hemal.me`. Terraform also sets Argo's
  external URL accordingly. Argo keeps server TLS and authentication enabled,
  with anonymous access disabled. The ALB forwards to Argo over HTTPS and probes
  `/healthz` over HTTPS. Its browser-facing ACM certificate is separate from
  Argo's internal server certificate.
- The FuelOps hostname is Git-owned in `deploy/charts/fuelops/values.yaml` under
  `ingress.hostname`. The chart uses host-specific paths and forwards to the
  existing HTTP Services inside the VPC.
- The web Deployment sets `API_PROXY_TARGET=http://api:8000` for its server-side
  AI routes. Browser `/api` requests go directly through the ALB's API rule.
- Both ingresses declare HTTP `80`, HTTPS `443`, and an HTTP-to-HTTPS redirect.
  They share the existing `alb` class and `fuelops` ALB group. The redirect affects
  the shared HTTP listener, so deploy these settings together in a controlled
  window. A transition from an old hostless/HTTP chart can temporarily affect
  access; retaining old image tags alone does not retain the old ingress behavior.
- Grafana is published at `https://fuelops.hemal.me/grafana/`, with its own login
  required, anonymous access/signup disabled, and secure session cookies. The
  platform chart owns a separate ingress in `monitoring`, ordered before the
  FuelOps catch-all rule. It forwards `/grafana` unchanged; Grafana's root URL,
  subpath serving, health probes, and local sidecar reload URLs all match it.
  No new ACM certificate or Cloudflare DNS record is needed.
- `grafana_ingress_enabled=false` persistently restores private-only Grafana,
  `http://localhost:3000/`, and cookies usable over the local HTTP tunnel. In
  public mode, use the HTTPS URL for login; the HTTP port-forward is useful for
  health checks but cannot carry the Secure session cookie.
- The Rollouts dashboard retains private port-forward access.

This follows the [EKS Auto Mode ALB configuration](https://docs.aws.amazon.com/eks/latest/userguide/auto-configure-alb.html).
The ALB supports [HTTPS targets with self-signed server certificates](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html#target-group-routing-configuration).
For the Argo CLI, use gRPC-web through the HTTP ingress rather than native gRPC:

```bash
argocd login argocd.hemal.me --grpc-web
```

## Before deployment

1. Confirm both certificates show **Issued** in ACM, region **Singapore
   (`ap-southeast-1`)**, in account `373220260649`. Each certificate must cover its
   corresponding hostname and be unexpired. For a CLI check using an already
   authorized AWS identity:

   ```bash
   aws acm describe-certificate --region ap-southeast-1 \
     --certificate-arn arn:aws:acm:ap-southeast-1:373220260649:certificate/91b36eaf-9f79-4250-aac4-ae8401d5c892 \
     --query 'Certificate.{Status:Status,Names:SubjectAlternativeNames,Expires:NotAfter}'
   aws acm describe-certificate --region ap-southeast-1 \
     --certificate-arn arn:aws:acm:ap-southeast-1:373220260649:certificate/97327450-e8d7-404a-8b48-dc7e5fef6039 \
     --query 'Certificate.{Status:Status,Names:SubjectAlternativeNames,Expires:NotAfter}'
   ```

2. Keep the ACM validation CNAMEs in Cloudflare, **DNS only**, for renewal. Cloudflare
   may shorten `_token.fuelops.hemal.me.` to `_token.fuelops` in the Name field;
   it still belongs to the `hemal.me` zone. Copy the complete AWS-provided Target.
   These validation records are separate from the application CNAMEs below.
3. Verify the operator-owned `fuelops-auth` Secret contains nonempty
   `OPERATOR_TOKEN` and `ADMIN_TOKEN` keys. The chart requires these only for the
   API and the new backend image enforces `REQUIRE_AUTH=true`. Follow the
   [access/auth rollout procedure](OPERATOR_ACCESS_AUTH.md) to deploy both together.
4. Verify Argo's current administrator credentials through its private port-forward
   before exposing its login. Keep operator Kubernetes access during the change.
5. Pin the existing healthy Argo Application revision and pause automatic sync
   before merging chart changes. Review the actual Terraform state and plan,
   including namespace adoption, chart updates, and OIDC ownership. Keep
   `enable_application=true` for an existing environment. Refer to
   [the infrastructure runbook](../infra/README.md#adopting-an-existing-environment).

## Apply and create DNS records

1. After CI succeeds, merge and wait for the `deploy` workflow to publish both
   images and commit their full tags. Record the subsequent image-tag commit SHA.
2. Review/apply the Terraform platform changes with Argo still pinned to the old
   working application revision, then promote the reviewed new chart revision.
   Use a controlled window for the listener/host transition described above.
   The GitHub `infra` workflow's `apply` dispatch creates a fresh plan; it does not
   reuse a previous `plan` dispatch. Apply a saved reviewed plan locally when
   exact plan reuse is required.
3. Inspect both ingresses and wait for their common ALB hostname:

   ```bash
   kubectl -n fuelops get ingress fuelops
   kubectl -n argocd get ingress argocd
   kubectl -n monitoring get ingress grafana
   kubectl -n fuelops get ingress fuelops \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}{"\n"}'
   ```

4. In Cloudflare → `hemal.me` → DNS, create these records using the hostname from
   Kubernetes (no `https://`, port, or path):

   | Type | Name | Target | Initial proxy status |
   |---|---|---|---|
   | CNAME | `fuelops` | Shared ALB hostname | DNS only |
   | CNAME | `argocd` | Shared ALB hostname | DNS only |

   DNS-only uses the ACM certificates directly. If Cloudflare proxying is enabled
   later, use **Full (strict)** and verify the Cloudflare edge certificate is active
   for both names. Do not use Flexible mode with an origin HTTPS redirect.

## Verify

```bash
curl -I http://fuelops.hemal.me
curl -I https://fuelops.hemal.me
curl -I http://argocd.hemal.me
curl -I https://argocd.hemal.me
curl -I http://fuelops.hemal.me/grafana/
curl -I https://fuelops.hemal.me/grafana/login
curl -fsS https://fuelops.hemal.me/grafana/api/health
curl -fsS https://fuelops.hemal.me/api/me
```

HTTP must redirect to the matching HTTPS hostname. HTTPS requests must succeed
without disabling certificate verification. Confirm the FuelOps UI/API routes,
Argo's login requirement and post-login application view, and healthy ALB target
groups. After token wiring, unauthenticated `/api/me` must report `auth_enabled:
true` and `role: viewer`. Check real data and telemetry as described in the
infrastructure runbook; an HTTP success alone does not prove deployment health.

Confirm Grafana redirects to `/grafana/login`, loads its CSS/JavaScript below
`/grafana/`, and requires credentials for dashboards/datasource APIs. Use the
existing Grafana login. Verify public root `/` still serves FuelOps and `/api`
still reaches its API. Dashboard/datasource sidecar logs must show successful
local reloads, and `/grafana/api/health` must report a healthy database. The
health endpoint is intentionally available without login for the ALB probe.

If connectivity fails, inspect `kubectl describe ingress` in each namespace and
the ALB listeners/target health. A wrong region, pending certificate, incorrect
DNS target, or HTTP health check against Argo's TLS endpoint can prevent access.
Fix the Terraform/Helm source configuration so a later reconciliation preserves it.
