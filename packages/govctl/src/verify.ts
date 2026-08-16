import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BUNDLE_FILENAME,
  MANIFEST_FILENAME,
  diffAgainstManifest,
  manifestDigest,
  parseManifest,
  type DriftReport,
  type Manifest,
} from './lib/manifest.js';
import { parseBundle, verifyBundle, verifyCosignBundle, type VerifyResult as SigResult } from './lib/signing.js';
import { loadTrustStore } from './lib/trust.js';
import { fetchRegistry, listRegistryTags, releasesBehind } from './lib/registry.js';
import { governanceDir, readConfig, type GovernanceConfig } from './lib/config.js';
import { loadResolvedPolicy } from '@shashiladev-heshan/policy-core';

export interface VerifyOptions {
  projectRoot: string;
  /**
   * Fetch the canonical manifest from the registry instead of trusting the copy
   * in the working tree. This is what CI runs — it makes "edit the file AND the
   * manifest" a losing move, because the PR's manifest is never consulted.
   */
  remote?: boolean;
  /** Missing signature / missing trust root become failures rather than warnings. */
  strict?: boolean;
  /** Skip the staleness check (only meaningful with remote). */
  skipStaleness?: boolean;
}

export interface StalenessReport {
  ok: boolean;
  current: string;
  latest: string;
  behind: number;
  maxReleasesBehind: number;
}

export interface ProjectVerifyResult {
  ok: boolean;
  registry: string;
  tier: string;
  version: string;
  manifestSource: 'local' | 'registry';
  signature: {
    checked: boolean;
    ok: boolean;
    keyId?: string;
    signer?: string;
    reason?: string;
    trustSource: string;
    /** Usable keys in the trust store. Zero means "cannot verify anything". */
    trustKeys: number;
  };
  /** governance.json's recorded manifest digest vs the manifest file on disk. */
  manifestBinding: { ok: boolean; expected: string; actual: string };
  /** Only populated with `remote`: local manifest bytes vs the registry's. */
  canonicalMatch?: { ok: boolean; localDigest: string; registryDigest: string };
  drift: DriftReport;
  staleness?: StalenessReport;
  errors: string[];
  warnings: string[];
}

/**
 * The keystone check. Every other piece of the platform leans on this returning
 * an honest answer, so it fails closed: any step that cannot be completed is an
 * error, never a silent skip.
 */
