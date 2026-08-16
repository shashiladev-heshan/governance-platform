import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gateVerdict,
  loadPolicyDoc,
  loadTierDoc,
  loadResolvedPolicy,
  resolvePolicy,
} from '../dist/index.js';

const REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'registry-template');
const policy = loadPolicyDoc(join(REGISTRY, 'policies', 'policy.yaml'));
const corporate = loadTierDoc(join(REGISTRY, 'tiers', 'corporate.yaml'));
const startup = loadTierDoc(join(REGISTRY, 'tiers', 'startup.yaml'));

describe('policy resolution', () => {
  test('tier defaults apply only to rules the tier does not name', () => {
    const resolved = resolvePolicy(policy, startup);

    // Named in tiers/startup.yaml -> keeps its explicit enforcement
    assert.equal(resolved.rules['no-hardcoded-secrets'].enforcement, 'block');
    assert.equal(resolved.rules['config-module-only'].enforcement, 'block');

    // Not named -> falls to the tier default
    assert.equal(resolved.rules['thin-controllers'].enforcement, 'warn');
    assert.equal(resolved.rules['no-error-detail-leak'].enforcement, 'warn');
  });

  test('corporate blocks by default but keeps API style rules advisory', () => {
    const resolved = resolvePolicy(policy, corporate);
    assert.equal(resolved.rules['thin-controllers'].enforcement, 'block');
    assert.equal(resolved.rules['no-swallowed-errors'].enforcement, 'block');
    assert.equal(resolved.rules['api-versioned-routes'].enforcement, 'warn');
    assert.equal(resolved.rules['api-consistent-pagination'].enforcement, 'warn');
  });

  test('the same tier files produce the same result every time', () => {
    const a = JSON.stringify(resolvePolicy(policy, corporate));
    const b = JSON.stringify(resolvePolicy(policy, corporate));
    assert.equal(a, b);
  });

  test('a project may weaken an overridable rule', () => {
    const resolved = resolvePolicy(policy, corporate, {
      rules: { 'layered-imports': { enforcement: 'warn' } },
    });
    assert.equal(resolved.rules['layered-imports'].enforcement, 'warn');
    assert.equal(resolved.rejectedOverrides.length, 0);
  });

  test('a project may NOT weaken a locked rule', () => {
    const resolved = resolvePolicy(policy, corporate, {
      rules: { 'no-hardcoded-secrets': { enforcement: 'off' } },
    });
    assert.equal(resolved.rules['no-hardcoded-secrets'].enforcement, 'block');
    assert.equal(resolved.rejectedOverrides.length, 1);
    assert.match(resolved.rejectedOverrides[0].reason, /cannot weaken enforcement/);
  });

  test('a project may NOT weaken severity to dodge the gate', () => {
    const resolved = resolvePolicy(policy, corporate, {
      rules: { 'no-swallowed-errors': { severity: 'info' } },
    });
    assert.equal(resolved.rules['no-swallowed-errors'].severity, 'error');
    assert.match(resolved.rejectedOverrides[0].reason, /cannot weaken severity/);
  });

  test('overridability comes from the rule, not the tier', () => {
    // layered-imports is overridable in policy.yaml, so it stays overridable in
    // both tiers; no-swallowed-errors is not, in either.
    for (const tier of [corporate, startup]) {
      const resolved = resolvePolicy(policy, tier);
      assert.equal(resolved.rules['layered-imports'].overridable, true);
      assert.equal(resolved.rules['no-swallowed-errors'].overridable, false);
    }
  });

  test('strengthening is always allowed, even on locked rules', () => {
    const resolved = resolvePolicy(policy, startup, {
      rules: { 'thin-controllers': { enforcement: 'block' } },
    });
    assert.equal(resolved.rules['thin-controllers'].enforcement, 'block');
    assert.equal(resolved.rejectedOverrides.length, 0);
  });

  test('a project cannot grant itself overridability', () => {
    const resolved = resolvePolicy(policy, corporate, {
      rules: { 'no-hardcoded-secrets': { overridable: true, enforcement: 'off' } },
    });
    assert.equal(resolved.rules['no-hardcoded-secrets'].overridable, false);
    assert.equal(resolved.rules['no-hardcoded-secrets'].enforcement, 'block');
    assert.equal(resolved.rejectedOverrides.length, 2);
  });

  test('every change is traceable through provenance', () => {
    const resolved = resolvePolicy(policy, startup);
    const trace = resolved.rules['thin-controllers'].provenance;
    assert.equal(trace[0].layer, 'base');
    assert.ok(trace.some((p) => p.layer === 'tier-default' && p.to === 'warn'));
  });

  test('staleness windows differ by tier', () => {
    assert.equal(resolvePolicy(policy, corporate).staleness.maxReleasesBehind, 2);
    assert.equal(resolvePolicy(policy, startup).staleness.maxReleasesBehind, 6);
  });

  test('loadResolvedPolicy reads a synced governance directory', () => {
    const resolved = loadResolvedPolicy(REGISTRY, 'corporate');
    assert.equal(resolved.tier, 'corporate');
    assert.ok(Object.keys(resolved.rules).length >= 10);
  });
});

describe('gate', () => {
  const corporatePolicy = resolvePolicy(policy, corporate);
  const startupPolicy = resolvePolicy(policy, startup);

  const finding = (ruleId, severity = 'error') => ({
    ruleId,
    severity,
    file: 'src/orders/orders.controller.ts',
    line: 42,
    rationale: 'business logic in the controller',
  });

  test('no findings passes', () => {
    assert.equal(gateVerdict([], corporatePolicy).verdict, 'pass');
  });

  test('an error on a blocking rule blocks in the corporate tier', () => {
    const result = gateVerdict([finding('thin-controllers')], corporatePolicy);
    assert.equal(result.verdict, 'block');
    assert.equal(result.blocking.length, 1);
  });

  test('the same finding is advisory in the startup tier', () => {
    const result = gateVerdict([finding('thin-controllers')], startupPolicy);
    assert.equal(result.verdict, 'warn');
    assert.equal(result.blocking.length, 0);
    assert.equal(result.warnings.length, 1);
  });

  test('secrets block in every tier', () => {
    assert.equal(gateVerdict([finding('no-hardcoded-secrets')], startupPolicy).verdict, 'block');
    assert.equal(gateVerdict([finding('no-hardcoded-secrets')], corporatePolicy).verdict, 'block');
  });

  test('a warn-severity finding never blocks, even on a blocking rule', () => {
    const result = gateVerdict([finding('thin-controllers', 'warn')], corporatePolicy);
    assert.equal(result.verdict, 'warn');
  });

  test('an invented rule id cannot block and is surfaced separately', () => {
    const result = gateVerdict([finding('rule-the-agent-made-up')], corporatePolicy);
    assert.equal(result.verdict, 'warn');
    assert.equal(result.unknownRules.length, 1);
    assert.equal(result.blocking.length, 0);
  });
});
