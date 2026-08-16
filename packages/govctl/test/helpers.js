import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..', '..');
export const GOVCTL = join(REPO_ROOT, 'packages', 'govctl', 'dist', 'index.js');
export const REGISTRY_TEMPLATE = join(REPO_ROOT, 'registry-template');

/** Run govctl and capture the result without throwing on a non-zero exit. */
export function govctl(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [GOVCTL, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

export function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

/**
 * Build a complete, signed governance registry in a temp dir and attach a fresh
 * project to it. This is the fixture every tamper test starts from.
 */
export function makeWorld({ tier = 'corporate', version = 'v0.1.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gov-world-'));
  const registry = join(root, 'registry');
  const project = join(root, 'project');
  const trustPath = join(root, 'trust.json');
  const keyPath = join(root, 'signing-key.json');
  const env = { GOVCTL_TRUST_ROOT: trustPath };

  cpSync(REGISTRY_TEMPLATE, registry, { recursive: true });

  const keygen = govctl(['keygen', '--key-id', 'test-signer', '--out', keyPath, '--trust'], { env });
  if (keygen.code !== 0) throw new Error(`keygen failed: ${keygen.stderr}`);

  release(registry, version, keyPath, env);

  git(['init', '-q', '-b', 'main'], registry);
  git(['add', '-A'], registry);
  git(['commit', '-q', '-m', 'governance content'], registry);
  git(['tag', '-a', version, '-m', version, '--no-sign'], registry);

  execFileSync('mkdir', ['-p', project]);
  const init = govctl(
    ['init', '--registry', registry, '--tier', tier, '--tag', version],
    { cwd: project, env },
  );
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}\n${init.stderr}`);

  return {
    root,
    registry,
    project,
    trustPath,
    keyPath,
    env,
    version,
    govDir: join(project, '.governance'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Generate + sign a manifest in a registry working tree. */
export function release(registryDir, version, keyPath, env) {
  const gen = govctl(['manifest', 'generate', '--dir', registryDir, '--tag', version], { env });
  if (gen.code !== 0) throw new Error(`manifest generate failed: ${gen.stderr}`);
  const sign = govctl(['sign', '--dir', registryDir, '--key', keyPath], { env });
  if (sign.code !== 0) throw new Error(`sign failed: ${sign.stderr}`);
}

/** Cut a new tagged release in an existing registry repo. */
export function cutRelease(registryDir, version, keyPath, env) {
  release(registryDir, version, keyPath, env);
  git(['add', '-A'], registryDir);
  git(['commit', '-q', '-m', `release ${version}`], registryDir);
  git(['tag', '-a', version, '-m', version, '--no-sign'], registryDir);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function appendTo(path, text) {
  writeFileSync(path, readFileSync(path, 'utf8') + text);
}
