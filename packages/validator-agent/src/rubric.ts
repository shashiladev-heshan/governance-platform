import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ResolvedPolicy, ResolvedRule } from '@shashiladev-heshan/policy-core';

export interface SkillDoc {
  slug: string;
  name: string;
  description: string;
  /** Rule ids this skill teaches, from frontmatter `metadata.rules`. */
  ruleIds: string[];
  body: string;
}

export interface Rubric {
  skills: SkillDoc[];
  rules: ResolvedRule[];
}

/**
 * Build the agent's rubric from the verified .governance directory.
 *
 * Only rules whose effective enforcement is not `off` are included, and only the
 * skills that teach them. A startup-tier project therefore does not pay tokens
 * for rules its tier has switched off.
 */
export function loadRubric(governanceDir: string, policy: ResolvedPolicy): Rubric {
  const rules = Object.values(policy.rules)
    .filter((rule) => rule.enforcement !== 'off')
    .sort((a, b) => a.id.localeCompare(b.id));

  const wanted = new Set(rules.map((r) => r.skill).filter((s): s is string => Boolean(s)));
  const skills: SkillDoc[] = [];

  for (const slug of [...wanted].sort()) {
    const path = join(governanceDir, 'skills', slug, 'SKILL.md');
    if (!existsSync(path)) {
      throw new Error(
        `rule references skill '${slug}' but ${path} is missing — run 'govctl sync' or fix the registry`,
      );
    }
    skills.push(parseSkill(slug, readFileSync(path, 'utf8')));
  }

  return { skills, rules };
}

export function parseSkill(slug: string, raw: string): SkillDoc {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) {
    return { slug, name: slug, description: '', ruleIds: [], body: raw.trim() };
  }

  const frontmatter = (parseYaml(match[1] ?? '') ?? {}) as {
    name?: string;
    description?: string;
    metadata?: { rules?: string[] };
  };

  return {
    slug,
    name: frontmatter.name ?? slug,
    description: frontmatter.description ?? '',
    ruleIds: frontmatter.metadata?.rules ?? [],
    body: (match[2] ?? '').trim(),
  };
}
