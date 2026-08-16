import { z } from 'zod';
import { SeveritySchema, type ResolvedPolicy, type Severity } from './types.js';

/**
 * The finding shape the validator agent must emit. Enforced with Zod at the
 * tool-call boundary: a malformed verdict never reaches the gate.
 */
export const FindingSchema = z.object({
  ruleId: z.string().min(1),
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  rationale: z.string().min(1),
  suggestedFix: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export type GateVerdict = 'pass' | 'warn' | 'block';

export interface GateResult {
  verdict: GateVerdict;
  blocking: Finding[];
  warnings: Finding[];
  /** Findings on rules whose effective enforcement is `off` for this tier. */
  dropped: Finding[];
  /** Findings citing a rule id that is not in the resolved policy. */
  unknownRules: Finding[];
}

/**
 * Turn findings + resolved policy into a merge decision.
 *
 * A finding blocks only when BOTH hold:
 *   - the rule's effective enforcement for this tier is `block`, and
 *   - the finding's severity is `error`
 *
 * Everything else warns. Findings citing an unknown rule id are never blocking
 * (an agent must not be able to invent a blocking rule) but are never silently
 * dropped either — they surface as warnings and are listed separately so the
 * platform team sees rubric drift.
 *
 * This is deterministic code. The agent supplies findings; it does not decide
 * the gate.
 */
export function gateVerdict(findings: Finding[], policy: ResolvedPolicy): GateResult {
  const blocking: Finding[] = [];
  const warnings: Finding[] = [];
  const dropped: Finding[] = [];
  const unknownRules: Finding[] = [];

  for (const finding of findings) {
    const rule = policy.rules[finding.ruleId];

    if (!rule) {
      unknownRules.push(finding);
      warnings.push(finding);
      continue;
    }

    if (rule.enforcement === 'off') {
      dropped.push(finding);
      continue;
    }

    if (rule.enforcement === 'block' && finding.severity === 'error') {
      blocking.push(finding);
      continue;
    }

    warnings.push(finding);
  }

  const verdict: GateVerdict =
    blocking.length > 0 ? 'block' : warnings.length > 0 ? 'warn' : 'pass';

  return { verdict, blocking, warnings, dropped, unknownRules };
}

/**
 * Highest severity a rule can produce under the current policy. Used to scope
 * the agent prompt (no point asking it to hunt for `off` rules).
 */
export function activeRuleIds(policy: ResolvedPolicy): string[] {
  return Object.values(policy.rules)
    .filter((r) => r.enforcement !== 'off')
    .map((r) => r.id)
    .sort();
}

export function maxSeverity(findings: Finding[]): Severity | null {
  const order: Severity[] = ['info', 'warn', 'error'];
  let best: Severity | null = null;
  for (const f of findings) {
    if (best === null || order.indexOf(f.severity) > order.indexOf(best)) best = f.severity;
  }
  return best;
}