export async function verifyProject(options: VerifyOptions): Promise<ProjectVerifyResult> {
  const { projectRoot, remote = false, strict = process.env.CI !== undefined } = options;
  const config: GovernanceConfig = await readConfig(projectRoot);
  const govDir = governanceDir(projectRoot);

  const errors: string[] = [];
  const warnings: string[] = [];

  // --- local manifest + its binding to governance.json ----------------------
  const localManifestPath = join(govDir, MANIFEST_FILENAME);
  if (!existsSync(localManifestPath)) {
    throw new Error(
      `missing ${localManifestPath}. The .governance directory is not synced — run 'govctl sync'.`,
    );
  }
  const localBytes = await readFile(localManifestPath);
  const localDigest = manifestDigest(localBytes);
  const manifestBinding = {
    ok: localDigest === config.manifestSha256,
    expected: config.manifestSha256,
    actual: localDigest,
  };
  if (!manifestBinding.ok) {
    errors.push(
      `manifest was replaced: ${MANIFEST_FILENAME} hashes to ${short(localDigest)} but governance.json records ${short(config.manifestSha256)}`,
    );
  }

  // --- choose the manifest we will trust ------------------------------------
  let manifest: Manifest;
  let manifestBytes: Buffer;
  let bundleBytes: Buffer | null;
  let manifestSource: 'local' | 'registry';
  let canonicalMatch: ProjectVerifyResult['canonicalMatch'];
  let staleness: StalenessReport | undefined;
  let cleanup: (() => Promise<void>) | null = null;

  try {
    if (remote) {
      const fetched = await fetchRegistry(config.registry, config.version);
      cleanup = fetched.cleanup;
      manifestSource = 'registry';
      manifestBytes = await readFile(join(fetched.dir, MANIFEST_FILENAME));
      bundleBytes = await readIfExists(join(fetched.dir, BUNDLE_FILENAME));
      const registryDigest = manifestDigest(manifestBytes);
      canonicalMatch = {
        ok: registryDigest === localDigest,
        localDigest,
        registryDigest,
      };
      if (!canonicalMatch.ok) {
        errors.push(
          `local manifest does not match the registry at ${config.version} (local ${short(localDigest)}, registry ${short(registryDigest)})`,
        );
      }

      if (!options.skipStaleness) {
        // Tier comes from the registry copy, not the working tree — a project
        // must not be able to widen its own staleness window.
        const policy = loadResolvedPolicy(fetched.dir, config.tier, config.overrides ?? {});
        staleness = await checkStaleness(config, policy.staleness.maxReleasesBehind);
        if (!staleness.ok) {
          errors.push(
            `governance is stale: pinned ${staleness.current}, latest ${staleness.latest} (${staleness.behind} releases behind, tier allows ${staleness.maxReleasesBehind})`,
          );
        }
      }
    } else {
      manifestSource = 'local';
      manifestBytes = localBytes;
      bundleBytes = await readIfExists(join(govDir, BUNDLE_FILENAME));
    }

    manifest = parseManifest(manifestBytes);

    // --- signature --------------------------------------------------------
    const trust = loadTrustStore();
    let signature: ProjectVerifyResult['signature'] = {
      checked: false,
      ok: false,
      trustSource: trust.source,
      trustKeys: trust.keys.filter((k) => k.status === 'active').length,
    };

    if (!bundleBytes) {
      const msg = `no signature bundle (${BUNDLE_FILENAME}) found for the manifest`;
      signature = { ...signature, reason: msg };
      (strict ? errors : warnings).push(msg);
    } else if (signature.trustKeys === 0) {
      const msg = `cannot verify manifest signature: no trust root configured (checked ${trust.source})`;
      signature = { ...signature, reason: msg };
      (strict ? errors : warnings).push(msg);
    } else {
      const bundle = parseBundle(bundleBytes);
      // An invalid signature is always fatal — never advisory, in any mode.
      const result: SigResult =
        bundle.signer === 'cosign-keyless'
          ? verifyCosignBundle()
          : verifyBundle(manifestBytes, bundle, trust);
      signature = {
        ...signature,
        checked: true,
        ok: result.ok,
        ...(result.keyId ? { keyId: result.keyId } : {}),
        ...(result.signer ? { signer: result.signer } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
      if (!result.ok) {
        errors.push(`manifest signature invalid: ${result.reason}`);
      }
    }

    // --- content hashes ---------------------------------------------------
    const drift = await diffAgainstManifest(govDir, manifest);
    for (const entry of drift.modified) {
      errors.push(`governed file modified: ${entry.path}`);
    }
    for (const entry of drift.missing) {
      errors.push(`governed file missing: ${entry.path}`);
    }
    for (const entry of drift.untracked) {
      errors.push(`untracked file under .governance: ${entry.path}`);
    }

    return {
      ok: errors.length === 0,
      registry: config.registry,
      tier: config.tier,
      version: config.version,
      manifestSource,
      signature,
      manifestBinding,
      ...(canonicalMatch ? { canonicalMatch } : {}),
      drift,
      ...(staleness ? { staleness } : {}),
      errors,
      warnings,
    };
  } finally {
    if (cleanup) await cleanup();
  }
}

export async function checkStaleness(
  config: GovernanceConfig,
  maxReleasesBehind?: number,
): Promise<StalenessReport> {
  const tags = await listRegistryTags(config.registry);
  const behind = releasesBehind(tags, config.version);
  const latest = tags[0] ?? config.version;
  const max = maxReleasesBehind ?? Number.POSITIVE_INFINITY;
  return {
    ok: behind >= 0 && behind <= max,
    current: config.version,
    latest,
    behind,
    maxReleasesBehind: max,
  };
}

async function readIfExists(path: string): Promise<Buffer | null> {
  return existsSync(path) ? readFile(path) : null;
}

function short(hex: string): string {
  return hex.slice(0, 12);
}
