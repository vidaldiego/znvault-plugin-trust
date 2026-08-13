// Path: src/routes/release.ts
// POST /release/chunk — chunked octet-stream upload of a release tarball.
//
// Content-type parser mirrors znvault-plugin-archon's deploy.ts:124
// (`application/octet-stream`, `parseAs: 'buffer'`, 500MB bodyLimit). Chunk
// framing is header-driven (x-version, x-chunk-index, x-total-chunks,
// x-sha256 on the last chunk) rather than a multipart body — one HTTP
// request per chunk, matching ReleaseStore's begin/append/commit contract.
//
// chunkIndex === 0 triggers store.beginUpload (first chunk starts the
// upload); the PRESENCE of the x-sha256 header triggers store.commitUpload.
// The route does not separately track "have all chunks arrived" — that's
// ReleaseStore.commitUpload's own job (it throws "incomplete upload" if any
// index in [0, totalChunks) is missing), so a premature/duplicate x-sha256
// just surfaces that same error rather than needing route-level bookkeeping.
// Chunks may arrive out of order; the route forwards chunkIndex straight to
// store.appendChunk (indexed, not streamed) without reordering or validating
// sequence itself.
//
// Error taxonomy: every store throw here (bad version, sha mismatch, missing
// chunks, no upload in progress) is a CLIENT mistake — a corrupt/incomplete
// upload or a bad header — so it's surfaced as 400, not 500.

import type { FastifyInstance } from 'fastify';
import { getErrorMessage } from '../utils/error.js';
import type { RouteContext } from './types.js';

const CHUNK_BODY_LIMIT = 500 * 1024 * 1024;

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function registerReleaseRoutes(fastify: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { store, logger } = ctx;

  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: CHUNK_BODY_LIMIT },
    (_request, payload, done) => done(null, payload),
  );

  fastify.post('/release/chunk', async (request, reply) => {
    const version = headerString(request.headers['x-version']);
    const chunkIndexHeader = headerString(request.headers['x-chunk-index']);
    const totalChunksHeader = headerString(request.headers['x-total-chunks']);
    const sha256Header = headerString(request.headers['x-sha256']);

    if (!version) {
      return reply.code(400).send({ error: 'Invalid request', message: 'x-version header is required' });
    }

    const chunkIndex = Number(chunkIndexHeader);
    if (chunkIndexHeader === undefined || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      return reply.code(400).send({ error: 'Invalid request', message: 'x-chunk-index header must be a non-negative integer' });
    }

    const totalChunks = Number(totalChunksHeader);
    if (totalChunksHeader === undefined || !Number.isInteger(totalChunks) || totalChunks <= 0) {
      return reply.code(400).send({ error: 'Invalid request', message: 'x-total-chunks header must be a positive integer' });
    }

    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      return reply.code(400).send({ error: 'Invalid request', message: 'request body must be application/octet-stream' });
    }

    try {
      if (chunkIndex === 0) {
        store.beginUpload(version, totalChunks);
      }
      store.appendChunk(version, chunkIndex, body);

      if (sha256Header) {
        await store.commitUpload(version, sha256Header);
        logger.info({ version }, 'Release upload committed');
        return { committed: true };
      }

      return { received: chunkIndex };
    } catch (err) {
      logger.error({ err, version, chunkIndex }, 'Release chunk upload failed');
      return reply.code(400).send({ error: 'Upload failed', message: getErrorMessage(err) });
    }
  });
}
