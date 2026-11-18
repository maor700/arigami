// PID 1's child in a sandboxed session's container (server/lib/sandbox-launch.ts runs it through `--init`):
//   bun init.ts --forward <port> --relay <host:port> -- <engine> <args…>
// Opens 127.0.0.1:<port> inside the container and forwards it to the egress container's host relay, so the
// session's ARIGAMI_URL (http://127.0.0.1:<host port>) reaches its own host exactly as it does outside a sandbox —
// for the engine, its MCP client, the policy hook and any curl in a skill. Then runs the engine with this process's
// stdio (the host's pipes) and exits with its code. Writes nothing to stdout: that is the engine's protocol stream.
import net from 'node:net';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = sep >= 0 ? argv.slice(0, sep) : [];
const cmd = sep >= 0 ? argv.slice(sep + 1) : argv;
const opt = (n: string) => { const i = opts.indexOf(n); return i >= 0 ? opts[i + 1] : undefined; };
const port = Number(opt('--forward'));
const [relayHost, relayPort] = String(opt('--relay') || '').split(':');
const log = (m: string) => process.stderr.write(`[sandbox-init] ${m}\n`);

if (port && relayHost && relayPort) {
  const srv = net.createServer((sock) => {
    const up = net.connect(Number(relayPort), relayHost);
    const end = () => { sock.destroy(); up.destroy(); };
    sock.on('error', end);
    up.on('error', end);
    sock.pipe(up);
    up.pipe(sock);
  });
  srv.on('error', (e) => log(`forwarder: ${e.message}`));
  srv.listen(port, '127.0.0.1');
}

if (!cmd.length) {
  log('no command');
  process.exit(2);
}
const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on('error', (e) => { log(`cannot start ${cmd[0]}: ${e.message}`); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
