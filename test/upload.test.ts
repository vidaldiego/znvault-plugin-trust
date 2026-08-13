import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chunkBuffer, uploadRelease, DEFAULT_CHUNK_SIZE, type ChunkPoster } from '../src/cli/upload.js';

describe('chunkBuffer', () => {
  it('splits a buffer that is an exact multiple of chunkSize into equal-size chunks (no trailing empty chunk)', () => {
    const buf = Buffer.alloc(30);
    const chunks = chunkBuffer(buf, 10);
    expect(chunks).toHaveLength(3);
    for (const c of chunks) expect(c.length).toBe(10);
    expect(Buffer.concat(chunks).equals(buf)).toBe(true);
  });

  it('splits a buffer with a remainder into full chunks + one shorter trailing chunk', () => {
    const buf = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes
    const chunks = chunkBuffer(buf, 8);
    expect(chunks.map((c) => c.length)).toEqual([8, 8, 4]);
    expect(Buffer.concat(chunks).equals(buf)).toBe(true);
  });

  it('returns a single chunk when the buffer is smaller than chunkSize', () => {
    const buf = Buffer.from('hello');
    const chunks = chunkBuffer(buf, 1024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.equals(buf)).toBe(true);
  });

  it('returns exactly one (empty) chunk for a zero-byte buffer', () => {
    const chunks = chunkBuffer(Buffer.alloc(0), 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBe(0);
  });

  it('throws on a non-positive chunkSize', () => {
    expect(() => chunkBuffer(Buffer.from('x'), 0)).toThrow(/positive/);
    expect(() => chunkBuffer(Buffer.from('x'), -1)).toThrow(/positive/);
  });
});

describe('uploadRelease', () => {
  function fakePoster() {
    const calls: Array<{ url: string; body: Buffer; headers: Record<string, string> }> = [];
    const poster: ChunkPoster = vi.fn(async (url, body, headers) => {
      calls.push({ url, body: Buffer.from(body), headers });
      return { received: Number(headers['x-chunk-index']) };
    });
    return { poster, calls };
  }

  it('posts one request per chunk, in ascending index order, with the correct header sequence', async () => {
    const { poster, calls } = fakePoster();
    const tarball = Buffer.from('a'.repeat(25)); // 25 bytes, chunkSize 10 -> 3 chunks (10,10,5)

    await uploadRelease(poster, 'http://127.0.0.1:9100/plugins/trust', '2.0.0', tarball, 10);

    expect(calls).toHaveLength(3);
    calls.forEach((c, i) => {
      expect(c.url).toBe('http://127.0.0.1:9100/plugins/trust/release/chunk');
      expect(c.headers['x-version']).toBe('2.0.0');
      expect(c.headers['x-chunk-index']).toBe(String(i));
      expect(c.headers['x-total-chunks']).toBe('3');
      expect(c.headers['Content-Type']).toBe('application/octet-stream');
    });
  });

  it('sends x-sha256 (hex of the WHOLE tarball) ONLY on the last chunk', async () => {
    const { poster, calls } = fakePoster();
    const tarball = Buffer.from('release-tarball-contents-are-here');
    const expectedSha = createHash('sha256').update(tarball).digest('hex');

    await uploadRelease(poster, 'http://127.0.0.1:9100/plugins/trust', '1.5.0', tarball, 8);

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls.slice(0, -1)) {
      expect(c.headers['x-sha256']).toBeUndefined();
    }
    const last = calls[calls.length - 1]!;
    expect(last.headers['x-sha256']).toBe(expectedSha);
  });

  it('a single-chunk upload (buffer smaller than chunkSize) still carries x-sha256 on that one request', async () => {
    const { poster, calls } = fakePoster();
    const tarball = Buffer.from('tiny');
    const expectedSha = createHash('sha256').update(tarball).digest('hex');

    await uploadRelease(poster, 'http://127.0.0.1:9100/plugins/trust', '0.0.1', tarball, DEFAULT_CHUNK_SIZE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-total-chunks']).toBe('1');
    expect(calls[0]!.headers['x-chunk-index']).toBe('0');
    expect(calls[0]!.headers['x-sha256']).toBe(expectedSha);
  });

  it('reassembling the posted chunk bodies reproduces the original tarball byte-for-byte', async () => {
    const { poster, calls } = fakePoster();
    const tarball = Buffer.from(Array.from({ length: 37 }, (_, i) => i % 256));

    await uploadRelease(poster, 'http://127.0.0.1:9100/plugins/trust', '3.0.0', tarball, 9);

    const reassembled = Buffer.concat(calls.map((c) => c.body));
    expect(reassembled.equals(tarball)).toBe(true);
  });

  it('propagates a poster rejection and stops uploading further chunks', async () => {
    const calls: number[] = [];
    const poster: ChunkPoster = vi.fn(async (_url, _body, headers) => {
      const idx = Number(headers['x-chunk-index']);
      calls.push(idx);
      if (idx === 1) throw new Error('agent rejected chunk 1');
      return {};
    });
    const tarball = Buffer.alloc(30);

    await expect(uploadRelease(poster, 'http://x/plugins/trust', '1.0.0', tarball, 10)).rejects.toThrow('agent rejected chunk 1');
    expect(calls).toEqual([0, 1]); // chunk 2 never attempted
  });
});
