// Path: src/routes/lifecycle.ts
// POST /activate, POST /rollback, POST /restart|/start|/stop.
//
// /activate and /rollback share the confirm-hostname guard shape from
// znvault-plugin-archon's lifecycle.ts /reboot pattern: 409 if a journal is
// already open (another activation is mid-flight), 400 if the caller's
// `confirm` doesn't match journal.hostname() (the caller must positively
// acknowledge which host they're targeting — guards against a fat-fingered
// fleet-wide script hitting the wrong node).
//
// /activate wraps store.activate + mgr.restart in a journal window: open
// BEFORE the mutating calls, close only after BOTH succeed. If either
// throws, the journal is deliberately left OPEN — NOT closed in a finally.
// This is archon's deliberate crash-evidence pattern (see
// deployment-journal.ts's header comment), ported as-is: a half-activated
// node (release flipped but service not yet restarted, or vice versa) must
// be detectable on the next GET /status / operator inspection, not silently
// cleared.
//
// Both routes pre-check the target version's existence via
// store.listReleases() BEFORE touching the journal (activate) or calling
// store.activate() (rollback). This is deliberately NOT the same thing as
// the crash-evidence semantics above: a version that was simply never
// uploaded is a caller mistake that mutates nothing, not a mid-flight
// failure — it must 400 with no journal side effect at all, so a typo'd
// version number can never wedge the node into "journal open, refusing all
// future activity" for zero actual work done. A REAL failure that occurs
// AFTER this pre-check (e.g. store.activate()/mgr.restart() throwing once
// the version is confirmed to exist) still gets the full crash-evidence
// treatment untouched.
//
// /rollback reuses the same guards but does NOT open a journal window: per
// the brief it's a short, already-known-good flip back to a previously
// activated release, not a fresh deploy — 409 still applies (refuses to run
// while another activation is in flight), but there is no open/close of its
// own to bracket it. Its pre-check exists for a narrower reason than
// activate's (there's no journal to protect): store.activate() would
// otherwise throw on an unknown version and fall into the generic 500
// handler below — the pre-check turns that into the same clean 400 shape
// /activate uses, instead of two different error mappings for the same
// caller mistake.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { getErrorMessage } from '../utils/error.js';
import type { RouteContext } from './types.js';

interface ActivateBody { version?: string; confirm?: string; }
interface RollbackBody { toVersion?: string; confirm?: string; }

/** 400s (and sends) if confirm is missing or doesn't match hostname. Returns whether the caller may proceed. */
function checkConfirm(confirm: unknown, hostname: string, reply: FastifyReply): boolean {
  if (typeof confirm !== 'string' || confirm.length === 0) {
    reply.code(400).send({ error: 'Invalid request', message: 'confirm (hostname) is required' });
    return false;
  }
  if (confirm !== hostname) {
    reply.code(400).send({ error: 'Invalid request', message: `confirm must equal this host's hostname (${hostname})` });
    return false;
  }
  return true;
}

export async function registerLifecycleRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { mgr, store, journal, logger } = ctx;

  fastify.post<{ Body: ActivateBody }>('/activate', async (request, reply) => {
    const { version, confirm } = request.body ?? {};
    if (typeof version !== 'string' || version.length === 0) {
      return reply.code(400).send({ error: 'Invalid request', message: 'version is required' });
    }
    if (journal.isOpen()) {
      return reply.code(409).send({ error: 'Activation in progress', message: 'A deployment journal is already open' });
    }
    if (!checkConfirm(confirm, journal.hostname(), reply)) return;

    const releases = await store.listReleases();
    if (!releases.includes(version)) {
      return reply.code(400).send({
        error: 'unknown version',
        message: `release ${version} has not been uploaded to this node — commitUpload it (POST /release/chunk) before activating`,
      });
    }

    journal.open({ version });
    try {
      logger.info({ version }, 'Activating release');
      const { previous } = await store.activate(version);
      await mgr.restart();
      journal.close();
      return { previous };
    } catch (err) {
      // Deliberately NOT closing the journal here — see file header. A
      // throw mid-activate leaves crash evidence on disk.
      logger.error({ err, version }, 'Activate failed — journal left open');
      return reply.code(500).send({ error: 'Activate failed', message: getErrorMessage(err) });
    }
  });

  fastify.post<{ Body: RollbackBody }>('/rollback', async (request, reply) => {
    const { toVersion, confirm } = request.body ?? {};
    if (typeof toVersion !== 'string' || toVersion.length === 0) {
      return reply.code(400).send({ error: 'Invalid request', message: 'toVersion is required' });
    }
    if (journal.isOpen()) {
      return reply.code(409).send({ error: 'Activation in progress', message: 'A deployment journal is already open' });
    }
    if (!checkConfirm(confirm, journal.hostname(), reply)) return;

    const releases = await store.listReleases();
    if (!releases.includes(toVersion)) {
      return reply.code(400).send({
        error: 'unknown version',
        message: `release ${toVersion} has not been uploaded to this node — nothing to roll back to`,
      });
    }

    try {
      logger.info({ toVersion }, 'Rolling back release');
      const { previous } = await store.activate(toVersion);
      await mgr.restart();
      return { previous };
    } catch (err) {
      logger.error({ err, toVersion }, 'Rollback failed');
      return reply.code(500).send({ error: 'Rollback failed', message: getErrorMessage(err) });
    }
  });

  fastify.post('/restart', async (_request, reply) => {
    try {
      logger.info({}, 'Restarting trust service');
      await mgr.restart();
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Restart failed');
      return reply.code(500).send({ error: 'Restart failed', message: getErrorMessage(err) });
    }
  });

  fastify.post('/start', async (_request, reply) => {
    try {
      logger.info({}, 'Starting trust service');
      await mgr.start();
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Start failed');
      return reply.code(500).send({ error: 'Start failed', message: getErrorMessage(err) });
    }
  });

  fastify.post('/stop', async (_request, reply) => {
    try {
      logger.info({}, 'Stopping trust service');
      await mgr.stop();
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Stop failed');
      return reply.code(500).send({ error: 'Stop failed', message: getErrorMessage(err) });
    }
  });
}
