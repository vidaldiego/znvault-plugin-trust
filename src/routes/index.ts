// Path: src/routes/index.ts
// Route registration seam for the trust portal agent plugin. src/index.ts's
// `routes` hook delegates here — mirrors znvault-plugin-archon's
// src/routes/index.ts split (wire deps once, then register one file per
// concern) so later tasks can keep growing this without touching the plugin
// factory itself.
//
// zn-vault-agent mounts these under /plugins/trust/.
//
// Routes:
// - GET  /status                       — service + release state (status.ts)
// - POST /release/chunk                — chunked release upload (release.ts)
// - POST /activate                     — journal-wrapped release activation (lifecycle.ts)
// - POST /rollback                     — flip back to a previous release, no journal window (lifecycle.ts)
// - POST /restart|/start|/stop         — service lifecycle via TrustManager (lifecycle.ts)

import type { FastifyInstance } from 'fastify';
import { registerStatusRoutes } from './status.js';
import { registerReleaseRoutes } from './release.js';
import { registerLifecycleRoutes } from './lifecycle.js';
import type { RouteContext } from './types.js';

export async function registerRoutes(fastify: FastifyInstance, deps: RouteContext): Promise<void> {
  await registerStatusRoutes(fastify, deps);
  await registerReleaseRoutes(fastify, deps);
  await registerLifecycleRoutes(fastify, deps);
}

export type { RouteContext, ManagerLike, StoreLike, JournalLike, PluginLogger } from './types.js';
