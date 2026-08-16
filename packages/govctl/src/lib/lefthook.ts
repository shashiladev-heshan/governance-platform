import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LEFTHOOK_FILE = 'lefthook.yml';

/**
 * Local hooks are convenience, not security — a developer can always pass
 * `--no-verify`. They exist to catch drift in two seconds instead of two
 * minutes of CI. The authoritative check is the required workflow.
 */
export const LEFTHOOK_TEMPLATE = `# Managed by govctl. Local hooks are ADVISORY — the authoritative
# governance gate is the required GitHub workflow (governance-verify.yml).
#
# Note the excludes: governed content is formatted and linted by the registry, not
# by this project. Running a formatter over .governance/ would rewrite the files
# and break their hashes — see also .prettierignore.
pre-commit:
  parallel: true
  commands:
    governance:
      run: npx govctl verify
      fail_text: "Governed content drifted. Run 'govctl restore' or 'govctl sync'."
    lint:
      glob: "*.{ts,tsx,js,jsx}"
      exclude:
        - ".governance/**"
      run: npx eslint {staged_files}
    format:
      glob: "*.{ts,tsx,js,jsx,json,md,yml,yaml}"
      exclude:
        - ".governance/**"
        - "governance.json"
      run: npx prettier --check {staged_files}

pre-push:
  commands:
    governance:
      run: npx govctl verify
`;

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

export async function installLefthook(
  projectRoot: string,
  force = false,
): Promise<'written' | 'skipped'> {
  const path = join(projectRoot, LEFTHOOK_FILE);
  if (existsSync(path) && !force) return 'skipped';
  await writeFile(path, LEFTHOOK_TEMPLATE, 'utf8');
  return 'written';
}
