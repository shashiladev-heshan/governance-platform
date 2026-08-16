import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDiff, chunkFiles, renderChunk, shouldSkip } from '../dist/diff.js';
import { reviewDiff } from '../dist/review.js';
import { MockProvider } from '../dist/provider.js';
import { renderMarkdown } from '../dist/report.js';
import { loadRubric } from '../dist/rubric.js';
import { loadResolvedPolicy } from '@shashiladev-heshan/policy-core';

const REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'registry-template');

const DIFF = `diff --git a/src/orders/orders.controller.ts b/src/orders/orders.controller.ts
index 1111111..2222222 100644
--- a/src/orders/orders.controller.ts
+++ b/src/orders/orders.controller.ts
@@ -10,6 +10,14 @@ export class OrdersController {
   constructor(private readonly orders: OrderService) {}

+  @Post()
+  async create(@Body() body: any) {
+    const customer = await this.customers.findOne(body.customerId);
+    if (customer.creditHold) throw new ForbiddenException();
+    const total = body.lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
+    return this.repo.save({ ...body, total });
+  }
+
   @Get(':id')
   get(@Param('id') id: string) {
diff --git a/package-lock.json b/package-lock.json
index 3333333..4444444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,4 @@
+    "lockfileVersion": 3,
diff --git a/dist/bundle.js b/dist/bundle.js
index 5555555..6666666 100644
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1 +1,2 @@
+console.log('generated');
`;

describe('diff parsing', () => {
  test('picks up reviewable source files and skips the rest', () => {
    const { files, skipped } = parseDiff(DIFF);
    assert.deepEqual(
      files.map((f) => f.path),
      ['src/orders/orders.controller.ts'],
    );
    assert.ok(skipped.includes('package-lock.json'));
    assert.ok(skipped.includes('dist/bundle.js'));
  });

  test('generated, vendored and governed paths are never sent to the agent', () => {
    for (const path of [
      'node_modules/x/index.js',
      'dist/main.js',
      '.governance/skills/error-handling/SKILL.md',
      'src/api/generated/client.ts',
      'pnpm-lock.yaml',
      'assets/logo.png',
      'README.md',
    ]) {
      assert.equal(shouldSkip(path), true, `${path} should be skipped`);
    }
    assert.equal(shouldSkip('src/orders/orders.service.ts'), false);
  });

  test('rendered chunks carry new-file line numbers for citation', () => {
    const { files } = parseDiff(DIFF);
    const rendered = renderChunk(files);
    assert.match(rendered, /FILE: src\/orders\/orders\.controller\.ts/);
    assert.match(rendered, /\+\s+12 \| +@Post\(\)/, 'added lines are numbered in the new file');
    assert.match(rendered, /^ +20 \| +@Get/m, 'context lines are numbered but not marked');
  });

  test('chunking keeps small related files together', () => {
    const { files } = parseDiff(DIFF);
    assert.equal(chunkFiles(files).length, 1);
    assert.equal(chunkFiles(files, 10).length, 1, 'a single file is never split');
  });
});

describe('rubric', () => {
  test('only skills for active rules are loaded', () => {
    const startup = loadResolvedPolicy(REGISTRY, 'startup');
    const rubric = loadRubric(REGISTRY, startup);
    assert.ok(rubric.skills.some((s) => s.slug === 'error-handling'));
    assert.ok(rubric.skills.every((s) => s.body.length > 200), 'skill bodies are loaded');
    assert.ok(rubric.rules.every((r) => r.enforcement !== 'off'));
  });

  test('skill frontmatter maps to rule ids', () => {
    const corporate = loadResolvedPolicy(REGISTRY, 'corporate');
    const rubric = loadRubric(REGISTRY, corporate);
    const errorHandling = rubric.skills.find((s) => s.slug === 'error-handling');
    assert.deepEqual(errorHandling.ruleIds, [
      'no-swallowed-errors',
      'typed-domain-errors',
      'no-error-detail-leak',
    ]);
  });
});

describe('review pipeline', () => {
  const findings = [
    {
      ruleId: 'thin-controllers',
      severity: 'error',
      file: 'src/orders/orders.controller.ts',
      line: 13,
      rationale: 'Order total and credit-hold logic live in the controller.',
    },
    {
      ruleId: 'api-versioned-routes',
      severity: 'warn',
      file: 'src/orders/orders.controller.ts',
      line: 12,
      rationale: 'Route is not versioned.',
    },
  ];

  const review = (tier, canned) =>
    reviewDiff({
      diffText: DIFF,
      governanceDir: REGISTRY,
      tier,
      governanceVersion: 'v0.1.0',
      provider: new MockProvider(canned),
    });

  test('corporate blocks on an error-severity blocking rule', async () => {
    const output = await review('corporate', { findings });
    assert.equal(output.verdict, 'block');
    assert.equal(output.blocking.length, 1);
    assert.equal(output.blocking[0].ruleId, 'thin-controllers');
    assert.equal(output.warnings.length, 1);
  });

  test('the same findings are advisory on the startup tier', async () => {
    const output = await review('startup', { findings });
    assert.equal(output.verdict, 'warn');
    assert.equal(output.blocking.length, 0);
  });

  test('a clean diff passes', async () => {
    const output = await review('corporate', { findings: [] });
    assert.equal(output.verdict, 'pass');
    assert.equal(output.stats.degraded, false);
  });

  test('findings on files the agent was not shown are discarded', async () => {
    const output = await review('corporate', {
      findings: [
        {
          ruleId: 'no-hardcoded-secrets',
          severity: 'error',
          file: 'src/never/in/the/diff.ts',
          rationale: 'hallucinated file',
        },
      ],
    });
    assert.equal(output.verdict, 'warn', 'out-of-scope findings degrade, never block');
    assert.equal(output.blocking.length, 0);
    assert.match(output.stats.degradedReason, /discarded out-of-scope finding/);
  });

  test('an invented rule id cannot block', async () => {
    const output = await review('corporate', {
      findings: [
        {
          ruleId: 'no-controllers-on-tuesdays',
          severity: 'error',
          file: 'src/orders/orders.controller.ts',
          rationale: 'invented rule',
        },
      ],
    });
    assert.equal(output.verdict, 'warn');
    assert.equal(output.unknownRules.length, 1);
  });

  test('duplicate findings are collapsed', async () => {
    const output = await review('corporate', { findings: [findings[0], findings[0]] });
    assert.equal(output.blocking.length, 1);
  });

  test('a degraded review can never report pass', async () => {
    const output = await reviewDiff({
      diffText: DIFF,
      governanceDir: REGISTRY,
      tier: 'corporate',
      governanceVersion: 'v0.1.0',
      maxChunks: 0,
      provider: new MockProvider({ findings: [] }),
    });
    assert.equal(output.verdict, 'warn');
    assert.equal(output.stats.degraded, true);
    assert.match(output.stats.degradedReason, /exceeded the review budget/);
    assert.match(output.stats.degradedReason, /orders\.controller\.ts/, 'names what was skipped');
  });

  test('the PR comment teaches, cites the rule, and offers a dispute path', async () => {
    const markdown = renderMarkdown(await review('corporate', { findings }));
    assert.match(markdown, /Blocking \(1\)/);
    assert.match(markdown, /`thin-controllers`/);
    assert.match(markdown, /Order total and credit-hold logic/);
    assert.match(markdown, /governance-dispute/);
  });
});
