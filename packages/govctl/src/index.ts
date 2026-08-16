#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { cmdInit, cmdRestore, cmdStatus, cmdSync, cmdVerify } from './commands/project.js';
import {
  cmdKeygen,
  cmdManifestCheck,
  cmdManifestGenerate,
  cmdPolicyValidate,
  cmdSign,
  cmdTrustAdd,
  cmdTrustList,
} from './commands/registry.js';
import { log } from './lib/log.js';

const version = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  return (JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string })
    .version;
};

const program = new Command();

program
  .name('govctl')
  .description('Governance CLI — sync, verify and restore centrally managed governance content')
  .version(version());

program
  .command('init')
  .description('attach a project to the governance registry')
  .requiredOption('--registry <ref>', 'git URL or local path of the governance registry')
  .requiredOption('--tier <tier>', 'governance tier (e.g. corporate, startup)')
  // `--tag`, not `--version`: commander reserves --version for the CLI itself.
  .option('--tag <version>', 'pin a specific release tag (default: latest)')
  .option('--force', 'overwrite an existing governance.json')
  .option('--skip-hooks', 'do not install lefthook.yml')
  .option('--skip-ci', 'do not write the CI workflow or CODEOWNERS')
  .option('--json', 'machine-readable output')
  .action(
    run(
      (opts: {
        registry: string;
        tier: string;
        tag?: string;
        force?: boolean;
        skipHooks?: boolean;
        skipCi?: boolean;
        json?: boolean;
      }) =>
        cmdInit({
          cwd: process.cwd(),
          registry: opts.registry,
          tier: opts.tier,
          ...(opts.tag ? { version: opts.tag } : {}),
          ...(opts.force ? { force: true } : {}),
          ...(opts.skipHooks ? { skipHooks: true } : {}),
          ...(opts.skipCi ? { skipCi: true } : {}),
          ...(opts.json ? { json: true } : {}),
        }),
    ),
  );

program
  .command('sync')
  .description('update .governance to a registry release')
  .option('--tag <version>', 'target release tag (default: latest)')
  .option('--json', 'machine-readable output')
  .action(
    run((opts: { tag?: string; json?: boolean }) =>
      cmdSync({
        cwd: process.cwd(),
        ...(opts.tag ? { version: opts.tag } : {}),
        ...(opts.json ? { json: true } : {}),
      }),
    ),
  );

program
  .command('verify')
  .description('verify signature, manifest binding and content hashes')
  .option('--remote', 'fetch the canonical manifest from the registry (what CI runs)')
  .option('--strict', 'treat a missing signature or trust root as a failure')
  .option('--lenient', 'downgrade missing signature / trust root to warnings')
  .option('--skip-staleness', 'skip the release-freshness check')
  .option('--json', 'machine-readable output')
  .action(
    run((opts: { strict?: boolean; lenient?: boolean; [k: string]: unknown }) => {
      const { strict, lenient, ...rest } = opts;
      const resolved = strict ? true : lenient ? false : undefined;
      return cmdVerify({
        cwd: process.cwd(),
        ...rest,
        ...(resolved === undefined ? {} : { strict: resolved }),
      });
    }),
  );

program
  .command('status')
  .description('show version, staleness, resolved policy and drift')
  .option('--offline', 'do not contact the registry')
  .option('--json', 'machine-readable output')
  .action(run((opts) => cmdStatus({ cwd: process.cwd(), ...opts })));

program
  .command('restore')
  .description('re-download governed files from the pinned release')
  .argument('[paths...]', 'specific governed paths to restore (default: everything drifted)')
  .option('--prune', 'also delete untracked files under .governance')
  .option('--json', 'machine-readable output')
  .action(
    run((paths: string[], opts: Record<string, unknown>) =>
      cmdRestore({ cwd: process.cwd(), paths, ...opts }),
    ),
  );

const manifest = program.command('manifest').description('registry-side manifest commands');
manifest
  .command('generate')
  .description('hash all governed files and write manifest.lock.json')
  .option('--dir <dir>', 'registry root', process.cwd())
  .requiredOption('--tag <version>', 'release tag this manifest describes')
  .option('--json', 'machine-readable output')
  .action(
    run((opts: { dir: string; tag: string; json?: boolean }) =>
      cmdManifestGenerate({ dir: opts.dir, version: opts.tag, ...(opts.json ? { json: true } : {}) }),
    ),
  );
manifest
  .command('check')
  .description('fail if the committed manifest is out of date (registry PR check)')
  .option('--dir <dir>', 'registry root', process.cwd())
  .action(run((opts) => cmdManifestCheck({ ...(opts as { dir: string }), version: 'check' })));

const policy = program.command('policy').description('registry-side policy commands');
policy
  .command('validate')
  .description('schema-validate policy.yaml and resolve every tier')
  .option('--dir <dir>', 'registry root', process.cwd())
  .option('--json', 'machine-readable summary')
  .action(run((opts) => cmdPolicyValidate(opts as never)));

program
  .command('sign')
  .description('sign manifest.lock.json (registry release pipeline)')
  .option('--dir <dir>', 'registry root', process.cwd())
  .requiredOption('--key <file>', 'signing key file')
  .option('--signer <name>', 'signer identity recorded in the bundle', 'dev-ed25519')
  .option('--json', 'machine-readable output')
  .action(
    run((opts: { dir: string; key: string; signer?: string; json?: boolean }) =>
      cmdSign({ dir: opts.dir, keyFile: opts.key, ...(opts.signer ? { signer: opts.signer } : {}), ...(opts.json ? { json: true } : {}) }),
    ),
  );

program
  .command('keygen')
  .description('generate a LOCAL DEV ed25519 signing key (production uses cosign keyless)')
  .requiredOption('--key-id <id>', 'key identifier recorded in bundles')
  .requiredOption('--out <file>', 'where to write the keypair')
  .option('--trust', 'also add the public key to the local trust store')
  .action(run((opts) => cmdKeygen(opts as never)));

const trust = program.command('trust').description('manage the local trust store');
trust
  .command('add')
  .description('trust a signing key')
  .requiredOption('--key <file>', 'keypair or public-key file')
  .option('--path <file>', 'trust store path (default: ~/.govctl/trust.json)')
  .action(
    run((opts: { key: string; path?: string }) =>
      cmdTrustAdd({ keyFile: opts.key, ...(opts.path ? { path: opts.path } : {}) }),
    ),
  );
trust.command('list').description('list trusted keys').action(run(() => cmdTrustList()));

function run<A extends unknown[]>(fn: (...args: A) => number | Promise<number>) {
  return async (...args: A): Promise<void> => {
    try {
      process.exitCode = await fn(...args);
    } catch (err) {
      log.fail((err as Error).message);
      if (process.env.GOVCTL_DEBUG) console.error(err);
      process.exitCode = 2;
    }
  };
}

program.parseAsync(process.argv).catch((err: Error) => {
  log.fail(err.message);
  process.exitCode = 2;
});
