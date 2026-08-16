import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LEFTHOOK_FILE = 'lefthook.yml';

export interface ToolingPresent {
  eslint: boolean;
  prettier: boolean;
}

/**
 * Which of the project's own formatters are actually configured.
 *
 * Generating hooks for tools a project has not set up means every commit fails
 * with "ESLint couldn't find a config file", which teaches developers that the
 * governance hooks are broken — the opposite of what they are for.
 */
export function detectTooling(projectRoot: string): ToolingPresent {
  const has = (...names: string[]): boolean =>
    names.some((name) => existsSync(join(projectRoot, name)));

  const eslint = has(
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
  );

  let prettier = has(
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs',
  );

  if (!prettier) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
        prettier?: unknown;
      };
      prettier = pkg.prettier !== undefined;
    } catch {
      // No package.json, or unreadable — treat as "not configured".
    }
  }

  return { eslint, prettier };
}

/**
 * Local hooks are convenience, not security — a developer can always pass
 * `--no-verify`. They exist to catch drift in two seconds instead of two
 * minutes of CI. The authoritative check is the required workflow.
 *
 * `govctl` is invoked directly rather than through `npx`. With npx, a machine
 * that does not have govctl installed silently reaches out to the public npm
 * registry for a package called `govctl` — an unscoped name this org does not
 * own — and runs whatever it finds. A "command not found" is the correct
 * failure there.
 */
/** The published name, used in the "not installed" hint the hooks print. */
export const GOVCTL_PACKAGE = '@shashiladev-heshan/govctl';

const VERIFY_STEP = [
  '      run: |',
  '        command -v govctl >/dev/null 2>&1 || {',
  `          echo "govctl is not installed. Install it with: npm i -g ${GOVCTL_PACKAGE}"`,
  '          echo "(or skip this commit with --no-verify — CI will still check)"',
  '          exit 1',
  '        }',
  '        govctl verify',
];

export function renderLefthook(tooling: ToolingPresent): string {
  const lines: string[] = [
    '# Managed by govctl. Local hooks are ADVISORY — the authoritative governance',
    '# gate is the required GitHub workflow (governance-verify.yml).',
    '#',
    '# govctl is called directly, not via npx: npx would fetch and execute an',
    '# unscoped `govctl` package from the public registry on any machine that does',
    '# not have it installed.',
    'pre-commit:',
    '  parallel: true',
    '  commands:',
    '    governance:',
    ...VERIFY_STEP,
    '      fail_text: "govctl verify failed — see the output above. If content drifted: govctl restore"',
  ];

  // Governed content is linted and formatted by the registry, not by this
  // project. Running a formatter over .governance/ rewrites the files and breaks
  // their hashes — see also .prettierignore.
  if (tooling.eslint) {
    lines.push(
      '    lint:',
      '      glob: "*.{ts,tsx,js,jsx}"',
      '      exclude:',
      '        - ".governance/**"',
      '      run: npx eslint {staged_files}',
    );
  }

  if (tooling.prettier) {
    lines.push(
      '    format:',
      '      glob: "*.{ts,tsx,js,jsx,json,md,yml,yaml}"',
      '      exclude:',
      '        - ".governance/**"',
      '        - "governance.json"',
      '      run: npx prettier --check {staged_files}',
    );
  }

  if (!tooling.eslint || !tooling.prettier) {
    const missing = [
      !tooling.eslint ? 'eslint' : null,
      !tooling.prettier ? 'prettier' : null,
    ].filter(Boolean);
    lines.push(
      '',
      `# No ${missing.join(' or ')} config found in this project, so no ${missing.join('/')} hook`,
      '# was generated. Once configured, add (note the .governance exclude):',
      '#',
      '#    lint:',
      '#      glob: "*.{ts,tsx,js,jsx}"',
      '#      exclude: [".governance/**"]',
      '#      run: npx eslint {staged_files}',
    );
  }

  lines.push('', 'pre-push:', '  commands:', '    governance:', ...VERIFY_STEP, '');

  return lines.join('\n');
}

/** Paths a project's own tooling must never rewrite. */
export const IGNORE_MARKER = '# governed content — managed by govctl, do not format';
export const IGNORED_PATHS = ['.governance/'];

/**
 * Keep formatters away from governed content. Without this, a routine
 * `prettier --write .` rewrites every SKILL.md and the project fails its own
 * integrity check for a reason nobody would guess.
 */
export async function installIgnoreFile(
  projectRoot: string,
  file = '.prettierignore',
): Promise<'written' | 'appended' | 'skipped'> {
  const path = join(projectRoot, file);
  const block = `${IGNORE_MARKER}\n${IGNORED_PATHS.join('\n')}\n`;

  if (!existsSync(path)) {
    await writeFile(path, block, 'utf8');
    return 'written';
  }

  const current = await readFile(path, 'utf8');
  if (current.includes(IGNORE_MARKER) || IGNORED_PATHS.every((p) => current.includes(p))) {
    return 'skipped';
  }

  await writeFile(path, `${current.replace(/\n*$/, '\n')}\n${block}`, 'utf8');
  return 'appended';
}

/**
 * Is this lefthook.yml the stub that `lefthook install` writes when it finds no
 * config — i.e. entirely comments, no active jobs?
 *
 * This matters because the `lefthook` npm package runs `lefthook install` from a
 * postinstall hook. `npm i -D lefthook` therefore creates a stub config before
 * `govctl init` ever runs, and treating that stub as "a file the developer wrote"
 * means the governance hooks are silently never installed.
 */
export function isStubConfig(content: string): boolean {
  const meaningful = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return meaningful.length === 0;
}

export type LefthookInstallResult = 'written' | 'replaced-stub' | 'skipped';

export async function installLefthook(
  projectRoot: string,
  force = false,
): Promise<LefthookInstallResult> {
  const path = join(projectRoot, LEFTHOOK_FILE);
  const rendered = renderLefthook(detectTooling(projectRoot));

  if (!existsSync(path)) {
    await writeFile(path, rendered, 'utf8');
    return 'written';
  }

  if (isStubConfig(await readFile(path, 'utf8'))) {
    await writeFile(path, rendered, 'utf8');
    return 'replaced-stub';
  }

  if (force) {
    await writeFile(path, rendered, 'utf8');
    return 'written';
  }

  return 'skipped';
}

/** The block to paste when we refuse to touch an existing config. */
export function governanceHookSnippet(): string {
  return renderLefthook({ eslint: false, prettier: false })
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
