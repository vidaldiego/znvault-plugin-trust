// Path: src/trust-manager.ts
import { spawn } from 'node:child_process';
import type { TrustPluginConfig } from './plugin-config.js';
import { detectTrustService } from './detect-service.js';

export interface RunResult { code: number; stdout: string; stderr: string; }
export type RunFn = (cmd: string, args: string[]) => Promise<RunResult>;

/** Spawn a process and collect its exit code + output — the production `run`
 *  shared by TrustManager and (via src/index.ts) ReleaseStore, so both talk
 *  to the same real process-spawn semantics. Exported for reuse; each
 *  constructor call site can still inject a fake for tests. */
export const spawnRun: RunFn = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
});

/** Defaults applied by resolveConfig() when TrustPluginConfig omits a field. */
const DEFAULT_APP_ROOT = '/opt/trust';
const DEFAULT_USER = 'trust';
/** See TrustPluginConfig.journalPath's doc comment for why this lives under
 *  /var/lib/zn-vault-agent, not appRoot. */
const DEFAULT_JOURNAL_PATH = '/var/lib/zn-vault-agent/trust-deploy-journal.json';

export interface ResolvedTrustConfig {
  /** Application root on disk. */
  appRoot: string;
  /** App user the deployed release runs/is owned as. */
  user: string;
  /** Full path to the deployment journal's `.json` file. */
  journalPath: string;
}

/**
 * Apply `TrustPluginConfig`'s documented defaults: `appRoot` → `/opt/trust`,
 * `user` → `trust`, `journalPath` → `/var/lib/zn-vault-agent/trust-deploy-journal.json`.
 * Exported so later tasks (release store, deploy/status/rollback routes)
 * share this single source of truth instead of re-implementing the
 * defaulting logic.
 *
 * `service` is deliberately NOT resolved here — an omitted `service` means
 * "auto-detect the installed trust-*.service" (see detectTrustService), not
 * "fall back to some literal service name", so it has no static default.
 */
export function resolveConfig(cfg: TrustPluginConfig): ResolvedTrustConfig {
  return {
    appRoot: cfg.appRoot ?? DEFAULT_APP_ROOT,
    user: cfg.user ?? DEFAULT_USER,
    journalPath: cfg.journalPath ?? DEFAULT_JOURNAL_PATH,
  };
}

/**
 * Ensure a systemd unit name carries the `.service` suffix, so `config.service`
 * can be set either way (`trust-api` or `trust-api.service`) and still resolve
 * to the same unit that auto-detection would have returned.
 */
function normalizeServiceName(name: string): string {
  return name.endsWith('.service') ? name : `${name}.service`;
}

export class TrustManager {
  /** Resolved service name, cached after the first lookup (config or detection). */
  private resolvedService: string | undefined;

  /** appRoot/user with TrustPluginConfig defaults applied — see resolveConfig(). */
  readonly resolved: ResolvedTrustConfig;

  constructor(private readonly cfg: TrustPluginConfig, private readonly run: RunFn = spawnRun) {
    this.resolved = resolveConfig(cfg);
    this.resolvedService = cfg.service !== undefined ? normalizeServiceName(cfg.service) : undefined;
  }

  /**
   * The systemd service to act on: `config.service` when set (normalized to
   * carry the `.service` suffix, accepted with or without it), otherwise the
   * single installed `trust-*.service` auto-detected. Detection throws (never
   * guesses) when zero or >1 trust services are present. A SUCCESSFUL
   * detection is cached for the lifetime of this manager; a THROWING
   * detection is not cached, so a transient failure is retried on the next
   * call rather than permanently wedging the node.
   */
  async getService(): Promise<string> {
    if (this.resolvedService === undefined) {
      // Assign only after the await resolves — a throw leaves resolvedService
      // undefined so the next call retries (see doc comment above).
      this.resolvedService = await detectTrustService(this.run);
    }
    return this.resolvedService;
  }

  private async systemctl(verb: string): Promise<void> {
    const service = await this.getService();
    const r = await this.run('sudo', ['systemctl', verb, service]);
    if (r.code !== 0) throw new Error(`systemctl ${verb} ${service} failed: ${r.stderr || r.code}`);
  }
  restart() { return this.systemctl('restart'); }
  start() { return this.systemctl('start'); }
  stop() { return this.systemctl('stop'); }

  async status(): Promise<{ active: boolean; raw: string }> {
    const service = await this.getService();
    const r = await this.run('sudo', ['systemctl', 'is-active', service]);
    return { active: r.stdout.trim() === 'active', raw: r.stdout.trim() };
  }

  // NOTE: deliberately no reboot() here. Archon's fleet includes bare-metal/
  // VMware hosts that sometimes need an orchestrated OS reboot; trust nodes
  // are app VMs where a systemd service restart is always sufficient — see
  // task-2-brief.md ("reboot NO — fuera de alcance para trust").
}
