// The docker gate (docker/sandbox/docker-gate.ts): a host in a container reaches docker only through it, for its own
// sandbox objects in the sandbox's shape — pure decisions, no daemon.
import { test, expect, describe } from 'bun:test';
import * as g from '../docker/sandbox/docker-gate.ts';

const C: g.GateConfig = { socket: '/x.sock', tag: 'abcd1234', prefix: 'arigami-sbx-abcd1234', image: 'arigami-sandbox:latest', outsideNetwork: 'bench-net', bindPrefixes: ['/vm/inst', '/vm/code/docker/sandbox'] };
const good = () => ({
  Image: 'arigami-sandbox:latest', User: '1000:1000', Labels: { 'arigami.sandbox.instance': 'abcd1234' },
  HostConfig: { NetworkMode: 'arigami-sbx-abcd1234-int', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Mounts: [{ Type: 'bind', Source: '/vm/inst/repos/a', Target: '/data/repos/a' }, { Type: 'tmpfs', Target: '/tmp' }], Tmpfs: { '/tmp': 'size=1g' } },
});

describe('routes', () => {
  test('ping/version, this image, this instance\'s networks and label-filtered lists pass; the rest is refused', () => {
    expect(g.route('HEAD', '/_ping', C).ok).toBe(true);
    expect(g.route('GET', '/v1.52/version', C).ok).toBe(true);
    expect(g.route('GET', '/v1.52/images/arigami-sandbox:latest/json', C).ok).toBe(true);
    expect(g.route('GET', '/v1.52/images/alpine/json', C).ok).toBe(false);
    expect(g.route('GET', '/v1.52/networks/arigami-sbx-abcd1234-int', C).ok).toBe(true);
    expect(g.route('GET', '/v1.52/networks/host', C).ok).toBe(false);
    expect(g.route('GET', '/v1.52/containers/json?all=1', C).ok).toBe(false);
    expect(g.route('GET', `/v1.52/containers/json?filters=${encodeURIComponent('{"label":{"arigami.sandbox.instance=abcd1234":true}}')}`, C).ok).toBe(true);
    expect(g.route('POST', '/v1.52/containers/create?name=other', C).ok).toBe(false);
    for (const [m, p] of [['POST', '/containers/x/exec'], ['POST', '/build'], ['POST', '/images/create'], ['POST', '/volumes/create'], ['GET', '/info'], ['POST', '/containers/x/update'], ['PUT', '/containers/x/archive'], ['GET', '/containers/x/archive']])
      expect(g.route(m, `/v1.52${p}`, C).ok).toBe(false);
  });
  test('container operations name the container whose ownership is then checked', () => {
    const v = g.route('POST', '/v1.52/containers/abc/attach?stream=1', C);
    expect(v.ok && v.own).toBe('abc');
    expect(g.route('DELETE', '/v1.52/containers/abc?force=1', C).ok).toBe(true);
  });
  test('connect only to the internal network', () => {
    expect(g.route('POST', '/v1.52/networks/arigami-sbx-abcd1234-int/connect', C).ok).toBe(true);
    expect(g.route('POST', '/v1.52/networks/bench-net/connect', C).ok).toBe(false);
  });
});

describe('container create', () => {
  test('the sandbox shape passes', () => expect(g.checkContainer(good(), C)).toBe(null));
  const bad: [string, (b: any) => void][] = [
    ['another image', (b) => (b.Image = 'alpine')],
    ['no instance label', (b) => (b.Labels = {})],
    ['root', (b) => (b.User = '0:0')],
    ['no user', (b) => (b.User = '')],
    ['privileged', (b) => (b.HostConfig.Privileged = true)],
    ['cap add', (b) => (b.HostConfig.CapAdd = ['SYS_ADMIN'])],
    ['caps kept', (b) => (b.HostConfig.CapDrop = [])],
    ['no no-new-privileges', (b) => (b.HostConfig.SecurityOpt = [])],
    ['seccomp unconfined', (b) => b.HostConfig.SecurityOpt.push('seccomp=unconfined')],
    ['host pid', (b) => (b.HostConfig.PidMode = 'host')],
    ['host network', (b) => (b.HostConfig.NetworkMode = 'host')],
    ['another network', (b) => (b.HostConfig.NetworkMode = 'bridge')],
    ['devices', (b) => (b.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }])],
    ['ports', (b) => (b.HostConfig.PortBindings = { '22/tcp': [{}] })],
    ['bind outside', (b) => b.HostConfig.Mounts.push({ Type: 'bind', Source: '/home/u', Target: '/x' })],
    ['bind prefix trick', (b) => b.HostConfig.Mounts.push({ Type: 'bind', Source: '/vm/inst-other', Target: '/x' })],
    ['legacy bind outside', (b) => (b.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock'])],
    ['volume', (b) => b.HostConfig.Mounts.push({ Type: 'volume', Source: 'v', Target: '/x' })],
    ['unmasked /proc', (b) => (b.HostConfig.MaskedPaths = [])],
    ['docker socket bind', (b) => b.HostConfig.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Target: '/s' })],
  ];
  for (const [why, mut] of bad) test(`refused: ${why}`, () => { const b = good(); mut(b); expect(g.checkContainer(b, C)).toBeTruthy(); });
  test('the egress container may sit on the configured outside network', () => {
    const b = good(); b.HostConfig.NetworkMode = 'bench-net';
    expect(g.checkContainer(b, C)).toBe(null);
  });
});

describe('network create', () => {
  test('only <prefix>-int (internal) / -out, labelled, plain bridge', () => {
    const L = { 'arigami.sandbox.instance': 'abcd1234' };
    expect(g.checkNetwork({ Name: 'arigami-sbx-abcd1234-int', Internal: true, Labels: L }, C)).toBe(null);
    expect(g.checkNetwork({ Name: 'arigami-sbx-abcd1234-out', Labels: L }, C)).toBe(null);
    expect(g.checkNetwork({ Name: 'arigami-sbx-abcd1234-int', Internal: false, Labels: L }, C)).toBeTruthy();
    expect(g.checkNetwork({ Name: 'evil', Internal: true, Labels: L }, C)).toBeTruthy();
    expect(g.checkNetwork({ Name: 'arigami-sbx-abcd1234-out', Labels: {} }, C)).toBeTruthy();
    expect(g.checkNetwork({ Name: 'arigami-sbx-abcd1234-out', Labels: L, Driver: 'macvlan' }, C)).toBeTruthy();
  });
});
