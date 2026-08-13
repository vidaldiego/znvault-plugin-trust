/**
 * Agent-side entry point: mounts the Fastify routes zn-vault-agent loads to
 * drive Trust portal deployments (release-dir deploy, atomic symlink
 * activation, Prisma dynamic-secret migrations). Structure mirrors
 * znvault-plugin-archon's src/index.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { registerRoutes, type PluginLogger } from './routes/index.js';
import type { TrustPluginConfig } from './plugin-config.js';
import { TrustManager, spawnRun } from './trust-manager.js';
import { ReleaseStore } from './release-store.js';
import { DeploymentJournal } from './deployment-journal.js';

// The zn-vault-agent plugin loader rejects any plugin without a non-empty
// `version` string (loader.js validatePlugin). Read it from our own
// package.json at module load, with a fallback so a packaging quirk degrades
// to a valid-but-unknown version rather than a hard load failure.
export const PLUGIN_VERSION: string = (() => {
  try {
    // dist/index.js → package.json is one level up (../package.json).
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// Structural — matches @zincapp/zn-vault-agent/plugins' AgentPlugin, but not
// imported directly so this package doesn't hard-depend on the agent's
// concrete types at compile time (peerDependency, optional at runtime).
export interface AgentPlugin {
  name: string;
  version: string;
  routes(fastify: FastifyInstance, ctx: { logger: PluginLogger }): Promise<void>;
}

export default function createTrustPlugin(config: TrustPluginConfig): AgentPlugin {
  // ONE long-lived instance each, built once at factory time — never
  // per-request. This matters most for ReleaseStore: prune()'s
  // "never delete the previous activate()'d release" protection lives in
  // instance memory (lastPrevious), so a fresh store per request would
  // silently lose that guarantee. TrustManager caches its detected service
  // the same way, and DeploymentJournal's in-memory `current` checkpoint is
  // the whole point of the crash-recovery invariant it exists for.
  const mgr = new TrustManager(config, spawnRun);
  const { appRoot, user, journalPath } = mgr.resolved;
  const store = new ReleaseStore({ run: spawnRun, appRoot, user });
  // Constructed here with no logger — the real one only arrives via
  // routes(fastify, ctx) below, after loadFromDisk() has already run
  // synchronously in this constructor. journal.setLogger() (called in
  // routes()) both attaches it for future use (persist() failures, open/
  // close info logs) AND re-emits the startup "found an open journal"
  // warning through it if loadFromDisk() found a stale checkpoint — see
  // DeploymentJournal.setLogger's doc comment.
  const journal = new DeploymentJournal(journalPath);

  return {
    name: 'trust',
    version: PLUGIN_VERSION,
    async routes(fastify: FastifyInstance, ctx: { logger: PluginLogger }): Promise<void> {
      journal.setLogger(ctx.logger);
      await registerRoutes(fastify, { mgr, store, journal, logger: ctx.logger });
      ctx.logger.info({}, 'Trust routes registered');
    },
  };
}

export { registerRoutes } from './routes/index.js';
export { TrustManager, resolveConfig } from './trust-manager.js';
export { ReleaseStore } from './release-store.js';
export { DeploymentJournal } from './deployment-journal.js';
export type { TrustPluginConfig } from './plugin-config.js';
export type { PluginLogger } from './routes/index.js';
