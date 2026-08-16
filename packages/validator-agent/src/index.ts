#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { reviewDiff } from './review.js';
import { renderMarkdown, renderText } from './report.js';
import type { ReviewOutput } from './schema.js';

const version = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  return (JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string })
    .version;
};

const program = new Command();

program
  .name('governance-validator')
  .description('Semantic PR review against the governed pattern skills')
  .version(version());

program
  .command('review')
  .description('review a unified diff and emit a schema-validated verdict')
  .requiredOption('--diff <file>', 'unified diff file, or - for stdin')
  .option('--governance <dir>', 'verified governance directory', '.governance')
  .option('--config <file>', 'governance.json', 'governance.json')
  .option('--tier <tier>', 'override the tier from governance.json')
  .option('--json-out <file>', 'write the full verdict as JSON')
  .option('--markdown-out <file>', 'write the PR comment body')
  .option('--max-chunks <n>', 'agent-call budget for this PR', (v) => Number(v))
  .action(async (opts) => {
    try {
      const config = readConfig(opts.config);
      const output = await reviewDiff({
        diffText: readDiff(opts.diff),
        governanceDir: opts.governance,
        tier: opts.tier ?? config.tier,
        governanceVersion: config.version,
        overrides: config.overrides ?? {},
        ...(opts.maxChunks ? { maxChunks: opts.maxChunks } : {}),
      });

      if (opts.jsonOut) writeFileSync(opts.jsonOut, JSON.stringify(output, null, 2) + '\n');
      if (opts.markdownOut) writeFileSync(opts.markdownOut, renderMarkdown(output) + '\n');
      if (!opts.jsonOut && !opts.markdownOut) console.log(renderText(output));

      // `review` reports; it does not gate. Exit 0 unless something went wrong,
      // so the workflow can post the comment before the gate step runs.
      process.exitCode = 0;
    } catch (err) {
      console.error(`governance-validator: ${(err as Error).message}`);
      process.exitCode = 2;
    }
  });

program
  .command('gate')
  .description('apply the verdict — exit non-zero when the tier policy blocks')
  .requiredOption('--verdict <file>', 'verdict JSON produced by review')
  .action((opts) => {
    try {
      const output = JSON.parse(readFileSync(opts.verdict, 'utf8')) as ReviewOutput;

      // The gate reads a decision that policy-core already made. It re-states it
      // here rather than recomputing, so there is exactly one place where tier
      // policy turns findings into a merge decision.
      if (output.verdict === 'block') {
        console.error(
          `governance-semantic: BLOCKED by ${output.blocking.length} finding(s) under the ${output.tier} tier`,
        );
        for (const finding of output.blocking) {
          console.error(`  ${finding.ruleId} — ${finding.file}${finding.line ? `:${finding.line}` : ''}`);
        }
        process.exitCode = 1;
        return;
      }

      if (output.verdict === 'warn') {
        console.log(
          `governance-semantic: passed with ${output.warnings.length} advisory finding(s) under the ${output.tier} tier`,
        );
      } else {
        console.log('governance-semantic: clean');
      }
      process.exitCode = 0;
    } catch (err) {
      // A missing or unreadable verdict is a failure, not a pass. The check must
      // never go green because the agent step fell over.
      console.error(`governance-validator gate: ${(err as Error).message}`);
      process.exitCode = 2;
    }
  });

function readDiff(path: string): string {
  return path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
}

function readConfig(path: string): { tier: string; version: string; overrides?: unknown } {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { tier: string; version: string };
  } catch (err) {
    throw new Error(`could not read ${path}: ${(err as Error).message}`);
  }
}

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 2;
});
