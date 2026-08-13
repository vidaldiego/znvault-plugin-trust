// Path: src/cli/upload.ts
// Chunked upload of a Trust release tarball to a single agent's
// `POST /plugins/trust/release/chunk` (see src/routes/release.ts on the agent
// side for the receiving contract this file's headers must match exactly:
// x-version / x-chunk-index / x-total-chunks, with x-sha256 present ONLY on
// the last chunk — its presence, not chunkIndex reaching totalChunks-1 by
// coincidence, is what triggers the agent's commitUpload).
//
// `chunkBuffer` is pure (no I/O) so it's trivially unit-testable. `tarReleaseDir`
// and the default `httpPostChunk` poster are the only I/O in this file — both
// take an injectable dependency (spawn / fetch is never called directly by
// `uploadRelease` itself) so `uploadRelease`'s header/ordering/sha logic can be
// tested with a fake poster and no real network or child process.

import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Default chunk size for release uploads: 8MB. Matches T4's octet-stream
 * content-type parser bodyLimit (500MB) with generous headroom per request. */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Split `buf` into consecutive, non-overlapping chunks of at most `chunkSize`
 * bytes each. Pure — returns views (`Buffer#subarray`) into the original
 * buffer, no copying.
 *
 * Edge cases:
 *  - `buf.length` an exact multiple of `chunkSize` → every chunk is full-size,
 *    no trailing empty chunk.
 *  - `buf.length` smaller than `chunkSize` → a single chunk containing the
 *    whole buffer.
 *  - `buf.length === 0` → a single empty chunk (never zero chunks — the
 *    agent's `x-total-chunks` contract requires a positive integer, and a
 *    zero-byte release tarball still needs exactly one chunk to carry the
 *    commit-triggering `x-sha256` header).
 */
export function chunkBuffer(buf: Buffer, chunkSize: number): Buffer[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  if (buf.length === 0) return [buf.subarray(0, 0)];
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buf.length; offset += chunkSize) {
    chunks.push(buf.subarray(offset, Math.min(offset + chunkSize, buf.length)));
  }
  return chunks;
}

/**
 * Injectable HTTP POST primitive for chunk upload. Deliberately NOT
 * deploy-core's `agentPost` — that helper always JSON.stringifies its body
 * and pins `Content-Type: application/json`, which cannot carry a binary
 * tarball chunk or the `x-version`/`x-chunk-index`/`x-total-chunks`/`x-sha256`
 * headers T4's route requires. `httpPostChunk` below is the real
 * implementation; callers (commands.ts) inject it, tests inject a `vi.fn()`.
 */
export type ChunkPoster = (url: string, body: Buffer, headers: Record<string, string>) => Promise<unknown>;

const CHUNK_UPLOAD_TIMEOUT_MS = 60_000;

/** Real octet-stream chunk poster — plain `fetch`, no JSON framing. */
export const httpPostChunk: ChunkPoster = async (url, body, headers) => {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(CHUNK_UPLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Agent request failed: ${response.status} ${text}`);
  }
  return response.json();
};

/**
 * Upload `tarballBuffer` to `${pluginUrl}/release/chunk` as `version`, one
 * chunk per POST, in ascending index order (sequential, not parallel — the
 * agent's `beginUpload` on chunk 0 must land before any other chunk, and
 * parallel POSTs give no such guarantee). The sha256 of the WHOLE buffer
 * (not the last chunk alone) is computed once up front and sent ONLY on the
 * final chunk's `x-sha256` header — that's what the agent treats as "this
 * upload is complete, commit it" (see release.ts: `sha256Header` presence,
 * not `chunkIndex === totalChunks - 1`, triggers `commitUpload`).
 */
export async function uploadRelease(
  agentPost: ChunkPoster,
  pluginUrl: string,
  version: string,
  tarballBuffer: Buffer,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<void> {
  const chunks = chunkBuffer(tarballBuffer, chunkSize);
  const totalChunks = chunks.length;
  const sha256 = createHash('sha256').update(tarballBuffer).digest('hex');

  for (let index = 0; index < totalChunks; index++) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'x-version': version,
      'x-chunk-index': String(index),
      'x-total-chunks': String(totalChunks),
    };
    if (index === totalChunks - 1) {
      headers['x-sha256'] = sha256;
    }
    // Non-null assertion is safe: index ranges exactly over chunks' indices.
    await agentPost(`${pluginUrl}/release/chunk`, chunks[index]!, headers);
  }
}

/**
 * Tar `releaseDir` into a gzip archive and read it back as a `Buffer`
 * (`tar -czf <tmp> -C <releaseDir> .`, matching the T4 agent-side extraction
 * convention: everything under `releaseDir` lands at the tarball root, so
 * `tar -xzf ... -C <dest>` on the agent reproduces the same layout). Uses a
 * scratch `mkdtemp` directory that is always removed afterward (success or
 * failure) so repeated CLI runs don't leak temp files.
 *
 * `spawnFn` is injectable (defaults to the real `child_process.spawn`) so
 * tests can fake the tar invocation without shelling out.
 */
export async function tarReleaseDir(releaseDir: string, spawnFn: typeof nodeSpawn = nodeSpawn): Promise<Buffer> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'trust-release-'));
  const tarPath = join(scratchDir, 'release.tgz');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnFn('tar', ['-czf', tarPath, '-C', releaseDir, '.'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar -czf exited ${code}`))));
    });
    return await readFile(tarPath);
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
