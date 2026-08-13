// Path: src/routes/status.ts
// GET /status — service + release state, single combined snapshot for the
// Trust CLI / dashboard.
//
// manager.getService()/status() are best-effort: service auto-detection
// (detect-service.ts) throws when zero or >1 trust-*.service units are
// found, and that is a legitimate "can't tell you the service" state, not a
// server fault — this route reports `service: null, active: false` rather
// than surfacing a 500 for it. store.currentVersion()/listReleases() are
// already best-effort in ReleaseStore itself (null / [] on a non-zero
// exit), so they're read directly.

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './types.js';

export async function registerStatusRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { mgr, store, journal } = ctx;

  fastify.get('/status', async () => {
    let service: string | null = null;
    let active = false;
    try {
      service = await mgr.getService();
      const st = await mgr.status();
      active = st.active;
    } catch {
      // Detection failure (ambiguous or absent trust-*.service) — best
      // effort, not a 500. See file header.
      service = null;
      active = false;
    }

    const [currentVersion, releases] = await Promise.all([store.currentVersion(), store.listReleases()]);

    return {
      service,
      active,
      currentVersion,
      releases,
      journalOpen: journal.isOpen(),
    };
  });
}
