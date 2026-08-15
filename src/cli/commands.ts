// Path: src/cli/commands.ts
// Command handlers for `znvault trust ...`, registered by src/cli.ts.
//
// Wires @zincapp/znvault-deploy-core's target-agnostic machinery (multi-class
// executor, migration gate, config-store, ssh tunnel, host-checks,
// buildPluginUrl) together with trust-specific pieces: this file's own
// chunked-upload flow (src/cli/upload.ts, talking to T4's `POST
// /release/chunk` + `/activate` + `/rollback` + `/status` agent routes) and
// this file's Prisma migration runner (src/cli/migration-runner.ts, over a
// reused Vault dynamic-secrets lease). Structure mirrors
// znvault-plugin-archon's src/cli/commands.ts as closely as trust's
// differences allow — see the two call-outs below for where it deliberately
// diverges.
//
// CRITICAL: every deploy-core call that takes a `pluginNamespace` argument is
// passed 'trust' explicitly (never left to the 'payara' default) — this is
// what routes HTTP calls to /plugins/trust/* instead of /plugins/payara/*.
//
// Divergence #1 — no diff/hash deploy: trust ships a release DIRECTORY
// (releaseDir), not archon's hash-diffed build tree. The CLI tars it once
// (upload.ts's tarReleaseDir) and chunked-uploads the same tarball buffer to
// every host, skipping any host already at the target version.
//
// Divergence #2 — the `confirm` field T4's /activate and /rollback routes
// require MUST equal the target agent's own OS hostname (see
// deployment-journal.ts's hostname() on the agent side), and GET /status does
// not return it. Rather than touch T4's routes (out of scope for this task —
// see the plan's Task-5 ruling in progress.md), the deploy config carries a
// REQUIRED `hostnames: Record<hostIp, osHostname>` map that the operator
// declares up front; `config set`/`deploy run` both refuse to proceed if any
// configured host is missing an entry.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile as readFileAsync } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  type CLIPluginContext,
  type CLIPlugin,
  type DeployConfig,
  type DeployClass,
  type ConfigStoreLocation,
  type DeployToHostResult,
  type ValidationReport,
  type MigrationSkipReason,
  loadDeployConfigs,
  saveDeployConfigs,
  getConfig,
  validateDeployConfig,
  resolveClass,
  partitionSelectedClasses,
  executeMultiClassDeployment,
  printMultiClassDryRun,
  printMultiClassSummary,
  runMigrationPhase,
  openTunnel,
  type Tunnel,
  buildPluginUrl,
  agentGet,
  agentPost,
  setEndpointOverride,
  clearEndpointOverride,
  type RunClassResult,
  type ResolvedClass,
  executeStrategy,
  parseDeploymentStrategy,
  drainServer,
  readyServer,
  testHAProxyConnectivity,
  getUnmappedHosts,
  performHealthCheck,
  hasActiveServerMap,
  computeNoFailures,
  computeFullCoverage,
  resolvePostSkipReason,
  isScopedDeploy,
} from '@zincapp/znvault-deploy-core';
import { getErrorMessage } from '../utils/error.js';
import { registerIncidentCommands, type IncidentCommandDeps } from './incident/commands.js';
import { makeTrustRunPhase, type RunnerDeps } from './migration-runner.js';
import {
  uploadRelease as uploadReleaseFn,
  tarReleaseDir as tarReleaseDirFn,
  httpPostChunk,
  type ChunkPoster,
} from './upload.js';

/** Namespace trust registers its agent routes under: /plugins/trust/*. */
const PLUGIN_NAMESPACE = 'trust';

/** Default agent HTTP port (matches the agent's default plugin bind port). */
const DEFAULT_PORT = 9100;

/**
 * Trust's deploy config — deploy-core's generic `DeployConfig` plus the
 * fields trust needs that deploy-core has no concept of. `warPath` is never
 * authored directly (see `withWarPathMarker`) — `releaseDir` is trust's
 * artifact-root equivalent.
 */
export interface TrustDeployConfig extends DeployConfig {
  /** Local checkout of the trust monorepo — `<trustRepoPath>/apps/api` holds
   *  the Prisma schema the migration runner points `npx prisma migrate
   *  deploy` at. */
  trustRepoPath: string;
  /** Local directory holding the built release to tar + chunked-upload. May
   *  contain the literal placeholder `<version>`, resolved against the
   *  deploy's target version — see `resolveReleaseVersion`. */
  releaseDir: string;
  /** REQUIRED: every host across every class must have an entry. The value
   *  is that host's own OS hostname — exactly what `POST /activate`'s and
   *  `POST /rollback`'s `confirm` field must equal (T4's lifecycle routes
   *  reject any other value with 400). See this file's header comment
   *  (Divergence #2) for why this lives in the config instead of a T4
   *  route change. */
  hostnames: Record<string, string>;
}

/** Where trust's saved deploy configs live on disk: `~/.znvault/trust/configs.json`. */
export function trustConfigStoreLocation(): ConfigStoreLocation {
  const configDir = join(homedir(), '.znvault', 'trust');
  return { configDir, configFile: join(configDir, 'configs.json') };
}

