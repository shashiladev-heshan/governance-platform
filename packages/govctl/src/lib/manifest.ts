import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalJsonBytes, sha256Bytes, sha256File } from './hash.js';

export const MANIFEST_FILENAME = 'manifest.lock.json';
export const BUNDLE_FILENAME = 'manifest.lock.json.bundle';

/** Directories of the registry that are hash-governed and synced into projects. */
export const DEFAULT_GOVERNED_DIRS = ['skills', 'policies', 'tiers'];

const IGNORED_NAMES = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  MANIFEST_FILENAME,
  BUNDLE_FILENAME,
]);

export interface Manifest {
  schemaVersion: 1;
  algorithm: 'sha256';
  version: string;
  governedDirs: string[];
  files: Record<string, string>;
}

export interface DriftEntry {
  path: string;
  expected?: string;
  actual?: string;
}

export interface DriftReport {
  ok: boolean;
  modified: DriftEntry[];
  missing: DriftEntry[];
  untracked: DriftEntry[];
  verifiedCount: number;
}

/**
 * Walk `governedDirs` under `rootDir` and hash every file. Paths in the manifest
 * are POSIX-relative to rootDir and sorted, so the manifest is reproducible.
 */
export async function generateManifest(
  rootDir: string,
  version: string,
  governedDirs: string[] = DEFAULT_GOVERNED_DIRS,
): Promise<Manifest> {
  const present = governedDirs.filter((dir) => existsSync(join(rootDir, dir)));
  const files: Record<string, string> = {};

  for (const relPath of await collectGovernedFiles(rootDir, present)) {
    files[relPath] = await sha256File(join(rootDir, relPath));
  }

  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    version,
    governedDirs: present.sort(),
    files: sortRecord(files),
  };
}

export function serializeManifest(manifest: Manifest): Buffer {
  return canonicalJsonBytes(manifest);
}

export async function writeManifest(path: string, manifest: Manifest): Promise<Buffer> {
  const bytes = serializeManifest(manifest);
  await writeFile(path, bytes);
  return bytes;
}

export function parseManifest(bytes: Buffer | string): Manifest {
  const parsed = JSON.parse(bytes.toString('utf8')) as Manifest;
  if (parsed?.schemaVersion !== 1) {
    throw new Error(`unsupported manifest schemaVersion: ${String(parsed?.schemaVersion)}`);
  }
  if (parsed.algorithm !== 'sha256') {
    throw new Error(`unsupported manifest algorithm: ${String(parsed.algorithm)}`);
  }
  if (!parsed.files || typeof parsed.files !== 'object') {
    throw new Error('manifest has no files map');
  }
  return parsed;
}

export async function readManifestFile(path: string): Promise<{ manifest: Manifest; bytes: Buffer }> {
  const bytes = await readFile(path);
  return { manifest: parseManifest(bytes), bytes };
}

/** SHA-256 of the manifest file's own bytes — recorded in governance.json. */
export function manifestDigest(bytes: Buffer): string {
  return sha256Bytes(bytes);
}

export async function collectGovernedFiles(
  rootDir: string,
  governedDirs: string[],
): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (IGNORED_NAMES.has(name)) continue;
      const full = join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) {
        await walk(full);
      } else if (info.isFile()) {
        out.push(toPosix(relative(rootDir, full)));
      }
    }
  }

  for (const dir of governedDirs) {
    await walk(join(rootDir, dir));
  }

  return out.sort();
}

/**
 * Re-hash everything under `baseDir` and compare against the manifest.
 *
 * Catches three distinct drift shapes:
 *   - modified:  file present, hash differs (someone edited a governed file)
 *   - missing:   file in manifest, absent on disk (someone deleted a rule)
 *   - untracked: file on disk under a governed dir, absent from manifest
 *                (someone added a rogue skill to widen what the agent accepts)
 */
export async function diffAgainstManifest(
  baseDir: string,
  manifest: Manifest,
): Promise<DriftReport> {
  const modified: DriftEntry[] = [];
  const missing: DriftEntry[] = [];
  const untracked: DriftEntry[] = [];
  let verifiedCount = 0;

  for (const [relPath, expected] of Object.entries(manifest.files)) {
    const full = join(baseDir, relPath);
    if (!existsSync(full)) {
      missing.push({ path: relPath, expected });
      continue;
    }
    const actual = await sha256File(full);
    if (actual !== expected) {
      modified.push({ path: relPath, expected, actual });
    } else {
      verifiedCount++;
    }
  }

  const onDisk = await collectGovernedFiles(baseDir, manifest.governedDirs ?? DEFAULT_GOVERNED_DIRS);
  for (const relPath of onDisk) {
    if (!(relPath in manifest.files)) {
      untracked.push({ path: relPath, actual: await sha256File(join(baseDir, relPath)) });
    }
  }

  return {
    ok: modified.length === 0 && missing.length === 0 && untracked.length === 0,
    modified,
    missing,
    untracked,
    verifiedCount,
  };
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function sortRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(rec).sort()) out[key] = rec[key]!;
  return out;
}
