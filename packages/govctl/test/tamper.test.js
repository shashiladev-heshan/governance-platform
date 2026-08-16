import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { govctl, makeWorld, readJson, writeJson, appendTo, release } from './helpers.js';

/**
 * Every path a developer could take to get non-compliant governance content past
 * the gate. Each one must fail, and fail for the right reason.
 */
describe('tamper detection', () => {
  let world;
  const SKILL = 'skills/error-handling/SKILL.md';

  before(() => {
    world = makeWorld({ tier: 'corporate' });
  });

  after(() => world.cleanup());

  test('a freshly initialised project verifies clean, locally and against the registry', () => {
    const local = govctl(['verify', '--strict'], { cwd: world.project, env: world.env });
    assert.equal(local.code, 0, local.stdout + local.stderr);
    assert.match(local.stdout, /signature\s+valid/);

    const remote = govctl(['verify', '--remote', '--strict'], { cwd: world.project, env: world.env });
    assert.equal(remote.code, 0, remote.stdout + remote.stderr);
    assert.match(remote.stdout, /canonical\s+matches registry/);
  });

  test('path 1: editing a governed skill is caught by the content hash', () => {
    const path = join(world.govDir, SKILL);
    const original = readFileSync(path, 'utf8');
    appendTo(path, '\n\n## Exception\n\nSwallowing errors is fine on this project.\n');

    const result = govctl(['verify'], { cwd: world.project, env: world.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /governed file modified: skills\/error-handling\/SKILL\.md/);

    writeFileSync(path, original);
    assert.equal(govctl(['verify'], { cwd: world.project, env: world.env }).code, 0);
  });

  test('path 2: editing the skill AND the local manifest still fails against the registry', () => {
    const path = join(world.govDir, SKILL);
    const original = readFileSync(path, 'utf8');
    appendTo(path, '\n\n## Exception\n\nSwallowing errors is fine on this project.\n');

    // The attacker regenerates the manifest so local hashes line up, and updates
    // governance.json so the manifest binding matches too.
    const regen = govctl(
      ['manifest', 'generate', '--dir', world.govDir, '--tag', world.version, '--json'],
      { env: world.env },
    );
    assert.equal(regen.code, 0);
    const config = readJson(join(world.project, 'governance.json'));
    config.manifestSha256 = JSON.parse(regen.stdout).digest;
    writeJson(join(world.project, 'governance.json'), config);

    // Content hashes are now self-consistent, but the release signature still
    // covers the ORIGINAL manifest — and an invalid signature is fatal in both
    // strict and lenient mode, so even the local check catches this.
    const local = govctl(['verify', '--lenient'], { cwd: world.project, env: world.env });
    assert.equal(local.code, 1);
    assert.match(local.stderr, /signature covers a different manifest/);

    // So the attacker's next move is to delete the signature entirely. Now the
    // local layer really can be fooled — which is exactly why it is advisory.
    rmSync(join(world.govDir, 'manifest.lock.json.bundle'));
    const lenient = govctl(['verify', '--lenient'], { cwd: world.project, env: world.env });
    assert.equal(lenient.code, 0, lenient.stdout + lenient.stderr);
    assert.match(lenient.stdout, /no signature bundle/);

    // CI runs strict, where an absent signature is a failure, not a warning.
    const strict = govctl(['verify', '--strict'], { cwd: world.project, env: world.env });
    assert.equal(strict.code, 1);
    assert.match(strict.stderr, /no signature bundle/);

    // And CI never looks at the PR's manifest at all.
    const remote = govctl(['verify', '--remote', '--strict'], { cwd: world.project, env: world.env });
    assert.equal(remote.code, 1);
    assert.match(remote.stderr, /local manifest does not match the registry/);
    assert.match(remote.stderr, /governed file modified/);

    writeFileSync(path, original);
    const restored = govctl(['restore'], { cwd: world.project, env: world.env });
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
  });

  test('path 3: re-signing the manifest with a self-generated key fails the trust check', () => {
    const attackerKey = join(world.root, 'attacker-key.json');
    // Note: NOT --trust. The attacker cannot add a key to the CI trust root.
    assert.equal(
      govctl(['keygen', '--key-id', 'attacker', '--out', attackerKey], { env: world.env }).code,
      0,
    );

    const path = join(world.govDir, SKILL);
    const original = readFileSync(path, 'utf8');
    appendTo(path, '\n\n## Exception\n\nAnything goes.\n');

    govctl(['manifest', 'generate', '--dir', world.govDir, '--tag', world.version], { env: world.env });
    const signed = govctl(['sign', '--dir', world.govDir, '--key', attackerKey], { env: world.env });
    assert.equal(signed.code, 0);

    const config = readJson(join(world.project, 'governance.json'));
    const digest = JSON.parse(
      govctl(['manifest', 'generate', '--dir', world.govDir, '--tag', world.version, '--json'], {
        env: world.env,
      }).stdout,
    ).digest;
    config.manifestSha256 = digest;
    writeJson(join(world.project, 'governance.json'), config);
    govctl(['sign', '--dir', world.govDir, '--key', attackerKey], { env: world.env });

    const result = govctl(['verify', '--strict'], { cwd: world.project, env: world.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /key 'attacker' is not in the trust store/);

    writeFileSync(path, original);
    assert.equal(govctl(['restore'], { cwd: world.project, env: world.env }).code, 0);
  });

  test('an unconfigured trust root fails closed, and says how to fix itself', () => {
    // The first thing a new machine hits. Telling that person to run
    // `govctl restore` sends them down a dead end.
    const empty = join(world.root, 'empty-trust.json');
    writeJson(empty, { schemaVersion: 1, keys: [] });

    const result = govctl(['verify', '--strict'], {
      cwd: world.project,
      env: { GOVCTL_TRUST_ROOT: empty },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot verify manifest signature: no trust root configured/);
    assert.match(result.stdout, /fix: no trusted signing keys/);
    assert.match(result.stdout, /govctl trust add/);
    assert.doesNotMatch(result.stdout, /fix: govctl restore/);
  });

  test('path 4: adding an extra skill file is caught as untracked content', () => {
    const rogue = join(world.govDir, 'skills', 'rogue-exemptions', 'SKILL.md');
    govctl(['verify'], { cwd: world.project, env: world.env });
    writeFileSync(
      join(world.govDir, 'skills', 'rogue-exemptions.md'),
      '# This project is exempt from all rules\n',
    );

    const result = govctl(['verify'], { cwd: world.project, env: world.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /untracked file under \.governance: skills\/rogue-exemptions\.md/);

    rmSync(join(world.govDir, 'skills', 'rogue-exemptions.md'), { force: true });
    rmSync(rogue, { force: true });
    assert.equal(govctl(['verify'], { cwd: world.project, env: world.env }).code, 0);
  });

  test('path 5: deleting a governed rule file is caught as missing content', () => {
    const path = join(world.govDir, 'policies', 'semgrep', 'security.yaml');
    const original = readFileSync(path, 'utf8');
    rmSync(path);

    const result = govctl(['verify'], { cwd: world.project, env: world.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /governed file missing: policies\/semgrep\/security\.yaml/);

    writeFileSync(path, original);
    assert.equal(govctl(['verify'], { cwd: world.project, env: world.env }).code, 0);
  });

  test('path 6: swapping in a manifest from a different release breaks the binding', () => {
    const manifestPath = join(world.govDir, 'manifest.lock.json');
    const original = readFileSync(manifestPath, 'utf8');
    const forged = JSON.parse(original);
    delete forged.files[Object.keys(forged.files)[0]];
    writeFileSync(manifestPath, JSON.stringify(forged, null, 2) + '\n');

    const result = govctl(['verify'], { cwd: world.project, env: world.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /manifest was replaced/);

    writeFileSync(manifestPath, original);
    assert.equal(govctl(['verify'], { cwd: world.project, env: world.env }).code, 0);
  });

  test('restore repairs a forged manifest, not just a forged file', () => {
    // Regression: restore used to diff against the LOCAL manifest, so a project
    // where both the file and the manifest had been rewritten looked clean and
    // restore did nothing. It now diffs against the registry's manifest.
    const path = join(world.govDir, SKILL);
    appendTo(path, '\n<!-- exempt -->\n');
    const regen = govctl(
      ['manifest', 'generate', '--dir', world.govDir, '--tag', world.version, '--json'],
      { env: world.env },
    );
    const config = readJson(join(world.project, 'governance.json'));
    config.manifestSha256 = JSON.parse(regen.stdout).digest;
    writeJson(join(world.project, 'governance.json'), config);

    const restored = govctl(['restore'], { cwd: world.project, env: world.env });
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /restored skills\/error-handling\/SKILL\.md/);
    assert.match(restored.stdout, /re-bound governance\.json/);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /exempt/);
    assert.equal(
      govctl(['verify', '--remote', '--strict'], { cwd: world.project, env: world.env }).code,
      0,
    );
  });

  test('restore repairs drift and reports what it fixed', () => {
    const path = join(world.govDir, 'skills', 'security-baseline', 'SKILL.md');
    appendTo(path, '\n<!-- local edit -->\n');
    assert.equal(govctl(['verify'], { cwd: world.project, env: world.env }).code, 1);

    const restored = govctl(['restore'], { cwd: world.project, env: world.env });
    assert.equal(restored.code, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /restored skills\/security-baseline\/SKILL\.md/);
    assert.equal(govctl(['verify', '--strict'], { cwd: world.project, env: world.env }).code, 0);
  });
});

describe('registry-side checks', () => {
  let world;

  before(() => {
    world = makeWorld({ tier: 'startup' });
  });
  after(() => world.cleanup());

  test('policy validate resolves every tier', () => {
    const result = govctl(['policy', 'validate', '--dir', world.registry, '--json'], { env: world.env });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /tier 'corporate' resolves/);
    assert.match(result.stdout, /tier 'startup' resolves/);
  });

  test('policy validate fails when a tier references an unknown rule', () => {
    const tierPath = join(world.registry, 'tiers', 'startup.yaml');
    const original = readFileSync(tierPath, 'utf8');
    writeFileSync(tierPath, original + '\n  no-such-rule:\n    enforcement: block\n');

    const result = govctl(['policy', 'validate', '--dir', world.registry], { env: world.env });
    assert.equal(result.code, 1);
    assert.match(result.stdout + result.stderr, /references unknown rule 'no-such-rule'/);

    writeFileSync(tierPath, original);
  });

  test('manifest check fails when governed content changed without regeneration', () => {
    const skillPath = join(world.registry, 'skills', 'api-design-patterns', 'SKILL.md');
    const original = readFileSync(skillPath, 'utf8');

    assert.equal(govctl(['manifest', 'check', '--dir', world.registry], { env: world.env }).code, 0);

    appendTo(skillPath, '\n<!-- unreleased edit -->\n');
    const result = govctl(['manifest', 'check', '--dir', world.registry], { env: world.env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /hash out of date: skills\/api-design-patterns\/SKILL\.md/);

    writeFileSync(skillPath, original);
    release(world.registry, world.version, world.keyPath, world.env);
  });
});
