import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BUNDLE_FILENAME,
  MANIFEST_FILENAME,
  generateManifest,
  manifestDigest,
  parseManifest,
  writeManifest,
} from '../lib/manifest.js';
import { readGovernedDirs } from '../lib/registry.js';
import {
  generateKeypair,
  serializeBundle,
  signBytes,
  type DevKeypair,
} from '../lib/signing.js';
import { addTrustedKey, loadTrustStore, userTrustPath } from '../lib/trust.js';
import { color, log } from '../lib/log.js';

/**
 * Registry-side commands. These run in the governance repo's release pipeline,
 * never in a consumer project — which is exactly why a developer cannot produce
 * a manifest that verifies.
 */

export interface ManifestOptions {
  dir: string;
  version: string;
  json?: boolean;
}

export async function cmdManifestGenerate(options: ManifestOptions): Promise<number> {
  const governedDirs = await readGovernedDirs(options.dir);
  const manifest = await generateManifest(options.dir, options.version, governedDirs);
  const path = join(options.dir, MANIFEST_FILENAME);
  const bytes = await writeManifest(path, manifest);

  const fileCount = Object.keys(manifest.files).length;
  if (options.json) {
    console.log(JSON.stringify({ path, files: fileCount, digest: manifestDigest(bytes) }, null, 2));
  } else {
    log.ok(`wrote ${MANIFEST_FILENAME} — ${fileCount} files across ${manifest.governedDirs.join(', ')}`);
    log.info(`  digest ${manifestDigest(bytes)}`);
  }
  return 0;
}

/**
 * Regenerate the manifest in memory and compare it to the committed one.
 * Runs on every PR to the registry, so a rule change that forgets to refresh the
 * manifest is caught before it can be tagged.
 */
export async function cmdManifestCheck(options: ManifestOptions): Promise<number> {
  const path = join(options.dir, MANIFEST_FILENAME);
  if (!existsSync(path)) {
    log.fail(`no ${MANIFEST_FILENAME} in ${options.dir}`);
    return 1;
  }

  const committed = parseManifest(await readFile(path));
  const governedDirs = await readGovernedDirs(options.dir);
  const fresh = await generateManifest(options.dir, committed.version, governedDirs);

  const problems: string[] = [];
  for (const [file, hash] of Object.entries(fresh.files)) {
    const previous = committed.files[file];
    if (previous === undefined) problems.push(`not in manifest: ${file}`);
    else if (previous !== hash) problems.push(`hash out of date: ${file}`);
  }
  for (const file of Object.keys(committed.files)) {
    if (!(file in fresh.files)) problems.push(`in manifest but not on disk: ${file}`);
  }

  if (problems.length) {
    for (const problem of problems) log.fail(problem);
    log.blank();
    log.info(`fix: govctl manifest generate --dir ${options.dir} --version ${committed.version}`);
    return 1;
  }

  log.ok(`${MANIFEST_FILENAME} is up to date (${Object.keys(fresh.files).length} files)`);
  return 0;
}

/**
 * Schema-validate policy.yaml and every tier, and resolve each tier so that a
 * broken overlay (unknown rule id, impossible enforcement) fails the registry PR
 * rather than every consumer project's next sync.
 */
export async function cmdPolicyValidate(options: { dir: string; json?: boolean }): Promise<number> {
  const { loadPolicyDoc, loadTierDoc, resolvePolicy } = await import('@shashiladev-heshan/policy-core');
  const { readdir } = await import('node:fs/promises');

  const policyPath = join(options.dir, 'policies', 'policy.yaml');
  const policy = loadPolicyDoc(policyPath);
  log.ok(`policy.yaml valid — ${policy.rules.length} rules`);

  const tierFiles = (await readdir(join(options.dir, 'tiers')))
    .filter((f) => f.endsWith('.yaml'))
    .sort();

  let failed = 0;
  const summary: Record<string, unknown> = {};

  for (const file of tierFiles) {
    const tier = loadTierDoc(join(options.dir, 'tiers', file));
    const resolved = resolvePolicy(policy, tier);
    const counts = { block: 0, warn: 0, off: 0 };
    for (const rule of Object.values(resolved.rules)) counts[rule.enforcement]++;
    summary[tier.tier] = { ...counts, staleness: resolved.staleness.maxReleasesBehind };

    if (resolved.rejectedOverrides.length) {
      failed++;
      log.fail(`tier '${tier.tier}' has invalid overlays:`);
      for (const r of resolved.rejectedOverrides) log.info(`    ${r.reason}`);
    } else {
      log.ok(
        `tier '${tier.tier}' resolves — ${counts.block} blocking · ${counts.warn} advisory · ${counts.off} off`,
      );
    }
  }

  // Every rule should be taught by a skill, or the agent has no rubric for it.
  for (const rule of policy.rules) {
    if (!rule.skill) continue;
    const skillPath = join(options.dir, 'skills', rule.skill, 'SKILL.md');
    if (!existsSync(skillPath)) {
      failed++;
      log.fail(`rule '${rule.id}' references missing skill: ${rule.skill}`);
    }
  }

  if (options.json) console.log(JSON.stringify(summary, null, 2));
  return failed === 0 ? 0 : 1;
}

