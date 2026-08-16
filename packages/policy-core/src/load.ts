import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PolicyDocSchema, ProjectOverridesSchema, TierDocSchema, type PolicyDoc, type ProjectOverrides, type TierDoc } from './types.js';
import { resolvePolicy } from './resolve.js';
import type { ResolvedPolicy } from './types.js';

export class PolicyLoadError extends Error {}

export function loadPolicyDoc(path: string): PolicyDoc {
  const raw = readYaml(path);
  const parsed = PolicyDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PolicyLoadError(`invalid policy document at ${path}: ${formatIssues(parsed.error)}`);
  }
  assertUniqueRuleIds(parsed.data, path);
  return parsed.data;
}

export function loadTierDoc(path: string): TierDoc {
  const raw = readYaml(path);
  const parsed = TierDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PolicyLoadError(`invalid tier document at ${path}: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function parseProjectOverrides(raw: unknown): ProjectOverrides {
  const parsed = ProjectOverridesSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new PolicyLoadError(`invalid project overrides: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Load and resolve the effective policy from a synced `.governance/` directory.
 * Used identically by govctl, the CI verifier, and the validator agent — one
 * code path, so local advice and merge gating can never disagree.
 */
export function loadResolvedPolicy(
  governanceDir: string,
  tier: string,
  overrides: unknown = {},
): ResolvedPolicy {
  const policyPath = join(governanceDir, 'policies', 'policy.yaml');
  const tierPath = join(governanceDir, 'tiers', `${tier}.yaml`);

  if (!existsSync(policyPath)) {
    throw new PolicyLoadError(`missing policy file: ${policyPath} (run 'govctl sync')`);
  }
  if (!existsSync(tierPath)) {
    throw new PolicyLoadError(`unknown tier '${tier}': no ${tierPath}`);
  }

  return resolvePolicy(loadPolicyDoc(policyPath), loadTierDoc(tierPath), parseProjectOverrides(overrides));
}

function readYaml(path: string): unknown {
  if (!existsSync(path)) throw new PolicyLoadError(`file not found: ${path}`);
  try {
    return parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new PolicyLoadError(`could not parse YAML at ${path}: ${(err as Error).message}`);
  }
}

function assertUniqueRuleIds(doc: PolicyDoc, path: string): void {
  const seen = new Set<string>();
  for (const rule of doc.rules) {
    if (seen.has(rule.id)) {
      throw new PolicyLoadError(`duplicate rule id '${rule.id}' in ${path}`);
    }
    seen.add(rule.id);
  }
}

function formatIssues(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}
