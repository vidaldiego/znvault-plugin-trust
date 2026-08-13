// Path: src/deployment-journal.ts
//
// Ported from @zincapp/znvault-plugin-archon deployment-journal.ts; TODO:
// upstream into znvault-deploy-core.
//
// Adapted for the trust plugin's deploy model: there is no file-diff apply
// step here (Trust portal releases are release-dir + atomic symlink flip,
// see release-store.ts) — the operation this journal brackets is
// POST /activate (store.activate + mgr.restart), not a diff apply. The
// checkpoint therefore records the target `version` being activated rather
// than archon's filesChanged/filesDeleted diff-size counters; everything
// else (open/close/isOpen/hostname/peek, load-on-construct, 0600 persisted
// file, deliberate crash-evidence semantics) is unchanged from archon's
// original. Journal path: caller-supplied full `.json` path — see
// `TrustPluginConfig.journalPath` and `trust-manager.ts`'s `resolveConfig`
// for the default (`/var/lib/zn-vault-agent/trust-deploy-journal.json`, NOT
// under `<appRoot>` — that tree is `sudo -u trust`-owned app content, this is
// agent-process state).
//
// The invariant this preserves: a /activate either fully applies (journal
// closed) or leaves the journal marked open on disk, so a crash mid-activate
// is detectable on the next boot / next request. POST /activate and
// POST /rollback both refuse to run while a journal is open (409) — see
// routes/lifecycle.ts. Unlike archon (which also gates a destructive
// POST /reboot on this), trust has no orchestrated reboot; the journal here
// exists purely as crash evidence + the concurrent-activate guard.

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname as osHostname } from 'node:os';

export interface DeploymentCheckpoint {
  version: string;
  startedAt: number;
}

export interface JournalLogger {
  info?(obj: unknown, msg?: string): void;
  warn?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

/**
 * Deployment journal for crash recovery + the /activate and /rollback
 * routes' "is an activation in flight" check.
 *
 * Journal is stored at `/var/lib/zn-vault-agent/trust-deploy-journal.json` by
 * default — the agent's own persistent-state directory (already writable by
 * the `zn-vault-agent` process per the stock unit's `ReadWritePaths=`, no
 * extra host permission grant needed), NOT under `<appRoot>` (`/opt/trust`),
 * which is `sudo -u trust`-owned app-release content. `isOpen()` is a
 * synchronous read of in-memory state (mirrored to disk on every open/close)
 * so route guards never have to do I/O on the hot path.
 */
export class DeploymentJournal {
  private readonly journalPath: string;
  private logger: JournalLogger;
  private readonly hostnameValue: string;
  private current: DeploymentCheckpoint | null = null;

  constructor(appRootOrPath: string, logger: JournalLogger = {}, hostnameOverride?: string) {
    this.journalPath = appRootOrPath.endsWith('.json')
      ? appRootOrPath
      : `${appRootOrPath.replace(/\/$/, '')}/.deploy-journal.json`;
    this.logger = logger;
    this.hostnameValue = hostnameOverride ?? osHostname();
    this.loadFromDisk();
  }

  /** Hostname this node identifies as — read by the /activate and /rollback confirm guards. */
  hostname(): string {
    return this.hostnameValue;
  }

  /**
   * Attach a logger after construction. Exists because this journal is built
   * at plugin FACTORY time (src/index.ts's createTrustPlugin, before the
   * agent hands over a real logger), but `loadFromDisk()` — which is what
   * detects and warns about a stale, still-open journal left by a crashed
   * prior activation — already ran synchronously in the constructor with
   * whatever logger was available then (the no-op `{}` default). Without
   * this setter, that startup warning is silently lost forever, and every
   * later `persist()` failure (see its own doc comment) logs to the same
   * no-op sink too.
   *
   * If a checkpoint was already loaded from disk before this is called, the
   * "found an open journal" warning is (re-)emitted through the newly
   * attached logger — so the crash-evidence signal still reaches wherever
   * the real logger sends it, just delayed until routes() wires it up
   * instead of lost.
   */
  setLogger(logger: JournalLogger): void {
    this.logger = logger;
    if (this.current) {
      this.logger.warn?.(
        { version: this.current.version },
        'Found an open deployment journal on startup — a previous activation may have crashed mid-apply',
      );
    }
  }

  /** True while an activation is open (journal not yet closed). Synchronous — read on every /activate and /rollback request. */
  isOpen(): boolean {
    return this.current !== null;
  }

  /** Open a new journal entry before activating a release. Persists to disk. */
  open(options: { version: string }): void {
    this.current = {
      version: options.version,
      startedAt: Date.now(),
    };
    this.persist();
    this.logger.info?.({ version: options.version }, 'Deployment journal opened');
  }

  /** Close (clear) the journal after an activation fully applies. */
  close(): void {
    if (!this.current) return;
    const { version, startedAt } = this.current;
    this.current = null;
    this.clearDisk();
    this.logger.info?.({ version, durationMs: Date.now() - startedAt }, 'Deployment journal closed');
  }

  /** Current checkpoint, if any — for diagnostics. */
  peek(): DeploymentCheckpoint | null {
    return this.current;
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.journalPath)) return;
      const raw = readFileSync(this.journalPath, 'utf-8');
      this.current = JSON.parse(raw) as DeploymentCheckpoint;
      this.logger.warn?.(
        { version: this.current.version },
        'Found an open deployment journal on startup — a previous activation may have crashed mid-apply',
      );
    } catch (err) {
      this.logger.warn?.({ err }, 'Failed to read deployment journal from disk (ignoring, treating as closed)');
      this.current = null;
    }
  }

  private persist(): void {
    if (!this.current) return;
    try {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      writeFileSync(this.journalPath, JSON.stringify(this.current, null, 2), { mode: 0o600 });
    } catch (err) {
      this.logger.warn?.({ err }, 'Failed to persist deployment journal');
    }
  }

  private clearDisk(): void {
    try {
      rmSync(this.journalPath, { force: true });
    } catch {
      // ignore
    }
  }
}