function trustPluginUrl(host: string, port: number): string {
  return buildPluginUrl(host, port, false, PLUGIN_NAMESPACE);
}

/**
 * deploy-core's `validateDeployConfig`/`resolveClass` need a resolvable
 * `warPath` per class — it's their only "does a local artifact root exist"
 * signal. Trust has no WAR; `releaseDir` doubles as that marker, the same way
 * archon's own diff-based (non-WAR) deploy sets `warPath` to its build root.
 * Purely a transient view built at each call site — never persisted.
 */
function withWarPathMarker(config: TrustDeployConfig): DeployConfig {
  return { ...config, warPath: config.warPath ?? config.releaseDir };
}

function collectAllHosts(config: TrustDeployConfig): string[] {
  const fromClasses = (config.classes ?? []).flatMap((c) => c.hosts);
  const fromFlat = config.hosts ?? [];
  return Array.from(new Set([...fromClasses, ...fromFlat]));
}

/**
 * Resolve a config's classes, falling back to a synthetic single 'api' class
 * wrapping the flat `hosts` field when no `classes` array is authored — same
 * fallback archon's commands.ts uses. The task brief's example config always
 * authors `classes` explicitly (workers-first), but a flat single-class
 * config is still a valid `DeployConfig` shape and must not silently deploy
 * to zero hosts.
 */
function resolveConfigClasses(config: TrustDeployConfig): DeployClass[] {
  return Array.isArray(config.classes) && config.classes.length > 0
    ? config.classes
    : [{ name: 'api', hosts: config.hosts ?? [] }];
}

/**
 * Trust-specific validation layered on top of deploy-core's generic
 * `validateDeployConfig`: requires `trustRepoPath`/`releaseDir`, and requires
 * a `hostnames` entry for EVERY host in EVERY class (deploy-core's own
 * validator has no concept of this field — see `TrustDeployConfig`'s doc
 * comment). Also WARNS (does not error — this is an authoring convention,
 * not a hard invariant deploy-core enforces) when a class named 'workers' is
 * listed after a serving (active-serverMap) class: the design spec mandates
 * workers-first ordering because `executeMultiClassDeployment` runs classes
 * strictly in config array order.
 */
export function validateTrustConfig(config: TrustDeployConfig): ValidationReport {
  const base = validateDeployConfig(withWarPathMarker(config));
  const errors = [...base.errors];
  const warnings = [...base.warnings];

  if (!config.trustRepoPath || config.trustRepoPath.trim() === '') {
    errors.push(`config '${config.name}' is missing trustRepoPath.`);
  }
  if (!config.releaseDir || config.releaseDir.trim() === '') {
    errors.push(`config '${config.name}' is missing releaseDir.`);
  }

  const hostnames = config.hostnames ?? {};
  for (const host of collectAllHosts(config)) {
    if (!hostnames[host] || hostnames[host]!.trim() === '') {
      errors.push(
        `config '${config.name}' is missing hostnames['${host}'] — required for the activate/rollback ` +
        `--confirm guard (must equal that host's own OS hostname).`,
      );
    }
  }

  const classes = config.classes ?? [];
  const baseForResolve = withWarPathMarker(config);
  const firstServingIdx = classes.findIndex((c) => hasActiveServerMap(resolveClass(baseForResolve, c).haproxy));
  const workersIdx = classes.findIndex((c) => c.name === 'workers');
  if (firstServingIdx !== -1 && workersIdx !== -1 && workersIdx > firstServingIdx) {
    warnings.push(
      `config '${config.name}': class 'workers' is listed after a serving class — the design spec mandates ` +
      `workers deploy first (executeMultiClassDeployment runs classes in array order).`,
    );
  }

  return { errors, warnings, info: base.info };
}

/**
 * Resolve which release directory + version to deploy.
 *  - `config.releaseDir` may contain a literal `<version>` placeholder — if
 *    so, `--version` MUST be given explicitly (there is no directory to read
 *    a manifest from before the version is known).
 *  - Without a placeholder, `--version` is optional: when omitted, the
 *    version is read from `<releaseDir>/manifest.json`'s `version` field
 *    (the same manifest the agent checks for post-extraction — see
 *    release-store.ts's `commitUpload`).
 */
export async function resolveReleaseVersion(
  config: TrustDeployConfig,
  explicitVersion: string | undefined,
  deps?: { readFile?: (path: string) => Promise<string> },
): Promise<{ releaseDir: string; version: string }> {
  const hasPlaceholder = config.releaseDir.includes('<version>');

  if (hasPlaceholder) {
    if (!explicitVersion) {
      throw new Error(`releaseDir '${config.releaseDir}' contains a <version> placeholder — pass --version explicitly.`);
    }
    return { releaseDir: config.releaseDir.replace('<version>', explicitVersion), version: explicitVersion };
  }

  if (explicitVersion) {
    return { releaseDir: config.releaseDir, version: explicitVersion };
  }

  const readFileFn = deps?.readFile ?? ((p: string) => readFileAsync(p, 'utf-8'));
  const manifestPath = join(config.releaseDir, 'manifest.json');
  let raw: string;
  try {
    raw = await readFileFn(manifestPath);
  } catch (err) {
    throw new Error(`could not read ${manifestPath} to determine the release version (pass --version explicitly): ${getErrorMessage(err)}`);
  }
  let manifest: { version?: string };
  try {
    manifest = JSON.parse(raw) as { version?: string };
  } catch (err) {
    throw new Error(`invalid JSON in ${manifestPath}: ${getErrorMessage(err)}`);
  }
  if (!manifest.version) {
    throw new Error(`${manifestPath} has no 'version' field.`);
  }
  return { releaseDir: config.releaseDir, version: manifest.version };
}

