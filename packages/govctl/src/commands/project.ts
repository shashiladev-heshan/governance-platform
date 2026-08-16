import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadResolvedPolicy } from '@shashiladev-heshan/policy-core';
import {
  BUNDLE_FILENAME,
  MANIFEST_FILENAME,
  diffAgainstManifest,
  manifestDigest,
  readManifestFile,
} from '../lib/manifest.js';
import {
  copyGoverned,
  fetchRegistry,
  listRegistryTags,
  readGovernedDirs,
  releasesBehind,
  resolveVersion,
} from '../lib/registry.js';
import {
  GOVERNANCE_DIR,
  GOVERNANCE_FILE,
  governanceDir,
  readConfig,
  requireProjectRoot,
  writeConfig,
  type GovernanceConfig,
} from '../lib/config.js';
import {
  IGNORED_PATHS,
  governanceHookSnippet,
  installIgnoreFile,
  installLefthook,
} from '../lib/lefthook.js';
import {
  CODEOWNERS_PATH,
  WORKFLOW_PATH,
  installCiFiles,
  readCiConfig,
  requiredCheckNames,
  type CiConfig,
} from '../lib/ci.js';
import {
  generateAssistantFiles,
  readAssistantsConfig,
  type AssistantsConfig,
} from '../lib/assistants.js';
import { color, log } from '../lib/log.js';
import { verifyProject, type ProjectVerifyResult } from '../verify.js';

export interface InitOptions {
  cwd: string;
  registry: string;
  tier: string;
  version?: string;
  force?: boolean;
  skipHooks?: boolean;
  skipCi?: boolean;
  skipAssistants?: boolean;
  json?: boolean;
}

export async function cmdInit(options: InitOptions): Promise<number> {
  const projectRoot = options.cwd;
  const configPath = join(projectRoot, GOVERNANCE_FILE);

  if (existsSync(configPath) && !options.force) {
    log.fail(`${GOVERNANCE_FILE} already exists. Use 'govctl sync' to update, or --force to re-init.`);
    return 2;
  }

  log.step(`resolving version from ${options.registry}`);
  const version = await resolveVersion(options.registry, options.version);
  log.step(`fetching ${version}`);
  const fetched = await fetchRegistry(options.registry, version);

  try {
    const tierPath = join(fetched.dir, 'tiers', `${options.tier}.yaml`);
    if (!existsSync(tierPath)) {
      log.fail(`unknown tier '${options.tier}'. Available: ${(await availableTiers(fetched.dir)).join(', ')}`);
      return 2;
    }

    const governedDirs = await readGovernedDirs(fetched.dir);
    const govDir = governanceDir(projectRoot);
    await copyGoverned(fetched.dir, govDir, governedDirs);
    const manifestSha256 = await copyManifest(fetched.dir, govDir);

    const config: GovernanceConfig = {
      schemaVersion: 1,
      registry: options.registry,
      tier: options.tier,
      version,
      manifestSha256,
      governedDirs,
    };
    await writeConfig(projectRoot, config);

    if (!options.skipHooks) {
      const hooks = await installLefthook(projectRoot, options.force ?? false);
      if (hooks === 'replaced-stub') {
        log.ok('replaced the empty lefthook.yml stub with the governance hooks');
      } else if (hooks === 'skipped') {
        log.blank();
        log.warn('lefthook.yml already exists and has jobs in it — leaving it alone.');
        log.warn('The governance hooks are NOT installed. Add this to it:');
        log.blank();
        log.info(
          governanceHookSnippet()
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n'),
        );
        log.blank();
      }
    }

    // Formatters must not touch governed content: `prettier --write .` would
    // rewrite every skill file and break the project's own integrity check.
    const ignored = await installIgnoreFile(projectRoot);
    if (ignored !== 'skipped') {
      log.ok(`${ignored} .prettierignore (${IGNORED_PATHS.join(", ")})`);
    }

    // CI wiring comes from the registry, so onboarding a project does not
    // involve hand-copying a workflow that then drifts.
    const ci = options.skipCi ? null : await readCiConfig(fetched.dir);
    if (ci) {
      const written = await installCiFiles(projectRoot, ci, options.force ?? false);
      if (written.workflow === 'written') log.ok(`wrote ${WORKFLOW_PATH}`);
      else log.warn(`${WORKFLOW_PATH} already exists — left alone (use --force to replace)`);
      if (written.codeowners === 'written') log.ok(`wrote ${CODEOWNERS_PATH}`);
    }

    if (!options.skipAssistants) {
      await writeAssistantWiring(projectRoot, govDir, await readAssistantsConfig(fetched.dir));
    }

    const result = await verifyProject({ projectRoot, remote: false, strict: false });
    printVerify(result, options.json ?? false);

    if (!options.json) {
      log.blank();
      log.ok(`initialized governance ${color.bold(version)} (tier: ${color.bold(options.tier)})`);
      printNextSteps(ci);
    }
    return result.ok ? 0 : 1;
  } finally {
    await fetched.cleanup();
  }
}

