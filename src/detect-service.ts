// Path: src/detect-service.ts
import type { RunFn } from './trust-manager.js';

/**
 * Detect this node's trust systemd service by querying systemd for installed
 * `trust-*.service` units.
 *
 * WHY: a trust node runs one of `trust-api.service` / `trust-worker.service`,
 * but the zn-vault-agent host config (`trust-fleet`) is shared by every trust
 * node and has no per-role override. Rather than maintain one host config per
 * role, the plugin detects its own service: each node runs exactly one
 * trust-* service, so a single fleet-wide plugin entry (with `service`
 * omitted) works everywhere — same rationale as znvault-plugin-archon's
 * detectArchonService.
 *
 * The query is READ-ONLY (`systemctl list-units`) and must NOT go through
 * sudo: the scoped sudoers only permits `systemctl {restart,start,stop,
 * is-active} trust-*` (trust has no orchestrated reboot — see
 * trust-manager.ts), not `list-units`. Read-only systemctl queries need no
 * privilege.
 *
 * Throws (never guesses) when zero or more than one trust service is present —
 * an ambiguous host must set `config.service` explicitly.
 */
export async function detectTrustService(run: RunFn): Promise<string> {
  // `--all` (no --state filter) so we see the unit even if it's momentarily
  // stopped mid-deploy — but we then filter on the LOAD column below to drop
  // stale `not-found`/`masked` leftovers that would otherwise poison the count.
  const r = await run('systemctl', [
    'list-units',
    '--type=service',
    '--all',
    '--plain',
    '--no-legend',
    'trust-*.service',
  ]);
  if (r.code !== 0) {
    throw new Error(`failed to list trust units (systemctl list-units exit ${r.code}): ${r.stderr.trim() || 'unknown error'}`);
  }

  // Each line: "<unit> <load> <active> <sub> <description...>". Take the unit
  // name (first token) only for lines whose LOAD state (second token) is
  // `loaded` — this drops `not-found` and `masked` leftovers that `--all` can
  // surface, so a dead unit reference can't create a false "multiple services"
  // error or be returned as the service to act on. Blank/short lines are ignored.
  const units = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === 'loaded')
    .map((cols) => cols[0])
    .filter((u): u is string => !!u && u.startsWith('trust-') && u.endsWith('.service'));

  const unique = [...new Set(units)];

  if (unique.length > 1) {
    throw new Error(`multiple trust services found (${unique.join(', ')}) — ambiguous; set config.service explicitly`);
  }
  const service = unique[0];
  if (service === undefined) {
    throw new Error('no trust-*.service unit found on this host — set config.service explicitly');
  }
  return service;
}
