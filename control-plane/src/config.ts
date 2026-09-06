// Env contract for the control-plane. Every knob an operator needs is read
// here, once, at boot — see docs/CONTROL-PLANE.md for the full reference.
import path from 'node:path';

const bool = (v: string | undefined, def: boolean): boolean => {
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
};
const csv = (v: string | undefined): string[] =>
  String(v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export interface Config {
  port: number;
  publicUrl: string; // this service's own origin, used to build the OIDC redirect_uri
  dbPath: string;
  cookieDays: number;
  trustProxy: boolean;

  // OIDC (same library/flow shape as server/auth.ts, reimplemented locally —
  // this is a separately deployable service, not an import of server/).
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  // Comma-separated domains, e.g. "example.com,example.org". Empty = nobody
  // can sign up (safe default). A literal "*" entry = open signup — anyone
  // who authenticates with the configured OIDC provider gets in, regardless
  // of email domain (see domains.ts). Meant for the solo-operator/demo case
  // that has no company domain to gate on.
  allowedEmailDomains: string[];

  // Org config (PRD §2 "Customisation"): what a freshly provisioned tenant
  // gets, with no per-tenant input from the signing-in user.
  orgDomain: string; // tenants live at u-<id>.<orgDomain>
  orgName: string; // shown to users while their workspace is being built ("Applying <name>'s setup")
  urlScheme: 'http' | 'https'; // https for any real domain; the k3d/dev proof uses plain http (no TLS in-cluster)
  imageRepository: string;
  imageTag: string; // a digest (sha256:...) or a tag — whichever the org pins
  arigamiBundle: string; // git URL (or empty = no bundle)
  arigamiBundleRef: string; // documented-not-implemented, see docs/CONTROL-PLANE.md

  // Provisioner
  helmChartPath: string;
  helmReleasePrefix: string; // "u-" — release/namespace name = prefix + tenant id
  helmExtraValuesFile: string; // optional extra -f layered on every install (e.g. a k3d/stub overlay)
  helmTimeoutSec: number;
  ingressClassName: string;
  // Namespaces the tenant NetworkPolicy accepts ingress from. The chart has no
  // default and refuses to render without at least one (arigami-tenant 0.2.0),
  // because getting it wrong makes a healthy-looking tenant unreachable.
  ingressNamespaces: string[];

  // K8S-3 — reconcile / upgrades / backups
  tenantPort: number; // the port the tenant host listens on in-pod (chart service.port)
  reconcileSec: number; // 0 = reconcile loop off (tests, one-shot CLI use)
  backupDir: string; // where per-tenant backup archives land on the control-plane's own disk
  backupIntervalSec: number; // 0 = no scheduled backups (on-demand only)
  backupKeep: number; // newest N archives kept per tenant
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.CP_PORT || 8090);
  return {
    port,
    publicUrl: (env.CP_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dbPath: env.CP_DB_PATH || path.join(process.cwd(), 'data', 'control-plane.db'),
    cookieDays: Number(env.CP_COOKIE_DAYS || 30),
    trustProxy: bool(env.CP_TRUST_PROXY, false),

    oidcIssuer: env.CP_OIDC_ISSUER || '',
    oidcClientId: env.CP_OIDC_CLIENT_ID || '',
    oidcClientSecret: env.CP_OIDC_CLIENT_SECRET || '',
    allowedEmailDomains: csv(env.ALLOWED_EMAIL_DOMAINS),

    orgDomain: env.CP_ORG_DOMAIN || 'localtest.me',
    orgName: env.CP_ORG_NAME || 'your organisation',
    urlScheme: (env.CP_URL_SCHEME as 'http' | 'https') || 'https',
    imageRepository: env.CP_IMAGE_REPOSITORY || 'ghcr.io/maor700/arigami',
    imageTag: env.CP_IMAGE_TAG || 'latest',
    arigamiBundle: env.CP_ARIGAMI_BUNDLE || '',
    arigamiBundleRef: env.CP_ARIGAMI_BUNDLE_REF || '',

    helmChartPath: env.CP_HELM_CHART_PATH || path.join(process.cwd(), '..', 'deploy', 'helm', 'arigami-tenant'),
    helmReleasePrefix: env.CP_RELEASE_PREFIX || 'u-',
    helmExtraValuesFile: env.CP_HELM_EXTRA_VALUES || '',
    helmTimeoutSec: Number(env.CP_HELM_TIMEOUT_SEC || 120),
    ingressClassName: env.CP_INGRESS_CLASS || '',
    ingressNamespaces: csv(env.CP_INGRESS_NAMESPACES),

    tenantPort: Number(env.CP_TENANT_PORT || 3099),
    reconcileSec: Number(env.CP_RECONCILE_SEC ?? 60),
    backupDir: env.CP_BACKUP_DIR || path.join(process.cwd(), 'data', 'backups'),
    backupIntervalSec: Number(env.CP_BACKUP_INTERVAL_SEC ?? 86_400),
    backupKeep: Number(env.CP_BACKUP_KEEP || 7),
  };
}
