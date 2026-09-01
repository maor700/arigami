// The "browser" of the K8S-3 pilot proof: performs a REAL OIDC sign-in
// against the running control-plane (mock-idp.ts is the IdP) exactly as a
// browser would — /auth/login redirect, IdP authorize, /auth/callback with
// the state cookie — then follows / until the tenant is running. The one
// liberty taken: who signs in is chosen by appending &email/&sub to the
// authorize URL (the mock IdP's "login screen").
//
//   bun test/fixtures/live-pilot.ts <cp-url> <email> [timeout-sec]
// Prints JSON evidence; exit 0 only when the flow reached its terminal page
// (admin page for the first-ever user, tenant URL for everyone else).
const cp = (process.argv[2] || 'http://127.0.0.1:18090').replace(/\/$/, '');
const email = process.argv[3] || 'alice@fake-org.test';
const timeoutSec = Number(process.argv[4] || 300);
const sub = `sub-${email}`;

const cookieOf = (r: Response) => (r.headers.get('set-cookie') || '').split(';')[0];

async function signIn(): Promise<string> {
  const r1 = await fetch(`${cp}/auth/login`, { redirect: 'manual' });
  if (r1.status !== 302) throw new Error(`/auth/login: expected 302, got ${r1.status}: ${await r1.text()}`);
  const oidcCookie = cookieOf(r1);
  const authUrl = new URL(r1.headers.get('location')!);
  authUrl.searchParams.set('email', email);
  authUrl.searchParams.set('sub', sub);

  const r2 = await fetch(authUrl, { redirect: 'manual' });
  if (r2.status !== 302) throw new Error(`IdP authorize: expected 302, got ${r2.status}: ${await r2.text()}`);

  const r3 = await fetch(r2.headers.get('location')!, { redirect: 'manual', headers: { cookie: oidcCookie } });
  if (r3.status !== 302) throw new Error(`/auth/callback: expected 302, got ${r3.status}: ${await r3.text()}`);
  const sid = cookieOf(r3);
  if (!sid.startsWith('arigami_cp_sid=')) throw new Error(`callback set no session cookie (got: ${sid || 'nothing'})`);
  return sid;
}

const sid = await signIn();
const deadline = Date.now() + timeoutSec * 1000;
let last = '';
while (Date.now() < deadline) {
  const r = await fetch(`${cp}/`, { redirect: 'manual', headers: { cookie: sid } });
  if (r.status === 302) {
    const loc = r.headers.get('location')!;
    if (loc === '/admin') {
      const admin = await fetch(`${cp}/admin`, { headers: { cookie: sid } });
      console.log(JSON.stringify({ email, sub, landed: 'admin', adminStatus: admin.status }, null, 2));
      process.exit(admin.status === 200 ? 0 : 1);
    }
    console.log(JSON.stringify({ email, sub, landed: 'tenant', tenantUrl: loc }, null, 2));
    process.exit(0);
  }
  const body = await r.text();
  last = /starting/i.test(body) ? 'starting' : `status ${r.status}`;
  process.stderr.write(`[live-pilot] ${email}: ${last}, waiting…\n`);
  await new Promise((res) => setTimeout(res, 5000));
}
console.error(`[live-pilot] ${email}: timed out after ${timeoutSec}s (last: ${last})`);
process.exit(1);