export interface SyncOptions {
  cwd: string;
  version?: string;
  json?: boolean;
}

export async function cmdSync(options: SyncOptions): Promise<number> {
  const projectRoot = requireProjectRoot(options.cwd);
  const config = await readConfig(projectRoot);

  const version = await resolveVersion(config.registry, options.version);
  if (version === config.version && !options.version) {
    log.ok(`already on ${version} (latest)`);
    return 0;
  }

  log.step(`syncing ${config.version} -> ${version}`);
  const fetched = await fetchRegistry(config.registry, version);
  try {
    const governedDirs = await readGovernedDirs(fetched.dir);
    const govDir = governanceDir(projectRoot);
    await copyGoverned(fetched.dir, govDir, governedDirs);
    const manifestSha256 = await copyManifest(fetched.dir, govDir);

    await writeConfig(projectRoot, { ...config, version, manifestSha256, governedDirs });
    await writeAssistantWiring(projectRoot, govDir, await readAssistantsConfig(fetched.dir));

    const result = await verifyProject({ projectRoot, remote: false, strict: false });
    printVerify(result, options.json ?? false);
    if (!options.json && result.ok) log.ok(`synced to ${color.bold(version)}`);
    return result.ok ? 0 : 1;
  } finally {
    await fetched.cleanup();
  }
}

export interface VerifyCommandOptions {
  cwd: string;
  remote?: boolean;
  strict?: boolean;
  json?: boolean;
  skipStaleness?: boolean;
}

export async function cmdVerify(options: VerifyCommandOptions): Promise<number> {
  const projectRoot = requireProjectRoot(options.cwd);
  const result = await verifyProject({
    projectRoot,
    remote: options.remote ?? false,
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    skipStaleness: options.skipStaleness ?? false,
  });
  printVerify(result, options.json ?? false);
  return result.ok ? 0 : 1;
}

export interface StatusOptions {
  cwd: string;
  json?: boolean;
  offline?: boolean;
}

export async function cmdStatus(options: StatusOptions): Promise<number> {
  const projectRoot = requireProjectRoot(options.cwd);
  const config = await readConfig(projectRoot);
  const govDir = governanceDir(projectRoot);
  const policy = loadResolvedPolicy(govDir, config.tier, config.overrides ?? {});

  let tags: string[] = [];
  let behind = -1;
  if (!options.offline) {
    try {
      tags = await listRegistryTags(config.registry);
      behind = releasesBehind(tags, config.version);
    } catch (err) {
      log.warn(`could not reach registry: ${(err as Error).message}`);
    }
  }

  const result = await verifyProject({ projectRoot, remote: false, strict: false, skipStaleness: true });

  const counts = { block: 0, warn: 0, off: 0 };
  for (const rule of Object.values(policy.rules)) counts[rule.enforcement]++;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          registry: config.registry,
          tier: config.tier,
          version: config.version,
          latest: tags[0] ?? null,
          releasesBehind: behind,
          maxReleasesBehind: policy.staleness.maxReleasesBehind,
          rules: counts,
          drift: result.drift,
          ok: result.ok,
        },
        null,
        2,
      ),
    );
    return result.ok ? 0 : 1;
  }

  log.info(color.bold('governance status'));
  log.info(`  registry   ${config.registry}`);
  log.info(`  tier       ${config.tier}`);
  log.info(`  version    ${config.version}${tags[0] ? color.dim(`  (latest ${tags[0]})`) : ''}`);
  if (behind >= 0) {
    const stale = behind > policy.staleness.maxReleasesBehind;
    const text = `${behind} release(s) behind, tier allows ${policy.staleness.maxReleasesBehind}`;
    log.info(`  staleness  ${stale ? color.red(text) : color.green(text)}`);
  }
  log.info(
    `  rules      ${counts.block} blocking · ${counts.warn} advisory · ${counts.off} off`,
  );
  log.info(`  integrity  ${result.ok ? color.green('clean') : color.red(`${driftCount(result)} problem(s)`)}`);
  if (policy.rejectedOverrides.length) {
    log.blank();
    log.warn('refused policy overrides:');
    for (const r of policy.rejectedOverrides) log.info(`    ${r.reason}`);
  }
  if (!result.ok) {
    log.blank();
    for (const err of result.errors) log.fail(err);
  }
  return result.ok ? 0 : 1;
}

