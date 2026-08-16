import { gateVerdict, loadResolvedPolicy, type Finding } from '@shashiladev-heshan/policy-core';
import { chunkFiles, parseDiff, renderChunk, type FileDiff } from './diff.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { loadRubric } from './rubric.js';
import { selectProvider, type ReviewProvider } from './provider.js';
import type { ReviewOutput } from './schema.js';
import { trace } from './trace.js';

export interface ReviewOptions {
  diffText: string;
  governanceDir: string;
  tier: string;
  governanceVersion: string;
  overrides?: unknown;
  provider?: ReviewProvider;
  /** Hard cap on agent calls per PR. Anything beyond is reported, never hidden. */
  maxChunks?: number;
  concurrency?: number;
}

export async function reviewDiff(options: ReviewOptions): Promise<ReviewOutput> {
  const policy = loadResolvedPolicy(options.governanceDir, options.tier, options.overrides ?? {});
  const rubric = loadRubric(options.governanceDir, policy);
  const provider = options.provider ?? selectProvider();

  const { files, skipped } = parseDiff(options.diffText);
  const allChunks = chunkFiles(files);

  const maxChunks = options.maxChunks ?? Number(process.env.GOVERNANCE_MAX_CHUNKS ?? 20);
  const chunks = allChunks.slice(0, maxChunks);
  const degradedReasons: string[] = [];

  if (allChunks.length > chunks.length) {
    const droppedFiles = allChunks
      .slice(maxChunks)
      .flat()
      .map((f) => f.path);
    degradedReasons.push(
      `diff exceeded the review budget: ${allChunks.length} chunks, reviewed ${chunks.length}. Not reviewed: ${droppedFiles.join(', ')}`,
    );
  }

  const systemPrompt = buildSystemPrompt(rubric, options.tier);
  const reviewedPaths = new Set(chunks.flat().map((f) => f.path));

  const rawFindings: Finding[] = [];
  const concurrency = options.concurrency ?? 3;

  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((chunk, offset) => {
        const label = chunkLabel(chunk, i + offset);
        return provider
          .review({ systemPrompt, userPrompt: buildUserPrompt(renderChunk(chunk)), label })
          .then((result) => {
            void trace({
              name: 'governance-review-chunk',
              label,
              tier: options.tier,
              governanceVersion: options.governanceVersion,
              provider: provider.name,
              findings: result.verdict.findings.length,
              ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
              ...(result.usage ?? {}),
            });
            return result;
          });
      }),
    );

    for (const result of results) {
      if (result.degradedReason) degradedReasons.push(result.degradedReason);
      rawFindings.push(...result.verdict.findings);
    }
  }

  // Guardrail: the agent may only speak about files it was shown. A finding on
  // anything else is dropped and surfaced as degradation, not acted on.
  const inScope: Finding[] = [];
  for (const finding of rawFindings) {
    if (reviewedPaths.has(finding.file)) inScope.push(finding);
    else degradedReasons.push(`discarded out-of-scope finding on ${finding.file} (${finding.ruleId})`);
  }

  const gate = gateVerdict(dedupe(inScope), policy);

  // Degradation can only make the verdict stricter, never laxer: if we could not
  // review everything, "pass" would be a claim we cannot support.
  const degraded = degradedReasons.length > 0;
  const verdict = degraded && gate.verdict === 'pass' ? 'warn' : gate.verdict;

  return {
    verdict,
    tier: options.tier,
    governanceVersion: options.governanceVersion,
    blocking: gate.blocking,
    warnings: gate.warnings,
    dropped: gate.dropped,
    unknownRules: gate.unknownRules,
    stats: {
      filesReviewed: reviewedPaths.size,
      filesSkipped: skipped.length,
      chunks: chunks.length,
      degraded,
      ...(degraded ? { degradedReason: degradedReasons.join(' | ') } : {}),
    },
    rubric: {
      skills: rubric.skills.map((s) => s.slug),
      activeRules: rubric.rules.map((r) => r.id),
    },
  };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.ruleId}::${finding.file}::${finding.line ?? '-'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function chunkLabel(chunk: FileDiff[], index: number): string {
  const first = chunk[0]?.path ?? 'unknown';
  return chunk.length === 1 ? first : `${first} +${chunk.length - 1} more (chunk ${index + 1})`;
}
