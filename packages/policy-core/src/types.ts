import { z } from 'zod';

/**
 * Enforcement levels are ordered. Strengthening (moving toward `block`) is always
 * permitted; weakening requires the rule to be marked `overridable: true`.
 */
export const ENFORCEMENT_ORDER = ['off', 'warn', 'block'] as const;
export type Enforcement = (typeof ENFORCEMENT_ORDER)[number];

export const SEVERITY_ORDER = ['info', 'warn', 'error'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export function enforcementRank(e: Enforcement): number {
  return ENFORCEMENT_ORDER.indexOf(e);
}

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export const EnforcementSchema = z.enum(ENFORCEMENT_ORDER);
export const SeveritySchema = z.enum(SEVERITY_ORDER);

/** How a rule is detected. Purely informational for humans + agent prompt scoping. */
export const DetectorSchema = z.enum(['eslint', 'semgrep', 'agent', 'manual']);
export type Detector = z.infer<typeof DetectorSchema>;

export const RuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Slug of the SKILL.md that defines/teaches this rule; loaded as agent rubric. */
  skill: z.string().optional(),
  severity: SeveritySchema.optional(),
  enforcement: EnforcementSchema.optional(),
  overridable: z.boolean().optional(),
  detectedBy: z.array(DetectorSchema).default([]),
  rationale: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const PolicyDocSchema = z.object({
  schemaVersion: z.literal(1),
  defaults: z
    .object({
      severity: SeveritySchema.default('warn'),
      enforcement: EnforcementSchema.default('warn'),
      overridable: z.boolean().default(false),
    })
    .default({}),
  rules: z.array(RuleSchema).min(1),
});
export type PolicyDoc = z.infer<typeof PolicyDocSchema>;

export const TierRuleOverlaySchema = z.object({
  severity: SeveritySchema.optional(),
  enforcement: EnforcementSchema.optional(),
  /** A tier may open a rule up for project-level weakening, or lock it down. */
  overridable: z.boolean().optional(),
});
export type TierRuleOverlay = z.infer<typeof TierRuleOverlaySchema>;

export const TierDocSchema = z.object({
  schemaVersion: z.literal(1),
  tier: z.string().min(1),
  description: z.string().optional(),
  defaults: z
    .object({
      /** Replaces base enforcement for every rule NOT named in `rules` below. */
      enforcement: EnforcementSchema.optional(),
      overridable: z.boolean().optional(),
    })
    .default({}),
  staleness: z
    .object({
      maxReleasesBehind: z.number().int().nonnegative().default(2),
    })
    .default({}),
  rules: z.record(z.string(), TierRuleOverlaySchema).default({}),
});
export type TierDoc = z.infer<typeof TierDocSchema>;

export const ProjectOverridesSchema = z
  .object({
    rules: z.record(z.string(), TierRuleOverlaySchema).default({}),
  })
  .default({});
export type ProjectOverrides = z.infer<typeof ProjectOverridesSchema>;

export interface ResolvedRule {
  id: string;
  title: string;
  skill?: string;
  severity: Severity;
  enforcement: Enforcement;
  overridable: boolean;
  detectedBy: Detector[];
  rationale?: string;
  /** Ordered trace of every layer that touched this rule — this is the audit record. */
  provenance: ProvenanceEntry[];
}

export interface ProvenanceEntry {
  layer: 'base' | 'tier-default' | 'tier-rule' | 'project-override';
  field: 'severity' | 'enforcement' | 'overridable';
  from: string;
  to: string;
  /** Set when a layer tried to change something and was refused. */
  rejected?: string;
}

export interface ResolvedPolicy {
  tier: string;
  staleness: { maxReleasesBehind: number };
  rules: Record<string, ResolvedRule>;
  /** Override attempts that were refused, surfaced so CI can report them loudly. */
  rejectedOverrides: Array<{ ruleId: string; reason: string }>;
}
