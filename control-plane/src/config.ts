// Env contract for the control-plane. Every knob an operator needs is read
// here, once, at boot — see docs/CONTROL-PLANE.md for the full reference.
import fs from 'node:fs';
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

export type TierOverlay = Record<string, unknown>;

export interface Config {
  port: number;
  publicUrl: string; // this service's own origin, used to build the OIDC redirect_uri
  dbPath: string;
  cookieDays: number;
  trustProxy: boolean;
  /**
   * Scope the session cookie to the org domain (Domain=<orgDomain>) so the browser also sends it to
   * u-<id>.<orgDomain>, where the edge asks GET /auth/verify whether to let the request through (src/gate.ts).
   * Off by default: a host-only cookie is the smaller blast radius when no edge gate is in use.
   */
  cookieParentDomain: boolean;

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
  arigamiBundleRef: string; // tag / branch / sha the profile rollout converges every tenant to (empty = default branch)
  /** read-only token for the org's private profile repo (and the extensions in it); handed to each tenant as ARIGAMI_GIT_TOKEN. Empty = public repo. */
  arigamiGitToken: string;

  // Provisioner
  helmChartPath: string;
  helmReleasePrefix: string; // "u-" — release/namespace name = prefix + tenant id
  helmExtraValuesFile: string; // optional extra -f layered on every install (e.g. a k3d/stub overlay)
  helmTimeoutSec: number;
  /** Hardware tiers (src/tier.ts): name -> Helm values overlay, layered LAST on a tenant's install. Empty = no tiers (every tenant gets the same values). */
  tiers: Record<string, TierOverlay>;
  /** The tier a tenant with no explicit one gets. Always a key of `tiers` when `tiers` is non-empty. */
  defaultTier: string;
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

  // Profile rollout (src/profile-rollout.ts): converge running tenants to CP_ARIGAMI_BUNDLE @ CP_ARIGAMI_BUNDLE_REF
  profileRollout: boolean; // on by default whenever CP_ARIGAMI_BUNDLE is set; CP_PROFILE_ROLLOUT=0 turns it off
  profileRetryBaseSec: number; // first retry delay after a failed apply; doubles per failure
  profileRetryMaxSec: number; // backoff ceiling
  profileRecheckSec: number; // re-read a converged tenant's provenance this often (drift); 0 = never
  profileBatch: number; // max applies per tick (0 = no limit) — a slower canary
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = readConfig(env);
  // A browser silently drops a Set-Cookie whose Domain does not cover the host that sent it — every sign-in
  // would "work" and the gate would still see no session. Refuse to boot instead.
  if (cfg.cookieParentDomain) {
    const host = new URL(cfg.publicUrl).hostname.toLowerCase();
    const org = cfg.orgDomain.toLowerCase();
    if (host !== org && !host.endsWith(`.${org}`)) {
      throw new Error(`CP_COOKIE_PARENT_DOMAIN=1 needs CP_PUBLIC_URL (${host}) to be ${org} or a name under it`);
    }
  }
  return cfg;
}

const TIER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * CP_TIERS: a JSON object, inline (starts with "{") or the path to a JSON file (what the Helm chart mounts).
 * {"<tier>": {<Helm values overlay>}, ...}. Throws a message that names the problem — boot refuses on it.
 */
export function parseTiers(raw: string): Record<string, TierOverlay> {
  const src = raw.trim();
  if (!src) return {};
  let text = src;
  if (!src.startsWith('{') && !src.startsWith('[')) {
    try {
      text = fs.readFileSync(src, 'utf8');
    } catch (e) {
      throw new Error(`CP_TIERS is neither inline JSON nor a readable file (${src}): ${(e as Error).message}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`CP_TIERS is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CP_TIERS must be a JSON object mapping tier name to a Helm values overlay');
  const out: Record<string, TierOverlay> = {};
  for (const [name, overlay] of Object.entries(parsed as Record<string, unknown>)) {
    if (!TIER_NAME_RE.test(name)) throw new Error(`CP_TIERS: tier name "${name}" is invalid (letters, digits, . _ - ; at most 32 characters)`);
    if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) throw new Error(`CP_TIERS: tier "${name}" must be an object of Helm values`);
    const o = overlay as TierOverlay;
    if ('tenant' in o) throw new Error(`CP_TIERS: tier "${name}" sets "tenant" — the tenant identity is owned by the control plane`);
    const size = (o.persistence as { size?: unknown } | undefined)?.size;
    if (size !== undefined && (typeof size !== 'string' || !/^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|k|M|G|T|P)?$/.test(size)))
      throw new Error(`CP_TIERS: tier "${name}" persistence.size must be a Kubernetes quantity string such as "50Gi"`);
    out[name] = o;
  }
  return out;
}

function readConfig(env: NodeJS.ProcessEnv): Config {
  const port = Number(env.CP_PORT || 8090);
  const tiers = parseTiers(env.CP_TIERS || '');
  const defaultTier = (env.CP_DEFAULT_TIER || 'standard').trim();
  if (Object.keys(tiers).length && !(defaultTier in tiers))
    throw new Error(`CP_DEFAULT_TIER "${defaultTier}" is not a tier in CP_TIERS (${Object.keys(tiers).join(', ')}) — set CP_DEFAULT_TIER`);
  if (!Object.keys(tiers).length && env.CP_DEFAULT_TIER && defaultTier !== 'standard')
    throw new Error(`CP_DEFAULT_TIER "${defaultTier}" is set but CP_TIERS defines no tiers`);
  return {
    port,
    publicUrl: (env.CP_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dbPath: env.CP_DB_PATH || path.join(process.cwd(), 'data', 'control-plane.db'),
    cookieDays: Number(env.CP_COOKIE_DAYS || 30),
    trustProxy: bool(env.CP_TRUST_PROXY, false),
    cookieParentDomain: bool(env.CP_COOKIE_PARENT_DOMAIN, false),

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
    arigamiGitToken: env.CP_ARIGAMI_GIT_TOKEN || '',

    helmChartPath: env.CP_HELM_CHART_PATH || path.join(process.cwd(), '..', 'deploy', 'helm', 'arigami-tenant'),
    helmReleasePrefix: env.CP_RELEASE_PREFIX || 'u-',
    helmExtraValuesFile: env.CP_HELM_EXTRA_VALUES || '',
    helmTimeoutSec: Number(env.CP_HELM_TIMEOUT_SEC || 120),
    tiers,
    defaultTier,
    ingressClassName: env.CP_INGRESS_CLASS || '',
    ingressNamespaces: csv(env.CP_INGRESS_NAMESPACES),

    tenantPort: Number(env.CP_TENANT_PORT || 3099),
    reconcileSec: Number(env.CP_RECONCILE_SEC ?? 60),
    backupDir: env.CP_BACKUP_DIR || path.join(process.cwd(), 'data', 'backups'),
    backupIntervalSec: Number(env.CP_BACKUP_INTERVAL_SEC ?? 86_400),
    backupKeep: Number(env.CP_BACKUP_KEEP || 7),

    profileRollout: bool(env.CP_PROFILE_ROLLOUT, true),
    profileRetryBaseSec: Number(env.CP_PROFILE_RETRY_BASE_SEC || 60),
    profileRetryMaxSec: Number(env.CP_PROFILE_RETRY_MAX_SEC || 3600),
    profileRecheckSec: Number(env.CP_PROFILE_RECHECK_SEC ?? 3600),
    profileBatch: Number(env.CP_PROFILE_BATCH || 0),
  };
}
