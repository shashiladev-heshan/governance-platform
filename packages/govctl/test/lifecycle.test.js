import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { govctl, makeWorld, cutRelease, readJson, writeJson, appendTo } from './helpers.js';
import { detectTooling, isStubConfig, renderLefthook } from '../dist/lib/lefthook.js';

describe('onboarding', () => {
  let world;
  before(() => {
    world = makeWorld({ tier: 'corporate' });
  });
  after(() => world.cleanup());

  test('init lays down everything a project needs', () => {
    for (const path of [
      'governance.json',
      'lefthook.yml',
      '.prettierignore',
      '.governance/manifest.lock.json',
      '.governance/manifest.lock.json.bundle',
      '.governance/skills/nestjs-conventions/SKILL.md',
      '.governance/policies/policy.yaml',
      '.governance/policies/semgrep/security.yaml',
      '.governance/tiers/corporate.yaml',
    ]) {
      assert.ok(existsSync(join(world.project, path)), `missing ${path}`);
    }

    const config = readJson(join(world.project, 'governance.json'));
    assert.equal(config.tier, 'corporate');
    assert.equal(config.version, world.version);
    assert.match(config.manifestSha256, /^[0-9a-f]{64}$/);
  });

  test('the hooks it installs actually invoke govctl', () => {
    const lefthook = readFileSync(join(world.project, 'lefthook.yml'), 'utf8');
    assert.match(lefthook, /pre-commit:/);
    assert.match(lefthook, /pre-push:/);
    assert.match(lefthook, /^ +govctl verify$/m);
    assert.match(lefthook, /govctl is not installed/);

    // Never `npx govctl`: on a machine without govctl installed, npx fetches and
    // executes whatever unscoped `govctl` package exists on the public registry.
    assert.doesNotMatch(lefthook, /npx govctl/);
  });

  test('no lint hook is generated for a project with no linter configured', () => {
    // Otherwise every commit in a fresh project fails with "ESLint couldn't find
    // a config file", and developers learn that governance hooks are broken.
    const lefthook = readFileSync(join(world.project, 'lefthook.yml'), 'utf8');
    assert.doesNotMatch(lefthook, /^ +run: npx eslint/m);
    assert.doesNotMatch(lefthook, /^ +run: npx prettier/m);
    assert.match(lefthook, /No eslint or prettier config found/);
  });

  test('when the project does have formatters, they exclude governed content', () => {
    // Without the exclude, `prettier --write .` rewrites every SKILL.md and the
    // project fails its own integrity check for a reason nobody would guess.
    const rendered = renderLefthook({ eslint: true, prettier: true });
    assert.match(rendered, /run: npx eslint \{staged_files\}/);
    assert.match(rendered, /run: npx prettier --check \{staged_files\}/);
    for (const block of rendered.split('    lint:').slice(1)) {
      assert.match(block, /exclude:[\s\S]*\.governance/);
    }
    assert.match(
      readFileSync(join(world.project, '.prettierignore'), 'utf8'),
      /^\.governance\/$/m,
    );
  });

  test('formatter detection recognises both flat and legacy configs', () => {
    const dir = join(world.root, 'detect-probe');
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(detectTooling(dir), { eslint: false, prettier: false });

    writeFileSync(join(dir, 'eslint.config.js'), 'export default [];\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ prettier: { semi: true } }));
    assert.deepEqual(detectTooling(dir), { eslint: true, prettier: true });
  });

  test('init refuses to clobber an existing project', () => {
    const result = govctl(['init', '--registry', world.registry, '--tier', 'startup'], {
      cwd: world.project,
      env: world.env,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /already exists/);
  });

  test('an unknown tier fails with the available options', () => {
    const other = join(world.root, 'other-project');
    mkdirSync(other, { recursive: true });
    const result = govctl(
      ['init', '--registry', world.registry, '--tier', 'enterprise', '--tag', world.version],
      { cwd: other, env: world.env },
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown tier 'enterprise'.*corporate, startup/s);
    assert.equal(existsSync(join(other, 'governance.json')), false, 'a failed init leaves nothing behind');
  });

  test('status reports version, tier, rule counts and integrity', () => {
    const result = govctl(['status', '--json'], { cwd: world.project, env: world.env });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.tier, 'corporate');
    assert.equal(status.releasesBehind, 0);
    assert.equal(status.maxReleasesBehind, 2);
    assert.ok(status.rules.block > 0);
    assert.equal(status.ok, true);
  });
});

describe('release lifecycle', () => {
  let world;
  before(() => {
    world = makeWorld({ tier: 'corporate' });
  });
  after(() => world.cleanup());

  test('sync moves a project to a newer release', () => {
    appendTo(
      join(world.registry, 'skills', 'error-handling', 'SKILL.md'),
      '\n## New guidance\n\nRetries must be bounded.\n',
    );
    cutRelease(world.registry, 'v0.2.0', world.keyPath, world.env);

    const sync = govctl(['sync'], { cwd: world.project, env: world.env });
    assert.equal(sync.code, 0, sync.stdout + sync.stderr);

    const config = readJson(join(world.project, 'governance.json'));
    assert.equal(config.version, 'v0.2.0');
    assert.match(
      readFileSync(join(world.govDir, 'skills', 'error-handling', 'SKILL.md'), 'utf8'),
      /Retries must be bounded/,
    );
    assert.equal(govctl(['verify', '--strict'], { cwd: world.project, env: world.env }).code, 0);
  });

  test('sync is a no-op when already on the latest release', () => {
    const result = govctl(['sync'], { cwd: world.project, env: world.env });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /already on v0\.2\.0 \(latest\)/);
  });

  test('a rule deleted upstream disappears locally', () => {
    const rulePath = join(world.registry, 'policies', 'semgrep', 'error-handling.yaml');
    const original = readFileSync(rulePath, 'utf8');
    unlinkSync(rulePath);
    cutRelease(world.registry, 'v0.3.0', world.keyPath, world.env);

    assert.equal(govctl(['sync'], { cwd: world.project, env: world.env }).code, 0);
    assert.equal(
      existsSync(join(world.govDir, 'policies', 'semgrep', 'error-handling.yaml')),
      false,
      'a stale rule must not linger after it is removed upstream',
    );

    writeFileSync(rulePath, original);
    cutRelease(world.registry, 'v0.4.0', world.keyPath, world.env);
    assert.equal(govctl(['sync'], { cwd: world.project, env: world.env }).code, 0);
  });

  test('staleness fails the corporate window but not the startup one', () => {
    // Pin the project back to v0.1.0, then cut enough releases to exceed the
    // corporate window (2) but stay inside the startup window (6).
    const config = readJson(join(world.project, 'governance.json'));
    writeJson(join(world.project, 'governance.json'), config);
    assert.equal(govctl(['sync', '--tag', 'v0.1.0'], { cwd: world.project, env: world.env }).code, 0);

    const stale = govctl(['verify', '--remote', '--strict'], { cwd: world.project, env: world.env });
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /governance is stale: pinned v0\.1\.0, latest v0\.4\.0 \(3 releases behind/);

    // Same repo, startup tier: the wider window accepts it.
    const relaxed = readJson(join(world.project, 'governance.json'));
    relaxed.tier = 'startup';
    writeJson(join(world.project, 'governance.json'), relaxed);
    const ok = govctl(['verify', '--remote', '--strict'], { cwd: world.project, env: world.env });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);

    relaxed.tier = 'corporate';
    writeJson(join(world.project, 'governance.json'), relaxed);
    assert.equal(govctl(['sync'], { cwd: world.project, env: world.env }).code, 0);
  });

  test('--skip-staleness lets a hotfix through the freshness check only', () => {
    assert.equal(govctl(['sync', '--tag', 'v0.1.0'], { cwd: world.project, env: world.env }).code, 0);
    const result = govctl(['verify', '--remote', '--strict', '--skip-staleness'], {
      cwd: world.project,
      env: world.env,
    });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(govctl(['sync'], { cwd: world.project, env: world.env }).code, 0);
  });
});

