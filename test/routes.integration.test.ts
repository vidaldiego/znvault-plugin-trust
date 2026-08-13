// Path: test/routes.integration.test.ts
// Real fastify + app.inject() against fakes for mgr/store/journal — mirrors
// znvault-plugin-archon's test/routes.integration.test.ts pattern.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { registerRoutes } from '../src/routes/index.js';
import type { JournalLike, ManagerLike, StoreLike } from '../src/routes/types.js';

function makeMgr(): ManagerLike {
  return {
    restart: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ active: true, raw: 'active' }),
    getService: vi.fn().mockResolvedValue('trust-api.service'),
  };
}

function makeStore(): StoreLike {
  return {
    beginUpload: vi.fn(),
    appendChunk: vi.fn(),
    commitUpload: vi.fn().mockResolvedValue(undefined),
    activate: vi.fn().mockResolvedValue({ previous: '1.0.0' }),
    currentVersion: vi.fn().mockResolvedValue('1.1.0'),
    listReleases: vi.fn().mockResolvedValue(['1.0.0', '1.1.0']),
  };
}

function makeJournal(): JournalLike {
  return {
    isOpen: vi.fn().mockReturnValue(false),
    hostname: vi.fn().mockReturnValue('trust-node-1'),
    open: vi.fn(),
    close: vi.fn(),
  };
}

