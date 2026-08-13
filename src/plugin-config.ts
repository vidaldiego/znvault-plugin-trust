/**
 * Configuration for the trust portal deployment plugin. Passed to
 * `createTrustPlugin` (agent side) and consumed by later tasks' route
 * handlers (deploy/status/rollback) and CLI command implementations.
 */
export interface TrustPluginConfig {
  /**
   * The systemd unit this node runs (e.g. `trust-api`). Optional: when
   * omitted, the plugin auto-detects the single installed `trust-*.service`
   * on the host. Set it explicitly only on hosts that run more than one
   * trust service (ambiguous → detection throws).
   */
  service?: string;
  /** Application root on disk. Default: `/opt/trust`. */
  appRoot?: string;
  /** App user the deployed release runs/is owned as. Default: `trust`. */
  user?: string;
  /**
   * Full path to the deployment journal's `.json` file. Default:
   * `/var/lib/zn-vault-agent/trust-deploy-journal.json` — deliberately NOT
   * under `appRoot` (`/opt/trust`): that tree is owned by the app user
   * (`trust`) and mutated exclusively via `sudo -u trust`, while the journal
   * is agent-process state read/written directly by `zn-vault-agent` via
   * plain `node:fs`. `/var/lib/zn-vault-agent` is already writable by the
   * agent (it's in the stock unit's `ReadWritePaths=`), so this default
   * needs no extra permission grant on the host — see `docs/HOST_SETUP.md`.
   */
  journalPath?: string;
}
