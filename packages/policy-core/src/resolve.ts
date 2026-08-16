import {
  enforcementRank,
  severityRank,
  type Enforcement,
  type PolicyDoc,
  type ProjectOverrides,
  type ProvenanceEntry,
  type ResolvedPolicy,
  type ResolvedRule,
  type Severity,
  type TierDoc,
} from './types.js';

/**
 * Resolve the effective policy for a project.
 *
 * Precedence (deterministic, order matters):
 *   1. base policy rule fields, falling back to the policy document's `defaults`
 *   2. tier layer — `tier.rules[id]` if the tier names the rule explicitly,
 *      otherwise `tier.defaults` (which is why a startup tier can say
 *      "everything is advisory" while still pinning one rule to `block`)
 *   3. project overrides from governance.json
 *
 * Project overrides may always STRENGTHEN (move enforcement/severity up).
 * WEAKENING requires `overridable: true` on the resolved rule; otherwise the
 * attempt is refused and recorded in `rejectedOverrides` so CI can report it.
 * A project can never grant itself `overridable`.
 *
 * This function is pure — the same inputs always produce the same output. It is
 * the single implementation shared by govctl, the CI verifier, and the agent.
 */
export function resolvePolicy(
  policy: PolicyDoc,
  tier: TierDoc,
  overrides: ProjectOverrides = { rules: {} },
): ResolvedPolicy {
  const rules: Record<string, ResolvedRule> = {};
  const rejectedOverrides: Array<{ ruleId: string; reason: string }> = [];

  const sortedRuleIds = [...policy.rules].map((r) => r.id).sort();
  const baseById = new Map(policy.rules.map((r) => [r.id, r]));

  for (const ruleId of sortedRuleIds) {
    const base = baseById.get(ruleId)!;
    const provenance: ProvenanceEntry[] = [];

    let severity: Severity = base.severity ?? policy.defaults.severity;
    let enforcement: Enforcement = base.enforcement ?? policy.defaults.enforcement;
    let overridable: boolean = base.overridable ?? policy.defaults.overridable;

    provenance.push({ layer: 'base', field: 'enforcement', from: '-', to: enforcement });

    // --- Layer 2: tier -------------------------------------------------------
    const tierOverlay = tier.rules[ruleId];
    if (tierOverlay) {
      if (tierOverlay.severity && tierOverlay.severity !== severity) {
        provenance.push({
          layer: 'tier-rule',
          field: 'severity',
          from: severity,
          to: tierOverlay.severity,
        });
        severity = tierOverlay.severity;
      }
      if (tierOverlay.enforcement && tierOverlay.enforcement !== enforcement) {
        provenance.push({
          layer: 'tier-rule',
          field: 'enforcement',
          from: enforcement,
          to: tierOverlay.enforcement,
        });
        enforcement = tierOverlay.enforcement;
      }
      if (tierOverlay.overridable !== undefined && tierOverlay.overridable !== overridable) {
        provenance.push({
          layer: 'tier-rule',
          field: 'overridable',
          from: String(overridable),
          to: String(tierOverlay.overridable),
        });
        overridable = tierOverlay.overridable;
      }
    } else {
      // Tier defaults apply only to rules the tier does not name explicitly.
      if (tier.defaults.enforcement && tier.defaults.enforcement !== enforcement) {
        provenance.push({
          layer: 'tier-default',
          field: 'enforcement',
          from: enforcement,
          to: tier.defaults.enforcement,
        });
        enforcement = tier.defaults.enforcement;
      }
      if (tier.defaults.overridable !== undefined && tier.defaults.overridable !== overridable) {
        provenance.push({
          layer: 'tier-default',
          field: 'overridable',
          from: String(overridable),
          to: String(tier.defaults.overridable),
        });
        overridable = tier.defaults.overridable;
      }
    }

    // --- Layer 3: project overrides -----------------------------------------
    const projectOverlay = overrides.rules[ruleId];
    if (projectOverlay) {
      if (projectOverlay.overridable !== undefined) {
        const reason = `rule '${ruleId}': a project cannot change 'overridable' (attempted ${overridable} -> ${projectOverlay.overridable})`;
        rejectedOverrides.push({ ruleId, reason });
        provenance.push({
          layer: 'project-override',
          field: 'overridable',
          from: String(overridable),
          to: String(projectOverlay.overridable),
          rejected: reason,
        });
      }

      if (projectOverlay.enforcement && projectOverlay.enforcement !== enforcement) {
        const weakening = enforcementRank(projectOverlay.enforcement) < enforcementRank(enforcement);
        if (weakening && !overridable) {
          const reason = `rule '${ruleId}': cannot weaken enforcement ${enforcement} -> ${projectOverlay.enforcement} (rule is not overridable)`;
          rejectedOverrides.push({ ruleId, reason });
          provenance.push({
            layer: 'project-override',
            field: 'enforcement',
            from: enforcement,
            to: projectOverlay.enforcement,
            rejected: reason,
          });
        } else {
          provenance.push({
            layer: 'project-override',
            field: 'enforcement',
            from: enforcement,
            to: projectOverlay.enforcement,
          });
          enforcement = projectOverlay.enforcement;
        }
      }

      if (projectOverlay.severity && projectOverlay.severity !== severity) {
        const weakening = severityRank(projectOverlay.severity) < severityRank(severity);
        if (weakening && !overridable) {
          const reason = `rule '${ruleId}': cannot weaken severity ${severity} -> ${projectOverlay.severity} (rule is not overridable)`;
          rejectedOverrides.push({ ruleId, reason });
          provenance.push({
            layer: 'project-override',
            field: 'severity',
            from: severity,
            to: projectOverlay.severity,
            rejected: reason,
          });
        } else {
          provenance.push({
            layer: 'project-override',
            field: 'severity',
            from: severity,
            to: projectOverlay.severity,
          });
          severity = projectOverlay.severity;
        }
      }
    }

    rules[ruleId] = {
      id: base.id,
      title: base.title,
      ...(base.skill ? { skill: base.skill } : {}),
      severity,
      enforcement,
      overridable,
      detectedBy: base.detectedBy,
      ...(base.rationale ? { rationale: base.rationale } : {}),
      provenance,
    };
  }

  // Overlays naming a rule that does not exist are configuration rot — surface them.
  for (const ruleId of Object.keys(tier.rules).sort()) {
    if (!rules[ruleId]) {
      rejectedOverrides.push({
        ruleId,
        reason: `tier '${tier.tier}' references unknown rule '${ruleId}'`,
      });
    }
  }
  for (const ruleId of Object.keys(overrides.rules).sort()) {
    if (!rules[ruleId]) {
      rejectedOverrides.push({
        ruleId,
        reason: `project override references unknown rule '${ruleId}'`,
      });
    }
  }

  return {
    tier: tier.tier,
    staleness: { maxReleasesBehind: tier.staleness.maxReleasesBehind },
    rules,
    rejectedOverrides,
  };
}