describe('trust agent routes', () => {
  let app: FastifyInstance;
  let mgr: ReturnType<typeof makeMgr>;
  let store: ReturnType<typeof makeStore>;
  let journal: ReturnType<typeof makeJournal>;
  const logger = { info: vi.fn(), error: vi.fn() };

  beforeEach(async () => {
    app = Fastify();
    mgr = makeMgr();
    store = makeStore();
    journal = makeJournal();
    logger.info.mockClear();
    logger.error.mockClear();

    await registerRoutes(app, { mgr, store, journal, logger });
    await app.ready();
  });

  afterEach(() => app.close());

  describe('GET /status', () => {
    it('happy path: combines manager + store + journal state', async () => {
      const r = await app.inject({ method: 'GET', url: '/status' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({
        service: 'trust-api.service',
        active: true,
        currentVersion: '1.1.0',
        releases: ['1.0.0', '1.1.0'],
        journalOpen: false,
      });
    });

    it('best-effort on detection failure: service:null, active:false, still 200 (not 500)', async () => {
      (mgr.getService as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('multiple trust services found — ambiguous'),
      );
      const r = await app.inject({ method: 'GET', url: '/status' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.service).toBeNull();
      expect(body.active).toBe(false);
      // store/journal state is independent of detection and still reported.
      expect(body.currentVersion).toBe('1.1.0');
      expect(body.releases).toEqual(['1.0.0', '1.1.0']);
    });

    it('best-effort also covers a status() throw after a successful getService()', async () => {
      (mgr.status as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('systemctl not available'));
      const r = await app.inject({ method: 'GET', url: '/status' });
      expect(r.statusCode).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.service).toBeNull();
      expect(body.active).toBe(false);
    });
  });

  describe('POST /release/chunk', () => {
    it('3 chunks in order → commitUpload is called with the sha256 sent on the last chunk', async () => {
      const chunks = [Buffer.from('AAA'), Buffer.from('BBB'), Buffer.from('CCC')];
      const sha = createHash('sha256').update(Buffer.concat(chunks)).digest('hex');

      for (let i = 0; i < chunks.length; i++) {
        const headers: Record<string, string> = {
          'content-type': 'application/octet-stream',
          'x-version': '2.0.0',
          'x-chunk-index': String(i),
          'x-total-chunks': '3',
        };
        if (i === chunks.length - 1) headers['x-sha256'] = sha;

        const r = await app.inject({ method: 'POST', url: '/release/chunk', headers, payload: chunks[i] });
        expect(r.statusCode).toBe(200);
        expect(JSON.parse(r.body)).toEqual(i === chunks.length - 1 ? { committed: true } : { received: i });
      }

      expect(store.beginUpload).toHaveBeenCalledTimes(1);
      expect(store.beginUpload).toHaveBeenCalledWith('2.0.0', 3);
      expect(store.appendChunk).toHaveBeenCalledTimes(3);
      expect(store.commitUpload).toHaveBeenCalledTimes(1);
      expect(store.commitUpload).toHaveBeenCalledWith('2.0.0', sha);
    });

    it('out-of-order chunk index is passed straight through to appendChunk (store owns ordering)', async () => {
      const arrivalOrder = [2, 0, 1];
      for (const index of arrivalOrder) {
        const headers: Record<string, string> = {
          'content-type': 'application/octet-stream',
          'x-version': '2.0.1',
          'x-chunk-index': String(index),
          'x-total-chunks': '3',
        };
        const r = await app.inject({
          method: 'POST',
          url: '/release/chunk',
          headers,
          payload: Buffer.from(`chunk-${index}`),
        });
        expect(r.statusCode).toBe(200);
      }

      const passedIndexes = (store.appendChunk as ReturnType<typeof vi.fn>).mock.calls.map(
        ([, index]: [string, number]) => index,
      );
      expect(passedIndexes).toEqual(arrivalOrder);
      // beginUpload fires exactly once — on whichever request carries index 0,
      // regardless of arrival position (here: the second request).
      expect(store.beginUpload).toHaveBeenCalledTimes(1);
    });

    it('a store throw (bad version / sha mismatch) surfaces as 400, not 500', async () => {
      (store.appendChunk as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('invalid release version "bad/version"');
      });
      const r = await app.inject({
        method: 'POST',
        url: '/release/chunk',
        headers: {
          'content-type': 'application/octet-stream',
          'x-version': 'bad/version',
          'x-chunk-index': '0',
          'x-total-chunks': '1',
        },
        payload: Buffer.from('x'),
      });
      expect(r.statusCode).toBe(400);
    });

    it('a sha mismatch on commit surfaces as 400, not 500', async () => {
      (store.commitUpload as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('sha256 mismatch'));
      const r = await app.inject({
        method: 'POST',
        url: '/release/chunk',
        headers: {
          'content-type': 'application/octet-stream',
          'x-version': '2.0.2',
          'x-chunk-index': '0',
          'x-total-chunks': '1',
          'x-sha256': 'deadbeef',
        },
        payload: Buffer.from('x'),
      });
      expect(r.statusCode).toBe(400);
    });

    it('400 when required headers are missing', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/release/chunk',
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from('x'),
      });
      expect(r.statusCode).toBe(400);
      expect(store.beginUpload).not.toHaveBeenCalled();
    });
  });

  describe('POST /activate', () => {
    beforeEach(() => {
      // '2.0.0' is the version most tests below target as the activation
      // target — it must be present here (as if already uploaded via
      // commitUpload) or the pre-activate membership check 400s before the
      // test's own scenario (journal-open, store.activate throwing, etc.)
      // is ever reached. Scoped to this describe block only, so the
      // unrelated GET /status assertions on the exact `releases` array
      // above are unaffected.
      (store.listReleases as ReturnType<typeof vi.fn>).mockResolvedValue(['1.0.0', '1.1.0', '2.0.0']);
    });

    it('400 when confirm does not match the journal hostname', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/activate',
        payload: { version: '2.0.0', confirm: 'wrong-host' },
      });
      expect(r.statusCode).toBe(400);
      expect(store.activate).not.toHaveBeenCalled();
      expect(journal.open).not.toHaveBeenCalled();
    });

    it('409 when a journal is already open', async () => {
      (journal.isOpen as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const r = await app.inject({
        method: 'POST',
        url: '/activate',
        payload: { version: '2.0.0', confirm: 'trust-node-1' },
      });
      expect(r.statusCode).toBe(409);
      expect(store.activate).not.toHaveBeenCalled();
    });

    it('happy path: open → activate → restart → close, in that exact order; responds { previous }', async () => {
      const order: string[] = [];
      (journal.open as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('open'));
      (store.activate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('activate');
        return { previous: '1.0.0' };
      });
      (mgr.restart as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('restart');
      });
      (journal.close as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('close'));

      const r = await app.inject({
        method: 'POST',
        url: '/activate',
        payload: { version: '2.0.0', confirm: 'trust-node-1' },
      });

      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ previous: '1.0.0' });
      expect(order).toEqual(['open', 'activate', 'restart', 'close']);
      expect(journal.open).toHaveBeenCalledWith({ version: '2.0.0' });
      expect(store.activate).toHaveBeenCalledWith('2.0.0');
    });

    it('store.activate throws AFTER the version pre-check passes → journal is left OPEN (close never called) → 500', async () => {
      // '2.0.0' IS in the mocked listReleases (already uploaded) — this
      // models a REAL mid-flight failure (e.g. a race on the release dir),
      // not the unknown-version case covered separately below, so it must
      // still get the full crash-evidence treatment.
      (store.activate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('release not found'));

      const r = await app.inject({
        method: 'POST',
        url: '/activate',
        payload: { version: '2.0.0', confirm: 'trust-node-1' },
      });

      expect(r.statusCode).toBe(500);
      expect(journal.open).toHaveBeenCalledWith({ version: '2.0.0' });
      expect(journal.close).not.toHaveBeenCalled();
      expect(mgr.restart).not.toHaveBeenCalled();
    });

    it('400 + journal.open NEVER called when the target version was never uploaded (no journal side effect for a caller mistake)', async () => {
      (store.listReleases as ReturnType<typeof vi.fn>).mockResolvedValue(['1.0.0', '1.1.0']); // '9.9.9' absent
      const r = await app.inject({
        method: 'POST',
        url: '/activate',
        payload: { version: '9.9.9', confirm: 'trust-node-1' },
      });

      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body)).toMatchObject({ error: 'unknown version' });
      expect(journal.open).not.toHaveBeenCalled();
      expect(store.activate).not.toHaveBeenCalled();
      expect(mgr.restart).not.toHaveBeenCalled();
    });

    it('mgr.restart throws mid-window → journal is left OPEN (close never called) → 500', async () => {
      (mgr.restart as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('systemctl restart failed'));

      const r = await app.inject({
        method: 'POST',
        url: '/activate',
        payload: { version: '2.0.0', confirm: 'trust-node-1' },
      });

      expect(r.statusCode).toBe(500);
      expect(store.activate).toHaveBeenCalledWith('2.0.0');
      expect(journal.close).not.toHaveBeenCalled();
    });
  });

  describe('POST /rollback', () => {
    it('400 when confirm does not match the journal hostname', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { toVersion: '1.0.0', confirm: 'wrong-host' },
      });
      expect(r.statusCode).toBe(400);
      expect(store.activate).not.toHaveBeenCalled();
    });

    it('409 when a journal is already open', async () => {
      (journal.isOpen as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const r = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { toVersion: '1.0.0', confirm: 'trust-node-1' },
      });
      expect(r.statusCode).toBe(409);
      expect(store.activate).not.toHaveBeenCalled();
    });

    it('happy path: activates + restarts, opens/closes no journal window, responds { previous }', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { toVersion: '1.0.0', confirm: 'trust-node-1' },
      });

      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ previous: '1.0.0' });
      expect(store.activate).toHaveBeenCalledWith('1.0.0');
      expect(mgr.restart).toHaveBeenCalledTimes(1);
      expect(journal.open).not.toHaveBeenCalled();
      expect(journal.close).not.toHaveBeenCalled();
    });

    it('400 when toVersion was never uploaded — a cleaner mapping than letting store.activate() throw into the generic 500 handler', async () => {
      (store.listReleases as ReturnType<typeof vi.fn>).mockResolvedValue(['1.0.0', '1.1.0']); // '9.9.9' absent
      const r = await app.inject({
        method: 'POST',
        url: '/rollback',
        payload: { toVersion: '9.9.9', confirm: 'trust-node-1' },
      });

      expect(r.statusCode).toBe(400);
      expect(JSON.parse(r.body)).toMatchObject({ error: 'unknown version' });
      expect(store.activate).not.toHaveBeenCalled();
      expect(mgr.restart).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle verbs delegate to the manager', () => {
    it('POST /restart calls mgr.restart', async () => {
      const r = await app.inject({ method: 'POST', url: '/restart' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true });
      expect(mgr.restart).toHaveBeenCalledTimes(1);
    });

    it('POST /start calls mgr.start', async () => {
      const r = await app.inject({ method: 'POST', url: '/start' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true });
      expect(mgr.start).toHaveBeenCalledTimes(1);
    });

    it('POST /stop calls mgr.stop', async () => {
      const r = await app.inject({ method: 'POST', url: '/stop' });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: true });
      expect(mgr.stop).toHaveBeenCalledTimes(1);
    });

    it('a manager throw on /restart surfaces as 500', async () => {
      (mgr.restart as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('systemctl restart failed'));
      const r = await app.inject({ method: 'POST', url: '/restart' });
      expect(r.statusCode).toBe(500);
    });
  });
});