export interface SignOptions {
  dir: string;
  keyFile: string;
  signer?: string;
  json?: boolean;
}

export async function cmdSign(options: SignOptions): Promise<number> {
  const manifestPath = join(options.dir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    log.fail(`no ${MANIFEST_FILENAME} in ${options.dir} — run 'govctl manifest generate' first`);
    return 2;
  }
  if (!existsSync(options.keyFile)) {
    log.fail(`signing key not found: ${options.keyFile}`);
    return 2;
  }

  const bytes = await readFile(manifestPath);
  parseManifest(bytes); // fail early on a malformed manifest
  const keypair = JSON.parse(await readFile(options.keyFile, 'utf8')) as DevKeypair;
  const bundle = signBytes(bytes, keypair, options.signer ?? 'dev-ed25519');

  const bundlePath = join(options.dir, BUNDLE_FILENAME);
  await writeFile(bundlePath, serializeBundle(bundle));

  if (options.json) {
    console.log(JSON.stringify({ path: bundlePath, keyId: bundle.keyId, digest: bundle.subject.digest }, null, 2));
  } else {
    log.ok(`signed ${MANIFEST_FILENAME} with key ${color.bold(bundle.keyId)}`);
    log.info(`  digest ${bundle.subject.digest}`);
  }
  return 0;
}

export interface KeygenOptions {
  keyId: string;
  out: string;
  trust?: boolean;
}

export async function cmdKeygen(options: KeygenOptions): Promise<number> {
  const keypair = generateKeypair(options.keyId);
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, JSON.stringify(keypair, null, 2) + '\n', { mode: 0o600 });
  log.ok(`wrote dev signing key to ${options.out} (keyId ${color.bold(options.keyId)})`);
  log.warn('this is a LOCAL DEV key — production signing must use cosign keyless via CI OIDC');

  if (options.trust) {
    const path = userTrustPath();
    addTrustedKey(path, {
      keyId: keypair.keyId,
      alg: 'ed25519',
      publicKey: keypair.publicKey,
      status: 'active',
      note: 'local dev signer',
    });
    log.ok(`added public key to trust store ${path}`);
  }
  return 0;
}

export interface TrustAddOptions {
  keyFile: string;
  path?: string;
}

export async function cmdTrustAdd(options: TrustAddOptions): Promise<number> {
  const keypair = JSON.parse(await readFile(options.keyFile, 'utf8')) as DevKeypair;
  const path = options.path ?? userTrustPath();
  addTrustedKey(path, {
    keyId: keypair.keyId,
    alg: 'ed25519',
    publicKey: keypair.publicKey,
    status: 'active',
  });
  log.ok(`trusted key ${color.bold(keypair.keyId)} in ${path}`);
  return 0;
}

export function cmdTrustList(): number {
  const store = loadTrustStore();
  log.info(`${color.bold('trust store')} ${color.dim(store.source)}`);
  if (store.keys.length === 0) {
    log.warn('no trusted keys — signature verification will fail in strict mode');
    return 1;
  }
  for (const key of store.keys) {
    const status = key.status === 'active' ? color.green(key.status) : color.red(key.status);
    log.info(`  ${key.keyId}  ${status}  ${color.dim(key.publicKey.slice(0, 24) + '…')}`);
  }
  return 0;
}
