# A public, multi-tenant Arigami lab on GKE — reproducible from code

One command's worth of cloud (`terraform apply`) plus three `kubectl apply`s gives you:
`https://<domain>` (the control plane: Google sign-in, then a workspace of your own) and `https://u-<id>.<domain>`
(each user's cockpit), reachable from a phone with no VPN. Everything here is generic — real project ids, domains and
IPs go in a `terraform.tfvars` / environment that is **not** in the repo.

```
deploy/gke-lab/
  terraform/        VPC, GKE (NetworkPolicy enforced), static IP, wildcard DNS            -> the cloud
  edge.yaml         Caddy in one namespace: TLS per hostname + routing                    -> the public edge
  chisel.yaml       outbound-only reverse tunnel server (control plane on another machine)
  tunnel.sh         the client side of it
  cp-local.sh       run the control plane outside the cluster (the no-ClusterRole shortcut)
  tenant-values.yaml  Helm values for every tenant behind that edge
```

## Bring-up

```sh
cd terraform && cp terraform.tfvars.example terraform.tfvars   # edit: project, domain, DNS zone, your IP
terraform init && terraform apply
eval "$(terraform output -raw get_credentials)"

export DOMAIN=lab.example.com DOMAIN_RE='lab\.example\.com' EDGE_IP=$(terraform output -raw edge_ip) \
       CP_UPSTREAM=chisel.edge.svc.cluster.local:18090 ACME_EMAIL=you@example.com
envsubst '${DOMAIN} ${DOMAIN_RE} ${EDGE_IP} ${CP_UPSTREAM} ${ACME_EMAIL}' < ../edge.yaml | kubectl apply -f -
kubectl -n edge create secret generic chisel-auth --from-literal=auth="lab:$(openssl rand -hex 16)"
kubectl apply -f ../chisel.yaml
# on the machine that runs the control plane:
AUTH_FILE=…/chisel.auth ../tunnel.sh &   &&   DOMAIN=… OIDC_CLIENT_ID=… OIDC_CLIENT_SECRET=… \
  ALLOWED_DOMAINS=example.com KUBECONFIG=… ../cp-local.sh
```

You also need **one Google OAuth web client** (Console → Google Auth Platform → Clients) with the redirect URI
`https://<domain>/auth/callback`, on a consent screen of type **Internal** (only your organisation's accounts can sign
in; anything else gets "access blocked: the app can only be used within its organization"). The first account to sign in
becomes org-admin and has no workspace of its own — the admin page's *Open my workspace* link (`/workspace`) makes one.

Tear down with `terraform destroy` (and delete the OAuth client). Every cluster carries an `expires` label so a forgotten
lab is findable; nothing deletes it for you.

## What it took to get here (symptom → cause → what is now encoded)

| Symptom | Cause | Where it is fixed |
|---|---|---|
| Tenants could curl each other although NetworkPolicies existed | the cluster was created **without** network policy enforcement — policies are inert objects | `terraform/main.tf` (`network_policy` + addon) |
| Every DNS lookup in a tenant timed out, egress by IP worked ("token exchange timed out") | NodeLocal DNSCache answers on the kube-dns *Service IP*; the policy allowed only the kube-dns *pods* | `deploy/helm/arigami-tenant/templates/networkpolicy.yaml` (reads the Service IP with `lookup`, + `dnsServiceCidrs`) |
| "Open a browser" in a session did nothing | Chrome needs `--no-sandbox` in a pod, and was only given it when `/.dockerenv` exists (containerd pods have none) | `server/lib/chrome.ts` (also detects `KUBERNETES_SERVICE_HOST`), tenant chart sets `CHROME_NO_SANDBOX=1` |
| Linear: "redirect_uris invalid … plaintext HTTP is allowed only for loopback" | TLS ends at the edge, so the tenant thought its public origin was `http://` | `tenant-values.yaml` (`ingress.tls.enabled: true` ⇒ `ARIGAMI_PUBLIC_URL=https://…`) |
| The address died for minutes, then came back with a *new* certificate | Spot node preempted → the edge pod restarted on an `emptyDir` and lost its certs | on-demand node pool, certificates on a PVC (`edge.yaml`) |
| Browsers on UDP-filtering networks stalled | Caddy advertised HTTP/3 but only TCP/443 is open | `servers { protocols h1 h2 }` |
| `helm install ingress-nginx` / cert-manager / the control-plane chart failed | creating a `ClusterRole` needs `container.clusterRoles.create` (IAM `roles/container.admin`) — a project member without it can still install namespaced charts | this lab's edge uses **no cluster-scoped objects**; with the IAM role use the proper way below |
| Control plane on a locked-down VM unreachable from the cluster | the VM's firewall denies all inbound (deliberately); Tailscale Funnel was unreliable | outbound-only chisel tunnel (`chisel.yaml`, `tunnel.sh`) |
| The first sign-in landed on an empty "No tenants yet" page | an org-admin has no workspace by design | control plane: `/workspace` + a link on the admin page |
| `Release image` / CI red for days, so no image carried any of this | a placeholder tailnet host tripped the public-readiness gate; a test assumed no account exists | `test/no-internal-refs.test.js`, `test/core.test.js` |

## The proper way (with `roles/container.admin`)

Skip `edge.yaml`, `chisel.yaml`, `tunnel.sh` and `cp-local.sh`: install `ingress-nginx` (with
`controller.service.loadBalancerIP=$(terraform output -raw edge_ip)`), `cert-manager` (a `ClusterIssuer` for Let's
Encrypt; HTTP-01 needs no DNS permissions), then `deploy/helm/arigami-control-plane` in-cluster with
`config.orgDomain`, `config.tenantIngressClass=nginx`, `config.tenantIngressNamespaces=ingress-nginx`,
`ingress.host=<domain>` and `tenantValues` carrying the cert-manager annotation / `ingress.tls.enabled`. Put an
authenticating proxy (oauth2-proxy / Pomerium / IAP) in front of the tenants if you want org SSO *before* a request
reaches a cockpit — in this lab only the control plane's own sign-in and each tenant's handoff cookie stand there.
**This path is written down, not tested.**

## Not covered / known gaps

* A new image is needed for tenants to apply a profile bundle that carries extensions (`CP_ARIGAMI_BUNDLE`, and
  `CP_ARIGAMI_GIT_TOKEN` for a private repo) — see `profiles/README.md`. The published image only moves when `Release
  image` is green on master.
* Shipping a new profile version to tenants that already exist is not wired (the bundle is applied once, at first boot).
* Terraform here has been `validate`d and `plan`ned against a real project; the in-cluster pieces ran by hand, and
  `edge.yaml` was checked against the live objects (identical apart from comments).