describe('lefthook stub handling', () => {
  let world;
  before(() => {
    world = makeWorld({ tier: 'corporate' });
  });
  after(() => world.cleanup());

  const LEFTHOOK_STUB = `# EXAMPLE USAGE:
#
# pre-commit:
#   parallel: true
#   jobs:
#     - run: yarn eslint {staged_files}
`;

  test('the stub written by `lefthook install` is recognised as empty', () => {
    assert.equal(isStubConfig(LEFTHOOK_STUB), true);
    assert.equal(isStubConfig('pre-commit:\n  commands:\n    x:\n      run: true\n'), false);
    assert.equal(isStubConfig('# only a comment\n\n   \n'), true);
  });

  test('init replaces the stub instead of silently skipping it', async () => {
    // `npm i -D lefthook` runs `lefthook install` from a postinstall hook, which
    // writes that stub — so it is almost always there before govctl runs.
    const project = join(world.root, 'stubbed');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'lefthook.yml'), LEFTHOOK_STUB);

    const result = govctl(
      ['init', '--registry', world.registry, '--tier', 'corporate', '--tag', world.version],
      { cwd: project, env: world.env },
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /replaced the empty lefthook.yml stub/);
    assert.match(readFileSync(join(project, 'lefthook.yml'), 'utf8'), /govctl verify/);
  });

  test('a real config is never overwritten, but the snippet is printed', () => {
    const project = join(world.root, 'has-hooks');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'lefthook.yml'),
      'pre-commit:\n  commands:\n    mine:\n      run: echo hello\n',
    );

    const result = govctl(
      ['init', '--registry', world.registry, '--tier', 'corporate', '--tag', world.version],
      { cwd: project, env: world.env },
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /governance hooks are NOT installed/);
    assert.match(result.stdout, /govctl verify/);
    assert.match(readFileSync(join(project, 'lefthook.yml'), 'utf8'), /echo hello/);
  });
});

describe('prettierignore maintenance', () => {
  let world;
  before(() => {
    world = makeWorld({ tier: 'corporate' });
  });
  after(() => world.cleanup());

  test('init ignores both governed content and the generated lefthook.yml', () => {
    // lefthook.yml is generated and overwritten by init; its quote style cannot
    // match every project's prettier config, so formatting it is churn that
    // fails the very first commit in a Nest project.
    const ignore = readFileSync(join(world.project, '.prettierignore'), 'utf8');
    assert.match(ignore, /^\.governance\/$/m);
    assert.match(ignore, /^lefthook\.yml$/m);
    assert.match(ignore, /^governance\.json$/m);
  });

  test('an existing .prettierignore gains only the entries it is missing', async () => {
    const project = join(world.root, 'existing-ignore');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '.prettierignore'), 'dist\ncoverage\n');

    const result = govctl(
      ['init', '--registry', world.registry, '--tier', 'corporate', '--tag', world.version],
      { cwd: project, env: world.env },
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);

    const ignore = readFileSync(join(project, '.prettierignore'), 'utf8');
    assert.match(ignore, /^dist$/m, 'existing entries are preserved');
    assert.match(ignore, /^coverage$/m);
    assert.match(ignore, /^\.governance\/$/m);
    assert.match(ignore, /^lefthook\.yml$/m);
    assert.match(ignore, /^governance\.json$/m);
  });
});
