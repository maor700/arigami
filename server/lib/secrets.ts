import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ARIGAMI_DIR } from './instance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATE_DIR = ARIGAMI_DIR;
export const SECRETS_ENV = path.join(STATE_DIR, 'secrets.env');
export const LOCAL_ENV = path.join(__dirname, '..', '..', '.local.env');
export const KEYCHAIN_PREFIX = 'arigami:';

export function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return out;
}

let fileCache: Record<string, string> | null = null;
function loadEnvFile(): Record<string, string> {
  if (!fileCache)
    fileCache = { ...parseEnvFile(LOCAL_ENV), ...parseEnvFile(SECRETS_ENV) };
  return fileCache;
}

function fromKeychain(name: string): string {
  if (process.platform !== 'darwin') return '';
  try {
    return execFileSync(
      'security',
      [
        'find-generic-password',
        '-a',
        process.env.USER || '',
        '-s',
        KEYCHAIN_PREFIX + name,
        '-w',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .toString()
      .trim();
  } catch {
    return '';
  }
}

export function secret(name: string): string {
  if (process.env[name]) return process.env[name] || '';
  const k = fromKeychain(name);
  if (k) return k;
  const f = loadEnvFile()[name];
  return f || '';
}

type SecretSource = 'env' | 'keychain' | 'secrets.env' | '.local.env' | 'missing';

export function secretSource(name: string): SecretSource {
  if (process.env[name]) return 'env';
  if (fromKeychain(name)) return 'keychain';
  if (parseEnvFile(SECRETS_ENV)[name]) return 'secrets.env';
  if (parseEnvFile(LOCAL_ENV)[name]) return '.local.env';
  return 'missing';
}

export function loadEnvFiles(files: string[] | null | undefined): string[] {
  const loaded: string[] = [];
  for (const f of files || []) {
    const kv = parseEnvFile(f);
    for (const [k, v] of Object.entries(kv)) {
      if (process.env[k] === undefined && v !== '') {
        process.env[k] = v;
        loaded.push(k);
      }
    }
  }
  return loaded;
}