export interface RestoreOptions {
  cwd: string;
  paths: string[];
  prune?: boolean;
  json?: boolean;
}

export async function cmdRestore(options: RestoreOptions): Promise<number> {
  const projectRoot = requireProjectRoot(options.cwd);
  const config = await readConfig(projectRoot);
  const govDir = governanceDir(projectRoot);

  // Drift is computed against the REGISTRY's manifest, never the local copy.
  // If someone edited a governed file and regenerated the local manifest to
  // match, a local diff would report "nothing wrong" — which is exactly the
  // state a developer most needs restore to repair.
  const fetched = await fetchRegistry(config.registry, config.version);
  try {
    const { manifest: canonical, bytes: canonicalBytes } = await readManifestFile(
      join(fetched.dir, MANIFEST_FILENAME),
    );
    const drift = await diffAgainstManifest(govDir, canonical);

    const targets =
      options.paths.length > 0
        ? options.paths.map(normalizeGovernedPath)
        : [...drift.modified, ...drift.missing].map((d) => d.path);

    // The manifest and signature are part of what restore repairs, so "clean"
    // also means the local manifest IS the registry's and governance.json is
    // bound to it. Content matching a forged manifest is not clean.
    const localManifestDigest = manifestDigest(
      await readFile(join(govDir, MANIFEST_FILENAME)).catch(() => Buffer.alloc(0)),
    );
    const manifestClean =
      localManifestDigest === manifestDigest(canonicalBytes) &&
      localManifestDigest === config.manifestSha256;

    if (targets.length === 0 && drift.untracked.length === 0 && manifestClean) {
      log.ok('nothing to restore — governed content already matches the registry');
      return 0;
    }

    for (const rel of targets) {
      const src = join(fetched.dir, rel);
      if (!existsSync(src)) {
        log.warn(`not in registry ${config.version}: ${rel} (removing local copy)`);
        await rm(join(govDir, rel), { force: true });
        continue;
      }
      const dest = join(govDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest);
      log.ok(`restored ${rel}`);
    }

    // The manifest and its signature are governed content too — and re-copying
    // them means governance.json's recorded digest has to be re-bound, otherwise
    // restore would leave the project failing the manifest-binding check.
    const manifestSha256 = await copyManifest(fetched.dir, govDir);
    if (manifestSha256 !== config.manifestSha256) {
      await writeConfig(projectRoot, { ...config, manifestSha256 });
      log.ok(`re-bound governance.json to the ${config.version} manifest`);
    }

    for (const entry of drift.untracked) {
      if (options.prune) {
        await rm(join(govDir, entry.path), { force: true });
        log.ok(`pruned untracked ${entry.path}`);
      } else {
        log.warn(`untracked file left in place: ${entry.path} (re-run with --prune to delete)`);
      }
    }
  } finally {
    await fetched.cleanup();
  }

  const after = await verifyProject({ projectRoot, remote: false, strict: false, skipStaleness: true });
  printVerify(after, options.json ?? false);
  return after.ok ? 0 : 1;
}

// --- helpers ---------------------------------------------------------------

/**
 * Project the governed skills into the formats Claude Code and Copilot read.
 * Neither tool scans .governance/, so without this the standards are in the repo
 * and invisible to the assistants writing most of the code.
 */
async function writeAssistantWiring(
  projectRoot: string,
  govDir: string,
  assistants: AssistantsConfig,
): Promise<void> {
  const written = await generateAssistantFiles(projectRoot, govDir, assistants);
  if (written.claudeSkills > 0) {
    log.ok(`wired ${written.claudeSkills} skill(s) into .claude/skills + CLAUDE.md`);
  }
  if (written.copilotInstructions > 0) {
    log.ok(`wired ${written.copilotInstructions} instruction file(s) into .github/instructions`);
  }
  for (const path of written.removed) {
    log.ok(`removed ${path} (retired upstream)`);
  }
  for (const path of written.preserved) {
    log.warn(`left ${path} alone — it was not written by govctl`);
  }
}

