import type { Finding } from '@shashiladev-heshan/policy-core';
import type { ReviewOutput } from './schema.js';

const HEADINGS: Record<ReviewOutput['verdict'], string> = {
  pass: '✅ Governance review passed',
  warn: '⚠️ Governance review — advisory findings',
  block: '🚫 Governance review — blocking findings',
};

/** The PR comment. Written to teach, because a finding nobody understands is a finding nobody fixes. */
export function renderMarkdown(output: ReviewOutput): string {
  const lines: string[] = [];

  lines.push(`## ${HEADINGS[output.verdict]}`);
  lines.push('');
  lines.push(
    `Tier **${output.tier}** · governance **${output.governanceVersion}** · ` +
      `${output.stats.filesReviewed} file(s) reviewed, ${output.stats.filesSkipped} skipped`,
  );
  lines.push('');

  if (output.blocking.length) {
    lines.push(`### Blocking (${output.blocking.length})`);
    lines.push('');
    for (const finding of output.blocking) lines.push(...renderFinding(finding));
  }

  if (output.warnings.length) {
    lines.push(`### Advisory (${output.warnings.length})`);
    lines.push('');
    for (const finding of output.warnings) lines.push(...renderFinding(finding));
  }

  if (!output.blocking.length && !output.warnings.length) {
    lines.push('No findings against the governed pattern skills.');
    lines.push('');
  }

  if (output.unknownRules.length) {
    lines.push('### ⚠️ Findings citing unknown rules');
    lines.push('');
    lines.push(
      'These were reported against rule ids that are not in the resolved policy. They are never blocking, ' +
        'and the platform team should look at them — either the rubric drifted or the agent invented a rule.',
    );
    lines.push('');
    for (const finding of output.unknownRules) {
      lines.push(`- \`${finding.ruleId}\` on \`${finding.file}\` — ${finding.rationale}`);
    }
    lines.push('');
  }

  if (output.stats.degraded) {
    lines.push('### ⚠️ Review was degraded');
    lines.push('');
    lines.push(
      'Part of this diff was not reviewed, so a clean result cannot be claimed. ' +
        'The verdict has been raised to at least advisory.',
    );
    lines.push('');
    lines.push(`\`\`\`\n${output.stats.degradedReason ?? 'unknown'}\n\`\`\``);
    lines.push('');
  }

  if (output.dropped.length) {
    lines.push(
      `<sub>${output.dropped.length} finding(s) suppressed by the ${output.tier} tier policy.</sub>`,
    );
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `<sub>Rules applied: ${output.rubric.activeRules.join(', ')} · ` +
      `Skills: ${output.rubric.skills.join(', ')}. ` +
      'Wrong? Add the `governance-dispute` label — the platform team reviews disputes within one business day.</sub>',
  );

  return lines.join('\n');
}

function renderFinding(finding: Finding): string[] {
  const lines: string[] = [];
  const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;

  lines.push(`**\`${finding.ruleId}\`** · \`${where}\` · _${finding.severity}_`);
  lines.push('');
  lines.push(finding.rationale);
  lines.push('');
  if (finding.suggestedFix) {
    lines.push('```suggestion');
    lines.push(finding.suggestedFix);
    lines.push('```');
    lines.push('');
  }
  return lines;
}

/** Terminal rendering for the local twin (`/governance-review`, `govctl review`). */
export function renderText(output: ReviewOutput): string {
  const lines: string[] = [];
  lines.push(`governance review: ${output.verdict.toUpperCase()} (tier ${output.tier})`);
  for (const finding of [...output.blocking, ...output.warnings]) {
    const where = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    lines.push('');
    lines.push(`  [${finding.severity}] ${finding.ruleId} — ${where}`);
    lines.push(`    ${finding.rationale}`);
  }
  if (output.stats.degraded) {
    lines.push('');
    lines.push(`  ! degraded: ${output.stats.degradedReason}`);
  }
  return lines.join('\n');
}
