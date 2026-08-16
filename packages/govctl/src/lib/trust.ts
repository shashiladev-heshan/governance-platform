import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TrustedKey {
  keyId: string;
  alg: 'ed25519';
  publicKey: string;
  status: 'active' | 'revoked';
  note?: string;
}

export interface TrustStore {
  schemaVersion: 1;
  keys: TrustedKey[];
  /** Where the store came from — printed in verify output so trust is auditable. */
  source: string;
}

const EMPTY: TrustStore = { schemaVersion: 1, keys: [], source: 'none' };

/**
 * Resolve the trust store, in order:
 *   1. $GOVCTL_TRUST_ROOT           — CI points this at a store it controls
 *   2. ~/.govctl/trust.json         — developer machine, seeded by MDM/onboarding
 *   3. <govctl package>/trust/...   — shipped with the CLI from private npm
 *
 * Deliberately NOT read from the project being verified. A repo must never be
 * able to nominate the key that vouches for its own governance content.
 */
export function loadTrustStore(): TrustStore {
  for (const candidate of trustCandidates()) {
    if (candidate && existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as TrustStore;
        if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.keys)) {
          throw new Error('malformed trust store');
        }
        return { ...parsed, source: candidate };
      } catch (err) {
        throw new Error(`could not read trust store at ${candidate}: ${(err as Error).message}`);
      }
    }
  }
  return EMPTY;
}

export function trustCandidates(): Array<string | undefined> {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'trust', 'trust.json');
  return [process.env.GOVCTL_TRUST_ROOT, join(homedir(), '.govctl', 'trust.json'), bundled];
}

/** Default target for `govctl trust add` on a developer machine. */
export function userTrustPath(): string {
  return process.env.GOVCTL_TRUST_ROOT ?? join(homedir(), '.govctl', 'trust.json');
}

export function addTrustedKey(path: string, key: TrustedKey): TrustStore {
  const store: TrustStore = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as TrustStore)
    : { schemaVersion: 1, keys: [], source: path };

  store.keys = store.keys.filter((k) => k.keyId !== key.keyId);
  store.keys.push(key);
  store.keys.sort((a, b) => a.keyId.localeCompare(b.keyId));

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, keys: store.keys }, null, 2) + '\n');
  return { ...store, source: path };
}