async function copyManifest(registryDir: string, govDir: string): Promise<string> {
  await mkdir(govDir, { recursive: true });
  const src = join(registryDir, MANIFEST_FILENAME);
  if (!existsSync(src)) {
    throw new Error(
      `registry release is missing ${MANIFEST_FILENAME} — the release pipeline did not run 'govctl manifest generate'`,
    );
  }
  await copyFile(src, join(govDir, MANIFEST_FILENAME));

  const bundleSrc = join(registryDir, BUNDLE_FILENAME);
  if (existsSync(bundleSrc)) {
    await copyFile(bundleSrc, join(govDir, BUNDLE_FILENAME));
  } else {
    await rm(join(govDir, BUNDLE_FILENAME), { force: true });
  }

  return manifestDigest(await readFile(join(govDir, MANIFEST_FILENAME)));
}

async function availableTiers(registryDir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    return (await readdir(join(registryDir, 'tiers')))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.replace(/\.yaml$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function normalizeGovernedPath(input: string): string {
  return input.replace(/^\.?\/?/, '').replace(new RegExp(`^${GOVERNANCE_DIR}/`), '');
}

function driftCount(result: ProjectVerifyResult): number {
  return result.errors.length;
}

export function printVerify(result: ProjectVerifyResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const sig = result.signature;
  const sigText = !sig.checked
    ? color.yellow(`unverified (${sig.reason ?? 'no signature'})`)
    : sig.ok
      ? color.green(`valid · key ${sig.keyId} · signer ${sig.signer}`)
      : color.red(`INVALID · ${sig.reason}`);

  log.info(`${color.bold('governance verify')} ${color.dim(`(${result.manifestSource} manifest)`)}`);
  log.info(`  version    ${result.version}   tier ${result.tier}`);
  log.info(`  signature  ${sigText}`);
  log.info(
    `  manifest   ${result.manifestBinding.ok ? color.green('bound to governance.json') : color.red('REPLACED')}`,
  );
  if (result.canonicalMatch) {
    log.info(
      `  canonical  ${result.canonicalMatch.ok ? color.green('matches registry') : color.red('DIFFERS from registry')}`,
    );
  }
  if (result.staleness) {
    log.info(
      `  freshness  ${result.staleness.ok ? color.green('within SLA') : color.red(`${result.staleness.behind} behind`)}`,
    );
  }
  log.info(
    `  content    ${result.drift.ok ? color.green(`${result.drift.verifiedCount} files verified`) : color.red(`${result.drift.modified.length} modified · ${result.drift.missing.length} missing · ${result.drift.untracked.length} untracked`)}`,
  );

  for (const warning of result.warnings) log.warn(warning);

  if (!result.ok) {
    log.blank();
    for (const err of result.errors) log.fail(err);
    log.blank();
    for (const hint of fixHints(result)) log.info(color.dim(`fix: ${hint}`));
  }
}

/**
 * Failures have different causes and different fixes. Telling someone with an
 * unconfigured trust root to run `govctl restore` sends them down a dead end, and
 * the first thing a new user hits is usually the trust root.
 */
function fixHints(result: ProjectVerifyResult): string[] {
  const hints: string[] = [];

  if (!result.signature.ok && result.signature.trustKeys === 0) {
    hints.push(
      `no trusted signing keys (trust root: ${result.signature.trustSource}). ` +
        'Set GOVCTL_TRUST_ROOT, or run: govctl trust add --key <public-key.json>',
    );
  } else if (!result.signature.ok && !result.signature.checked) {
    hints.push(
      "the release has no signature. Re-cut it with 'govctl sign' in the registry, or check you are on a released tag",
    );
  } else if (!result.signature.ok) {
    hints.push(
      'the manifest was signed by a key this machine does not trust, or was modified after signing. Do not bypass this — ask the platform team',
    );
  }

  if (!result.drift.ok || !result.manifestBinding.ok || result.canonicalMatch?.ok === false) {
    hints.push("govctl restore   (or 'govctl sync' to move to a newer release)");
  }

  if (result.staleness && !result.staleness.ok) {
    hints.push(`govctl sync   (this project is ${result.staleness.behind} releases behind)`);
  }

  return hints.length ? hints : ["govctl status   (then 'govctl restore' if content drifted)"];
}

function printNextSteps(ci: CiConfig | null): void {
  log.blank();
  log.info(color.bold('next steps'));
  log.info('  1. commit everything written above');
  log.info('  2. npx lefthook install   (or `npm i -D lefthook` — its postinstall does it)');

  if (ci) {
    log.info('  3. make the checks required in a branch ruleset:');
    for (const name of requiredCheckNames(ci)) log.info(`       ${name}`);
    log.info(color.dim('     (names are prefixed by the stub job id — that is expected)'));
  } else {
    log.info('  3. add a governance workflow and CODEOWNERS, then require the checks');
    log.warn('     the registry declares no "ci" block, so none were written for you');
  }
}
