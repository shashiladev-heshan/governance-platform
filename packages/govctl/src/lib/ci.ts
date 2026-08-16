import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const WORKFLOW_PATH = '.github/workflows/governance.yml';
export const CODEOWNERS_PATH = '.github/CODEOWNERS';

/**
 * CI wiring, declared by the registry rather than by each project.
 *
 * Copying a 130-line workflow into every repository means repositories drift
 * onto old versions of it and every change is a pull request against N repos.
 * Instead the registry names one reusable workflow, and `govctl init` writes a
 * stub that calls it — so improving the checks is a single edit, centrally.
 */
export const CiConfigSchema = z.object({
  /** owner/repo/.github/workflows/file.yml@ref */
  reusableWorkflow: z.string().min(1),
  /** Handles that must review changes to governance-critical paths. */
  codeOwners: z.array(z.string().min(1)).default([]),
  runLint: z.boolean().default(true),
  runSemantic: z.boolean().default(true),
});
export type CiConfig = z.infer<typeof CiConfigSchema>;

/** Read the `ci` block from the registry's registry.json, if it has one. */
export async function readCiConfig(registryDir: string): Promise<CiConfig | null> {
  const path = join(registryDir, 'registry.json');
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`invalid registry.json: ${(err as Error).message}`);
  }

  const ci = (raw as { ci?: unknown }).ci;
  if (ci === undefined) return null;

  const parsed = CiConfigSchema.safeParse(ci);
  if (!parsed.success) {
    throw new Error(
      `invalid "ci" block in registry.json: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export function renderWorkflowStub(ci: CiConfig): string {
  return `# Managed by govctl — do not edit.
#
# The checks themselves live in the governance platform repo, so improving them
# does not require a pull request against every governed project. To change what
# runs here, change the reusable workflow, not this file.
#
# Required status check names for the branch ruleset are prefixed with this job
# id, e.g. "governance / governance-integrity".
name: governance

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  governance:
    uses: ${ci.reusableWorkflow}
    secrets: inherit
    with:
      run-lint: ${ci.runLint}
      run-semantic: ${ci.runSemantic}
`;
}

export function renderCodeowners(ci: CiConfig): string {
  const owners = ci.codeOwners.join(' ');
  return `# Managed by govctl. Combined with a ruleset that requires code-owner review,
# this is what stops "delete the workflow" from being a valid bypass.
/.github/workflows/       ${owners}
/.github/CODEOWNERS       ${owners}
/governance.json          ${owners}
/.governance/             ${owners}
/lefthook.yml             ${owners}
`;
}

export interface CiInstallResult {
  workflow: 'written' | 'skipped';
  codeowners: 'written' | 'skipped';
}

/**
 * Write the workflow stub and CODEOWNERS. Existing files are never overwritten
 * without `force` — a project may have hand-tuned either one.
 */
export async function installCiFiles(
  projectRoot: string,
  ci: CiConfig,
  force = false,
): Promise<CiInstallResult> {
  const result: CiInstallResult = { workflow: 'skipped', codeowners: 'skipped' };

  const workflowPath = join(projectRoot, WORKFLOW_PATH);
  if (!existsSync(workflowPath) || force) {
    await mkdir(dirname(workflowPath), { recursive: true });
    await writeFile(workflowPath, renderWorkflowStub(ci), 'utf8');
    result.workflow = 'written';
  }

  if (ci.codeOwners.length > 0) {
    const ownersPath = join(projectRoot, CODEOWNERS_PATH);
    if (!existsSync(ownersPath) || force) {
      await mkdir(dirname(ownersPath), { recursive: true });
      await writeFile(ownersPath, renderCodeowners(ci), 'utf8');
      result.codeowners = 'written';
    }
  }

  return result;
}

/** The check names a branch ruleset must require, given the stub's job id. */
export function requiredCheckNames(ci: CiConfig): string[] {
  const names = ['governance / governance-integrity', 'governance / governance-patterns'];
  if (ci.runLint) names.splice(1, 0, 'governance / governance-lint');
  if (ci.runSemantic) names.push('governance / governance-semantic');
  return names;
}