/**
 * Injectable deps for `deploy run` — thin wrappers around the real
 * migration-runner / upload primitives so tests can supply fakes without
 * touching a real Vault lease, npx/prisma child process, tar, or network.
 */
export interface DeployCommandDeps {
  runPhaseDeps?: Partial<RunnerDeps>;
  uploadRelease?: typeof uploadReleaseFn;
  tarReleaseDir?: typeof tarReleaseDirFn;
  chunkPoster?: ChunkPoster;
  readManifest?: (path: string) => Promise<string>;
  /** Poll delay for worker activation — overridden to a no-op in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run trust's migration-gate wrapper — thin adapter over deploy-core's
 * runMigrationPhase binding `runPhase` to this file's makeTrustRunPhase.
 * Labels are trust-flavored ('release' artifact, 'trust deploy run ...
 * --post-only' recovery hint) so skip/gate messages read correctly instead
 * of inheriting payara's WAR/payara wording.
 */
async function runTrustMigrationPhase(
  config: TrustDeployConfig,
  phase: 'pre-deploy' | 'post-deploy',
  configName: string,
  ctx: CLIPluginContext,
  opts: { dryRun?: boolean; run?: boolean; skipReason?: MigrationSkipReason },
  deps?: DeployCommandDeps,
): Promise<void> {
  const migration = phase === 'pre-deploy' ? config.migration : config.postMigration;
  await runMigrationPhase(
    migration,
    phase,
    configName,
    ctx,
    async (m, p, c) => {
      // deploy-core's CLIPluginContext structurally satisfies migration-runner's
      // narrower local CLIPluginContext (client.post + optional output.info/warn),
      // so no cast is needed — c is passed through as-is.
      const runPhase = makeTrustRunPhase(c, config.trustRepoPath, deps?.runPhaseDeps);
      await runPhase(m, p, c);
    },
    (m, p) => `[deploy] [dry-run] would run ${p} schema migrations (role '${m.roleId}')`,
    {
      ...opts,
      labels: { artifact: 'release', postOnlyRecoveryHint: `trust deploy run ${configName} --post-only` },
    },
  );
}

/**
 * Poll `GET /status` up to `attempts` times (default 10, `delayMs` apart —
 * default 3000ms) until the agent reports `active: true` with the target
 * version current, or give up. Used only for worker-class hosts (serving
 * hosts are gated by `performHealthCheck`'s own HTTP health-check instead).
 */
async function pollWorkerActive(
  pluginUrl: string,
  version: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 10;
  const delayMs = opts.delayMs ?? 3000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    try {
      const status = await agentGet<{ active: boolean; currentVersion: string | null }>(`${pluginUrl}/status`);
      if (status.active && status.currentVersion === version) return true;
    } catch {
      // transient — keep polling
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/** Collector for repeatable --class options. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value.trim()]);
}

/**
 * Render a failed deploy-core HAProxy operation (`drainServer`/`readyServer`)
 * into a one-line summary. These calls never reject — `sshExec` always
 * resolves — so a failure surfaces as `{success:false, results:[...]}`,
 * never a thrown error; this turns that per-host detail into the same kind
 * of message a `catch` block would have produced.
 */
function summarizeHaproxyResult(result: { results: Array<{ host: string; success: boolean; error?: string }> }): string {
  const failedHosts = result.results.filter((r) => !r.success).map((r) => `${r.host}: ${r.error ?? 'unknown error'}`);
  return failedHosts.length > 0 ? failedHosts.join('; ') : 'unknown error';
}

/**
 * Register `znvault trust config ...` — CRUD over saved TrustDeployConfigs at
 * ~/.znvault/trust/configs.json. Mirrors archon's config command surface,
 * trimmed to list/show/set (trust configs are authored as a whole JSON
 * document — see the task brief's example — rather than built up field by
 * field via `create`/`set-migration` the way archon's CLI does).
 */
function registerConfigCommands(configCmd: Command, ctx: CLIPluginContext): void {
  const loc = trustConfigStoreLocation();

  configCmd
    .command('list')
    .description('List all Trust deployment configurations')
    .action(async () => {
      const configs = await loadDeployConfigs(loc);
      const names = Object.keys(configs);
      if (names.length === 0) {
        ctx.output.info('No Trust deployment configurations found.');
        ctx.output.info('Create one with: znvault trust config set <name> --file <path-to-json>');
        return;
      }
      ctx.output.table(
        ['Name', 'Classes', 'Release Dir'],
        names.map((n) => {
          const c = configs[n] as TrustDeployConfig;
          return [c.name, (c.classes ?? []).map((cl) => cl.name).join(', ') || '(none)', c.releaseDir ?? '(not set)'];
        }),
      );
    });

  configCmd
    .command('show <name>')
    .description('Show a Trust deployment configuration')
    .action(async (name: string) => {
      const config = (await getConfig(loc, name)) as TrustDeployConfig | undefined;
      if (!config) {
        ctx.output.error(`Config '${name}' not found`);
        process.exit(1);
      }
      ctx.output.keyValue({
        name: config.name,
        trustRepoPath: config.trustRepoPath ?? '(not set)',
        releaseDir: config.releaseDir ?? '(not set)',
        port: config.port ?? DEFAULT_PORT,
        tunnel: config.tunnel ? 'yes (SSH-CA)' : 'no (direct)',
        classes: (config.classes ?? []).map((c) => c.name).join(', ') || '(none)',
        hostnames: Object.entries(config.hostnames ?? {}).map(([h, n]) => `${h}=${n}`).join(', ') || '(none)',
        migration: config.migration ? `role ${config.migration.roleId}` : '(not configured)',
      });
    });

  configCmd
    .command('set <name>')
    .description('Create or replace a Trust deployment configuration from a JSON file')
    .requiredOption('--file <path>', 'Path to a JSON file holding the deploy config')
    .action(async (name: string, options: { file: string }) => {
      let raw: string;
      try {
        raw = await readFileAsync(options.file, 'utf-8');
      } catch (err) {
        ctx.output.error(`Could not read ${options.file}: ${getErrorMessage(err)}`);
        process.exit(1);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        ctx.output.error(`Invalid JSON in ${options.file}: ${getErrorMessage(err)}`);
        process.exit(1);
      }
      const config: TrustDeployConfig = { ...(parsed as TrustDeployConfig), name };
      const report = validateTrustConfig(config);
      for (const i of report.info) ctx.output.info(i);
      for (const w of report.warnings) ctx.output.warn(w);
      if (report.errors.length > 0) {
        for (const e of report.errors) ctx.output.error(e);
        ctx.output.error(`Config '${name}' has ${report.errors.length} error(s) — not saved.`);
        process.exit(1);
      }
      const configs = await loadDeployConfigs(loc);
      configs[name] = config;
      await saveDeployConfigs(loc, configs);
      ctx.output.success(`Saved Trust deployment config: ${name}${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ''}`);
    });
}

/**
 * Register `znvault trust deploy ...` — run <configName> tars `releaseDir`
 * once, then chunked-uploads + activates it on every host in a saved config,
 * class by class (workers-first per the design spec — see the example config
 * in the task brief / README), with HAProxy drain/ready around serving-class
 * activations and a non-blocking active-poll for worker-class ones.
 */
function registerDeployCommands(deployCmd: Command, ctx: CLIPluginContext, deps?: DeployCommandDeps): void {
  const loc = trustConfigStoreLocation();

  deployCmd
    .command('run <configName>')
    .description('Deploy a Trust portal release to all hosts in a saved configuration')
    .option('--dry-run', 'Show what would be deployed without deploying')
    .option('--class <name>', 'Deploy only this node class (repeatable)', collect, [] as string[])
    .option('--skip-migrations', 'Deploy without running any schema migrations')
    .option('--pre-only', 'Run only the pre-deploy migration phase, then stop (no rollout)')
    .option('--post-only', 'Run only the post-deploy migration phase, then stop — recovery')
    .option('--skip-drain', 'Deploy without draining/readying hosts on HAProxy (serving classes only)')
    .option('--version <version>', 'Release version to deploy (default: read from <releaseDir>/manifest.json)')
    .action(async (configName: string, options: {
      dryRun?: boolean;
      class: string[];
      skipMigrations?: boolean;
      preOnly?: boolean;
      postOnly?: boolean;
      skipDrain?: boolean;
      version?: string;
    }) => {
      const config = (await getConfig(loc, configName)) as TrustDeployConfig | undefined;
      if (!config) {
        ctx.output.error(`Deployment config '${configName}' not found`);
        ctx.output.info('Use "znvault trust config list" to see available configs');
        process.exit(1);
      }

      const report = validateTrustConfig(config);
      for (const w of report.warnings) ctx.output.warn(w);
      if (report.errors.length > 0) {
        for (const e of report.errors) ctx.output.error(e);
        process.exit(1);
      }

      // Trust always requires a pre-deploy migration to be CONFIGURED unless
      // the operator explicitly opts out — unlike archon/payara, which treat
      // an absent `migration` as a silent no-op. Trust's schema changes are
      // Prisma-managed and expected on every deploy, so a config that forgot
      // to set migration.roleId is far more likely a mistake than intent.
      if (!options.skipMigrations && !options.preOnly && !options.postOnly && !config.migration) {
        ctx.output.error(
          `Deployment config '${configName}' has no pre-deploy migration configured (migration.roleId is ` +
          `required). Pass --skip-migrations to deploy without running schema migrations.`,
        );
        process.exit(1);
      }

      const openTunnels: Tunnel[] = [];

      try {
        // ── no-rollout shape: --pre-only / --post-only ──
        if (options.preOnly || options.postOnly) {
          if (options.preOnly && !config.migration) {
            ctx.output.error(`--pre-only requires a pre-deploy migration config; none set on '${configName}'.`);
            process.exit(1);
          }
          if (options.postOnly && !config.postMigration) {
            ctx.output.error(`--post-only requires a post-deploy migration config; none set on '${configName}'.`);
            process.exit(1);
          }
          await runTrustMigrationPhase(config, 'pre-deploy', configName, ctx, { dryRun: options.dryRun, run: !!options.preOnly }, deps);
          await runTrustMigrationPhase(config, 'post-deploy', configName, ctx, { dryRun: options.dryRun, run: !!options.postOnly }, deps);
          ctx.output.success(`[deploy] migrations complete (${options.preOnly ? 'pre' : 'post'}); no rollout.`);
          return;
        }

        // ── pre-deploy migration phase (before any host is touched) ──
        await runTrustMigrationPhase(config, 'pre-deploy', configName, ctx, { dryRun: options.dryRun, run: !options.skipMigrations }, deps);

        const classes: DeployClass[] = resolveConfigClasses(config);
        const { selected } = partitionSelectedClasses(classes, options.class.length > 0 ? options.class : undefined);
        const baseForResolve = withWarPathMarker(config);
        const resolved: ResolvedClass[] = selected.map((c) => resolveClass(baseForResolve, c));

        if (options.dryRun) {
          printMultiClassDryRun(resolved, resolved.map((r) => r.strategy ?? 'sequential'), ctx.isPlainMode());
          await runTrustMigrationPhase(config, 'post-deploy', configName, ctx, { dryRun: true, run: !options.skipMigrations }, deps);
          return;
        }

        // ── resolve version + tar the release ONCE, reused for every host ──
        const { releaseDir, version } = await resolveReleaseVersion(config, options.version, { readFile: deps?.readManifest });
        const tar = deps?.tarReleaseDir ?? tarReleaseDirFn;
        const tarballBuffer = await tar(releaseDir);
        const poster = deps?.chunkPoster ?? httpPostChunk;
        const doUpload = deps?.uploadRelease ?? uploadReleaseFn;

        // ── preflight: HAProxy connectivity + coverage, once, before any class rolls ──
        if (!options.skipDrain) {
          const servingClasses = resolved.filter((rc) => hasActiveServerMap(rc.haproxy));
          for (const rc of servingClasses) {
            try {
              const connResult = await testHAProxyConnectivity(rc.haproxy!);
              if (!connResult.success) {
                const failedHosts = connResult.results.filter((r) => !r.success).map((r) => `${r.host}: ${r.error}`);
                ctx.output.warn(`  [${rc.name}] HAProxy connectivity check failed: ${failedHosts.join('; ')}`);
              }
            } catch (err) {
              ctx.output.warn(`  [${rc.name}] HAProxy connectivity check failed: ${getErrorMessage(err)}`);
            }
            const unmapped = getUnmappedHosts(rc.haproxy!, rc.hosts);
            if (unmapped.length > 0) {
              ctx.output.warn(`  [${rc.name}] host(s) not mapped in haproxy.serverMap (will deploy without drain): ${unmapped.join(', ')}`);
            }
          }
        }

        const runClass = async (rc: ResolvedClass): Promise<RunClassResult> => {
          const port = rc.port ?? DEFAULT_PORT;
          const classTunnels: Tunnel[] = [];
          try {
            if (config.tunnel) {
              for (const host of rc.hosts) {
                try {
                  const t = await openTunnel(host, { user: config.ssh?.user, remotePort: port, readinessTimeoutMs: config.ssh?.readinessTimeoutMs });
                  setEndpointOverride(host, '127.0.0.1', t.localPort);
                  openTunnels.push(t);
                  classTunnels.push(t);
                } catch (err) {
                  ctx.output.warn(`  [${rc.name}] ${host}: tunnel failed (${getErrorMessage(err)})`);
                }
              }
            }

            // Pre-drain phase for exactly one host: check current version and
            // upload the release — entirely OUTSIDE any drain window. This is
            // deliberate (see the review finding this was fixed against): a
            // host already at the target version must never be drained +
            // re-readied for nothing (the skip-check exists precisely to
            // avoid touching HAProxy), and the — potentially large — tarball
            // upload must not extend the out-of-rotation window. Shared by
            // both the serving and worker lifecycles below; only the serving
            // one wraps what comes AFTER this in a drain/ready window.
            const checkAndUpload = async (host: string): Promise<{ success: boolean; skipped: boolean; error?: string }> => {
              const pluginUrl = trustPluginUrl(host, port);
              try {
                const status = await agentGet<{ currentVersion: string | null }>(`${pluginUrl}/status`);
                if (status.currentVersion === version) {
                  ctx.output.info(`  [${rc.name}] ${host}: already at ${version}, skipping`);
                  return { success: true, skipped: true };
                }
                await doUpload(poster, pluginUrl, version, tarballBuffer);
                return { success: true, skipped: false };
              } catch (err) {
                const message = getErrorMessage(err);
                ctx.output.error(`  [${rc.name}] ${host}: ${message}`);
                return { success: false, skipped: false, error: message };
              }
            };

            // Activate an already-uploaded host: POST /activate with this
            // host's declared confirm hostname (TrustDeployConfig.hostnames).
            // Called AFTER drainServer for a serving host, or directly after
            // checkAndUpload for a worker (no drain window there at all).
            const activateHost = async (host: string): Promise<{ success: boolean; error?: string }> => {
              const pluginUrl = trustPluginUrl(host, port);
              try {
                const confirm = config.hostnames[host];
                if (!confirm) {
                  throw new Error(`no hostnames['${host}'] entry in config '${configName}' — cannot confirm activation`);
                }
                await agentPost(`${pluginUrl}/activate`, { version, confirm });
                ctx.output.success(`  [${rc.name}] ${host}: activated ${version}`);
                return { success: true };
              } catch (err) {
                const message = getErrorMessage(err);
                ctx.output.error(`  [${rc.name}] ${host}: ${message}`);
                return { success: false, error: message };
              }
            };

            // NOTE: isServing is driven ONLY by the class's own haproxy config —
            // --skip-drain must NOT reroute an api (serving) class into the
            // worker branch below: worker failures land in workerFailed, which
            // classGateFailed (deploy-core) deliberately excludes, so a failed
            // --skip-drain activate would otherwise exit 0. --skip-drain instead
            // suppresses only the drainServer/readyServer calls INSIDE the
            // serving lifecycle — see the two `if (!options.skipDrain)` guards
            // below — leaving activate + health-gate + blocking/abort accounting
            // untouched.
            const isServing = hasActiveServerMap(rc.haproxy);
            const failed = 0;
            let healthCheckFailed = 0;
            const results = new Map<string, DeployToHostResult>();

            if (isServing) {
              // ── serving class: (status-check + upload) OUTSIDE drain → [drain] → activate → health-gate → [ready] (finally re-readies on failure) ──
              //
              // drainServer/readyServer NEVER throw — deploy-core's sshExec
              // always resolves, so a failed SSH/socat call comes back as
              // `{success:false, results:[...]}`, not a rejection. Every call
              // site below MUST check `.success` explicitly; a bare `await` was
              // the fail-open bug this replaces (a drain that silently failed
              // was previously treated as if it had succeeded, and a host could
              // be reactivated on HAProxy despite never actually leaving
              // rotation).
              const lifecycle = async (host: string): Promise<DeployToHostResult> => {
                const preResult = await checkAndUpload(host);
                if (!preResult.success) return { success: false, error: preResult.error };
                if (preResult.skipped) return { success: true };

                let drained = false;
                // Captured so the `finally` re-ready path can APPEND to (not
                // clobber) whatever the try block already decided — e.g. a
                // health-check failure's message must survive even if the
                // recovery re-ready afterward also fails.
                let outcome: DeployToHostResult = { success: false, error: 'lifecycle did not complete' };
                try {
                  if (!options.skipDrain) {
                    const drainResult = await drainServer(rc.haproxy!, host);
                    if (!drainResult.success) {
                      const message = `drain failed: ${summarizeHaproxyResult(drainResult)}`;
                      ctx.output.error(`  [${rc.name}] ${host}: ${message}`);
                      outcome = { success: false, error: message };
                      return outcome;
                    }
                    drained = true;
                  }

                  const activateResult = await activateHost(host);
                  if (!activateResult.success) {
                    outcome = { success: false, error: activateResult.error };
                    return outcome;
                  }

                  if (rc.healthCheck) {
                    const healthResult = await performHealthCheck(host, rc.healthCheck, (attempt, maxAttempts, status, error) => {
                      if (error) {
                        ctx.output.info(`  [${rc.name}] ${host}: health check ${attempt}/${maxAttempts}: ${error}`);
                      } else if (status !== undefined) {
                        ctx.output.info(`  [${rc.name}] ${host}: health check ${attempt}/${maxAttempts}: HTTP ${status}`);
                      }
                    });
                    if (!healthResult.success) {
                      const message = `health check failed: ${healthResult.error ?? `HTTP ${healthResult.status}`}`;
                      ctx.output.error(`  [${rc.name}] ${host}: ${message}`);
                      healthCheckFailed++;
                      outcome = { success: false, error: message };
                      return outcome;
                    }
                  }

                  if (!options.skipDrain) {
                    const readyResult = await readyServer(rc.haproxy!, host);
                    if (!readyResult.success) {
                      const message = `ready failed: ${summarizeHaproxyResult(readyResult)} — host ${host} may be left drained`;
                      ctx.output.error(`  [${rc.name}] ${host}: ${message}`);
                      outcome = { success: false, error: message };
                      return outcome;
                    }
                    drained = false;
                  }
                  outcome = { success: true };
                  return outcome;
                } finally {
                  // Only reachable when a real drain succeeded and was never
                  // cleared (i.e. never reachable at all under --skip-drain,
                  // since `drained` is only ever set true inside the
                  // `!options.skipDrain` branch above).
                  if (drained) {
                    const reReadyResult = await readyServer(rc.haproxy!, host);
                    if (!reReadyResult.success) {
                      const message = `ready (recovery re-ready) failed: ${summarizeHaproxyResult(reReadyResult)} — host ${host} may be left drained`;
                      ctx.output.error(`  [${rc.name}] ${host}: ${message}`);
                      outcome.error = outcome.error ? `${outcome.error}; ${message}` : message;
                    }
                  }
                }
              };

              const strategy = parseDeploymentStrategy(rc.strategy ?? 'sequential');
              const strategyResult = await executeStrategy(strategy, rc.hosts, lifecycle, { abortOnFailure: rc.blocking });
              for (const [host, r] of strategyResult.results) results.set(host, r);

              return {
                ctx: {
                  results,
                  aborted: strategyResult.aborted,
                  failedBatch: strategyResult.failedBatch,
                  skipped: strategyResult.skipped,
                  successful: strategyResult.successful,
                  failed: strategyResult.failed,
                  healthCheckFailed,
                  workerFailed: 0,
                },
                coverageOk: computeFullCoverage(strategyResult.successful, rc.hosts.length),
              };
            }

            // ── worker class (no active haproxy, or --skip-drain): sequential, no drain, non-blocking ──
            // Worker failures are NON-BLOCKING: recorded in workerFailed, never in
            // failed/healthCheckFailed, so they never trip the multi-class blocking gate.
            let workerFailed = 0;
            let successful = 0;
            for (const host of rc.hosts) {
              const preResult = await checkAndUpload(host);
              if (!preResult.success) {
                results.set(host, { success: false, error: preResult.error });
                workerFailed++;
                continue;
              }
              if (preResult.skipped) {
                results.set(host, { success: true });
                successful++;
                continue;
              }
              const activateResult = await activateHost(host);
              if (!activateResult.success) {
                results.set(host, { success: false, error: activateResult.error });
                workerFailed++;
                continue;
              }
              const pluginUrl = trustPluginUrl(host, port);
              const active = await pollWorkerActive(pluginUrl, version, { sleep: deps?.sleep });
              if (!active) {
                const message = `worker did not reach active state with version ${version} within the poll window`;
                ctx.output.warn(`  [${rc.name}] ${host}: ${message} (non-blocking)`);
                results.set(host, { success: false, error: message });
                workerFailed++;
                continue;
              }
              results.set(host, { success: true });
              successful++;
            }

            return {
              ctx: { results, aborted: false, skipped: 0, successful, failed, healthCheckFailed, workerFailed },
              coverageOk: computeFullCoverage(successful, rc.hosts.length),
            };
          } finally {
            for (const host of rc.hosts) clearEndpointOverride(host);
            await Promise.all(classTunnels.map((t) => t.close().catch(() => undefined)));
          }
        };

        const result = await executeMultiClassDeployment(resolved, runClass, ctx.output);
        printMultiClassSummary(result, ctx.isPlainMode());

        // ── post-gate: use deploy-core's own gating primitives, not ad hoc booleans ──
        const noFailures = !result.abortedAt && result.classes.every((c) => !c.ctx || computeNoFailures(c.ctx));
        const fullCoverage = result.classes.every((c) => !c.ran || c.coverageOk === true);

        const allConfiguredHosts = classes.flatMap((c) => c.hosts);
        const deployedHosts = resolved.flatMap((r) => r.hosts);
        const isScoped = isScopedDeploy(allConfiguredHosts, deployedHosts);

        const dropped: string[] = [];
        for (const c of result.classes) {
          if (c.ran && c.coverageOk === false && c.ctx) {
            for (const [host, r] of c.ctx.results) {
              if (!r.success) dropped.push(host);
            }
          }
        }

        const skipReason = resolvePostSkipReason({
          runPost: !options.skipMigrations,
          runPostFlag: '--skip-migrations',
          isScoped,
          fullCoverage,
          noFailures,
          dropped,
        });

        await runTrustMigrationPhase(config, 'post-deploy', configName, ctx, {
          dryRun: false,
          run: skipReason === undefined,
          skipReason,
        }, deps);

        if (result.abortedAt) process.exit(1);
      } finally {
        if (config.tunnel) {
          await Promise.all(openTunnels.map((t) => t.close().catch(() => undefined)));
        }
      }
    });
}

/**
 * Register `znvault trust status <config>` — GET /status against every host
 * in a saved config (tunneled if config.tunnel), rendered as a table.
 */
function registerStatusCommand(trust: Command, ctx: CLIPluginContext): void {
  const loc = trustConfigStoreLocation();

  trust
    .command('status <configName>')
    .description('Show Trust portal deployment status across all hosts in a saved configuration')
    .action(async (configName: string) => {
      const config = (await getConfig(loc, configName)) as TrustDeployConfig | undefined;
      if (!config) {
        ctx.output.error(`Deployment config '${configName}' not found`);
        process.exit(1);
      }

      const classes = resolveConfigClasses(config);
      const baseForResolve = withWarPathMarker(config);
      const rows: unknown[][] = [];

      for (const cls of classes) {
        const rc = resolveClass(baseForResolve, cls);
        const port = rc.port ?? DEFAULT_PORT;
        for (const host of rc.hosts) {
          let tunnel: Tunnel | undefined;
          try {
            if (config.tunnel) {
              tunnel = await openTunnel(host, { user: config.ssh?.user, remotePort: port, readinessTimeoutMs: config.ssh?.readinessTimeoutMs });
              setEndpointOverride(host, '127.0.0.1', tunnel.localPort);
            }
            const pluginUrl = trustPluginUrl(host, port);
            const status = await agentGet<{ service: string | null; active: boolean; currentVersion: string | null; journalOpen: boolean }>(`${pluginUrl}/status`);
            rows.push([rc.name, host, status.service ?? '(unknown)', String(status.active), status.currentVersion ?? '(none)', String(status.journalOpen)]);
          } catch (err) {
            rows.push([rc.name, host, 'ERROR', '-', '-', getErrorMessage(err)]);
          } finally {
            if (tunnel) {
              clearEndpointOverride(host);
              await tunnel.close().catch(() => undefined);
            }
          }
        }
      }

      ctx.output.table(['Class', 'Host', 'Service', 'Active', 'Version', 'Journal Open'], rows);
    });
}

/**
 * Register `znvault trust rollback <config>` — POST /rollback against a
 * single target host. `--confirm` is required (commander enforces this
 * before the action even runs) and must equal that host's OS hostname, per
 * T4's route contract.
 */
function registerRollbackCommand(trust: Command, ctx: CLIPluginContext): void {
  const loc = trustConfigStoreLocation();

  trust
    .command('rollback <configName>')
    .description('Roll back the Trust portal to a previous release on one host (symlink flip)')
    .requiredOption('--host <ip>', 'Target host to roll back')
    .requiredOption('--to <version>', 'Release version to roll back to')
    .requiredOption('--confirm <hostname>', "Must equal the target host's own OS hostname (safety confirmation)")
    .action(async (configName: string, options: { host: string; to: string; confirm: string }) => {
      const config = (await getConfig(loc, configName)) as TrustDeployConfig | undefined;
      if (!config) {
        ctx.output.error(`Deployment config '${configName}' not found`);
        process.exit(1);
      }

      const classes = resolveConfigClasses(config);
      const baseForResolve = withWarPathMarker(config);
      const owningClass = classes.find((c) => c.hosts.includes(options.host));
      const port = owningClass ? (resolveClass(baseForResolve, owningClass).port ?? DEFAULT_PORT) : (config.port ?? DEFAULT_PORT);

      let tunnel: Tunnel | undefined;
      try {
        if (config.tunnel) {
          tunnel = await openTunnel(options.host, { user: config.ssh?.user, remotePort: port, readinessTimeoutMs: config.ssh?.readinessTimeoutMs });
          setEndpointOverride(options.host, '127.0.0.1', tunnel.localPort);
        }
        const pluginUrl = trustPluginUrl(options.host, port);
        const { previous } = await agentPost<{ previous: string | null }>(`${pluginUrl}/rollback`, { toVersion: options.to, confirm: options.confirm });
        ctx.output.success(`${options.host}: rolled back to ${options.to} (was ${previous ?? '(none)'})`);
      } catch (err) {
        ctx.output.error(`Rollback failed: ${getErrorMessage(err)}`);
        process.exit(1);
      } finally {
        if (tunnel) {
          clearEndpointOverride(options.host);
          await tunnel.close().catch(() => undefined);
        }
      }
    });
}

/**
 * Register all `znvault trust ...` command groups on the given `trust`
 * top-level command. Called from src/cli.ts's registerCommands.
 *
 * Two families live under `trust`, and they share nothing but the namespace:
 * `deploy`/`status`/`rollback`/`config` talk to the zn-vault-agent's
 * `/plugins/trust/*` routes on each node, while `incident` talks to the Trust
 * PORTAL's own API as an authenticated ISMS user (see src/cli/incident/). They
 * are grouped together because that is where an operator looks for anything
 * trust-shaped — not because they share a transport.
 */
export function registerTrustCommands(
  trust: Command,
  ctx: CLIPluginContext,
  deps?: DeployCommandDeps,
  incidentDeps?: IncidentCommandDeps,
): void {
  const deployCmd = trust.command('deploy').description('Deploy the Trust portal (release-dir + chunked upload + atomic activation)');
  registerDeployCommands(deployCmd, ctx, deps);

  registerStatusCommand(trust, ctx);
  registerRollbackCommand(trust, ctx);

  const configCmd = trust.command('config').description('Manage Trust deployment configurations');
  registerConfigCommands(configCmd, ctx);

  const incidentCmd = trust.command('incident').description('Capture and manage ISMS incidents in the Trust portal');
  registerIncidentCommands(incidentCmd, ctx, incidentDeps);
}

export type { CLIPlugin };
