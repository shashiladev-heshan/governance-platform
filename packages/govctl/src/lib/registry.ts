import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, cp, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_GOVERNED_DIRS } from './manifest.js';

const exec = promisify(execFile);

export interface FetchedRegistry {
  dir: string;
  version: string;
  cleanup: () => Promise<void>;
}

export class RegistryError extends Error {}

/**
 * A registry reference is either a git URL or a path to a local git repo.
 * Local paths are supported so the whole trust chain can be exercised offline
 * (and in tests) without standing up a remote.
 */
export function isGitUrl(ref: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(ref);
}

export async function listRegistryTags(ref: string): Promise<string[]> {
  const { stdout } = await git(['ls-remote', '--tags', '--refs', ref]);
  const tags = stdout
    .split('\n')
    .map((line) => line.split('\t')[1])
    .filter((r): r is string => Boolean(r))
    .map((r) => r.replace('refs/tags/', ''))
    .filter((t) => SEMVER_TAG.test(t));
  return tags.sort(compareSemverDesc);
}

export async function resolveVersion(ref: string, requested?: string): Promise<string> {
  const tags = await listRegistryTags(ref);
  if (requested && requested !== 'latest') {
    if (!tags.includes(requested)) {
      throw new RegistryError(
        `version '${requested}' not found in registry ${ref}. Available: ${tags.slice(0, 5).join(', ') || '<none>'}`,
      );
    }
    return requested;
  }
  const latest = tags[0];
  if (!latest) {
    throw new RegistryError(
      `registry ${ref} has no semver tags (expected tags like v1.2.3). Cut a release before syncing.`,
    );
  }
  return latest;
}

/** Shallow-clone the registry at a pinned tag into a temp dir. */
export async function fetchRegistry(ref: string, version: string): Promise<FetchedRegistry> {
  const dir = await mkdtemp(join(tmpdir(), 'govctl-registry-'));
  try {
    await git(['clone', '--depth', '1', '--branch', version, '--quiet', ref, dir]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new RegistryError(
      `could not fetch ${ref} at ${version}: ${(err as Error).message.split('\n')[0]}`,
    );
  }
  return {
    dir,
    version,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Registry-declared governed dirs, falling back to the default set. */
export async function readGovernedDirs(registryDir: string): Promise<string[]> {
  const configPath = join(registryDir, 'registry.json');
  if (!existsSync(configPath)) return DEFAULT_GOVERNED_DIRS;
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as { governed?: string[] };
    return Array.isArray(parsed.governed) && parsed.governed.length
      ? parsed.governed
      : DEFAULT_GOVERNED_DIRS;
  } catch (err) {
    throw new RegistryError(`invalid registry.json: ${(err as Error).message}`);
  }
}

/**
 * Replace the governed directories in `destDir` with the registry's copies.
 * Destructive by design: a stale rule that was deleted upstream must disappear
 * locally, not linger.
 */
export async function copyGoverned(
  srcDir: string,
  destDir: string,
  governedDirs: string[],
): Promise<string[]> {
  const copied: string[] = [];
  await mkdir(destDir, { recursive: true });

  for (const dir of governedDirs) {
    const src = join(srcDir, dir);
    if (!existsSync(src)) continue;
    const dest = join(destDir, dir);
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest, { recursive: true });
    copied.push(dir);
  }

  return copied;
}

const SEMVER_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function compareSemverDesc(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
  }
  // A prerelease sorts below its release (v1.0.0-rc1 < v1.0.0).
  const preA = a.includes('-');
  const preB = b.includes('-');
  if (preA !== preB) return preA ? 1 : -1;
  return b.localeCompare(a);
}

function parseSemver(tag: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Distance from `version` to the newest tag, in releases. -1 if unknown. */
export function releasesBehind(tags: string[], version: string): number {
  const index = tags.indexOf(version);
  return index < 0 ? -1 : index;
}

async function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    // Inherits HTTPS_PROXY / HTTP_PROXY / NO_PROXY from the environment, which is
    // what makes this work behind corporate proxies without extra config.
    return await exec('git', args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    throw new RegistryError(`git ${args[0]} failed: ${(err as Error).message.split('\n')[0]}`);
  }
}
