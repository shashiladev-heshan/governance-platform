import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, parse as parsePath } from 'node:path';
import { z } from 'zod';

export const GOVERNANCE_FILE = 'governance.json';
export const GOVERNANCE_DIR = '.governance';

export const GovernanceConfigSchema = z.object({
  schemaVersion: z.literal(1),
  registry: z.string().min(1),
  tier: z.string().min(1),
  version: z.string().min(1),
  /** SHA-256 of the local manifest file's bytes — detects manifest swapping. */
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  governedDirs: z.array(z.string()).default(['skills', 'policies', 'tiers']),
  overrides: z
    .object({
      rules: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    })
    .optional(),
});
export type GovernanceConfig = z.infer<typeof GovernanceConfigSchema>;

export class ConfigError extends Error {}

/** Walk up from `startDir` looking for governance.json. */
export function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, GOVERNANCE_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir || parent === parsePath(dir).root) {
      return existsSync(join(parent, GOVERNANCE_FILE)) ? parent : null;
    }
    dir = parent;
  }
}

export function requireProjectRoot(startDir: string): string {
  const root = findProjectRoot(startDir);
  if (!root) {
    throw new ConfigError(
      `no ${GOVERNANCE_FILE} found in ${startDir} or any parent. Run 'govctl init --registry <url> --tier <tier>' first.`,
    );
  }
  return root;
}

export async function readConfig(projectRoot: string): Promise<GovernanceConfig> {
  const path = join(projectRoot, GOVERNANCE_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`could not read ${path}: ${(err as Error).message}`);
  }
  const parsed = GovernanceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`invalid ${GOVERNANCE_FILE}: ${issues}`);
  }
  return parsed.data;
}

export async function writeConfig(projectRoot: string, config: GovernanceConfig): Promise<void> {
  await writeFile(
    join(projectRoot, GOVERNANCE_FILE),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );
}

export function governanceDir(projectRoot: string): string {
  return join(projectRoot, GOVERNANCE_DIR);
}
