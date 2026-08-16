#!/usr/bin/env node
/**
 * Point the internal @shashiladev-heshan/* dependency ranges at a version.
 *
 *   node scripts/sync-internal-deps.mjs 0.2.0
 *
 * `npm version --workspaces` bumps each package's own version but leaves
 * dependency ranges alone. Without this, publishing 0.2.0 of govctl leaves it
 * depending on ^0.1.0 of policy-core — so a fresh install pairs new gating code
 * with an old policy resolver, and the two disagree about what a tier means.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: sync-internal-deps.mjs <semver>');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['policy-core', 'govctl', 'validator-agent'];
const internal = new Set(
  packages.map((p) => JSON.parse(readFileSync(join(root, 'packages', p, 'package.json'), 'utf8')).name),
);

let changed = 0;
for (const pkg of packages) {
  const path = join(root, 'packages', pkg, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  let touched = false;

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (!internal.has(dep)) continue;
      const range = `^${version}`;
      if (manifest[field][dep] !== range) {
        manifest[field][dep] = range;
        touched = true;
        console.log(`${manifest.name}: ${dep} -> ${range}`);
      }
    }
  }

  if (touched) {
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
    changed++;
  }
}

console.log(changed === 0 ? 'internal ranges already in sync' : `updated ${changed} package(s)`);
