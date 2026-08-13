// Path: test/deployment-journal.test.ts
// Minimal port of znvault-plugin-archon's DeploymentJournal coverage,
// adapted for the trust checkpoint shape ({ version, startedAt } instead of
// { deploymentId, filesChanged, filesDeleted }). Exercises real disk I/O
// against a scratch tmpdir — not mocked — so the 0600 mode and the
// cross-instance crash-recovery load are proven against the real fs, not a
// fake that could silently disagree with Node's actual behavior.

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentJournal } from '../src/deployment-journal.js';

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dj-'));
}

describe('DeploymentJournal', () => {
  it('starts closed with no journal file present', async () => {
    const root = await scratchDir();
    const j = new DeploymentJournal(root, {}, 'trust-node-1');
    expect(j.isOpen()).toBe(false);
    expect(j.peek()).toBeNull();
    expect(j.hostname()).toBe('trust-node-1');
    await rm(root, { recursive: true, force: true });
  });

  it('falls back to os.hostname() when no override is given', () => {
    const j = new DeploymentJournal('/tmp/znvault-plugin-trust-dj-hostname-fallback.json');
    expect(typeof j.hostname()).toBe('string');
    expect(j.hostname().length).toBeGreaterThan(0);
  });

  it('open() persists a checkpoint to disk with mode 0600, isOpen()/peek() reflect it', async () => {
    const root = await scratchDir();
    const j = new DeploymentJournal(root, {}, 'trust-node-1');

    j.open({ version: '2.0.0' });

    expect(j.isOpen()).toBe(true);
    expect(j.peek()).toMatchObject({ version: '2.0.0' });
    expect(typeof j.peek()?.startedAt).toBe('number');

    const path = join(root, '.deploy-journal.json');
    expect(existsSync(path)).toBe(true);
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);

    const raw = JSON.parse(await readFile(path, 'utf-8'));
    expect(raw).toEqual({ version: '2.0.0', startedAt: expect.any(Number) });

    await rm(root, { recursive: true, force: true });
  });

  it('close() clears the in-memory checkpoint and removes the file from disk', async () => {
    const root = await scratchDir();
    const j = new DeploymentJournal(root, {}, 'trust-node-1');
    j.open({ version: '2.0.0' });

    j.close();

    expect(j.isOpen()).toBe(false);
    expect(j.peek()).toBeNull();
    expect(existsSync(join(root, '.deploy-journal.json'))).toBe(false);

    await rm(root, { recursive: true, force: true });
  });

  it('close() on an already-closed journal is a harmless no-op', () => {
    const j = new DeploymentJournal('/tmp/znvault-plugin-trust-dj-close-noop.json');
    expect(() => j.close()).not.toThrow();
    expect(j.isOpen()).toBe(false);
  });

  it('a fresh instance constructed against the same path picks up an open checkpoint left by a previous instance (crash recovery)', async () => {
    const root = await scratchDir();
    const j1 = new DeploymentJournal(root, {}, 'trust-node-1');
    j1.open({ version: '3.1.4' });

    const warn = vi.fn();
    const j2 = new DeploymentJournal(root, { warn }, 'trust-node-1');

    expect(j2.isOpen()).toBe(true);
    expect(j2.peek()).toMatchObject({ version: '3.1.4' });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ version: '3.1.4' }), expect.any(String));

    await rm(root, { recursive: true, force: true });
  });

  it('setLogger() re-emits the startup warn through the newly attached logger when a stale journal was already loaded at construction time', async () => {
    // Models src/index.ts's real sequence: the journal is constructed at
    // plugin FACTORY time with no logger (loadFromDisk() runs synchronously
    // then, using the no-op default), and the real logger only becomes
    // available later, in routes(fastify, ctx), via journal.setLogger(). A
    // stale (crashed-mid-activate) journal found during that construction
    // must not have its startup warning silently lost to the no-op sink.
    const root = await scratchDir();
    const j1 = new DeploymentJournal(root, {}, 'trust-node-1');
    j1.open({ version: '3.1.4' }); // simulate a crash: journal left open on disk

    const j2 = new DeploymentJournal(root, {}, 'trust-node-1'); // no logger yet, like the factory
    expect(j2.isOpen()).toBe(true); // loadFromDisk() already picked up the stale checkpoint

    const warn = vi.fn();
    j2.setLogger({ warn });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ version: '3.1.4' }),
      expect.stringContaining('Found an open deployment journal on startup'),
    );

    await rm(root, { recursive: true, force: true });
  });

  it('setLogger() does NOT emit a spurious warn when the journal was constructed closed', async () => {
    const root = await scratchDir();
    const j = new DeploymentJournal(root, {}, 'trust-node-1');
    expect(j.isOpen()).toBe(false);

    const warn = vi.fn();
    j.setLogger({ warn });

    expect(warn).not.toHaveBeenCalled();

    await rm(root, { recursive: true, force: true });
  });

  it('a persist() failure AFTER setLogger() reaches the newly attached logger, not the construction-time default', async () => {
    const root = await scratchDir();
    const blockerFile = join(root, 'blocker'); // a FILE, not a directory
    await writeFile(blockerFile, 'x');
    const badPath = join(blockerFile, 'sub', 'journal.json'); // parent path traverses a file -> mkdirSync fails (ENOTDIR)
    const j = new DeploymentJournal(badPath, {}, 'trust-node-1');

    const warn = vi.fn();
    j.setLogger({ warn });
    j.open({ version: '1.0.0' }); // persist() is called synchronously by open()

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      expect.stringContaining('Failed to persist deployment journal'),
    );

    await rm(root, { recursive: true, force: true });
  });

  it('accepts an explicit .json path instead of an appRoot directory', async () => {
    const root = await scratchDir();
    const explicitPath = join(root, 'custom-journal.json');
    const j = new DeploymentJournal(explicitPath, {}, 'trust-node-1');

    j.open({ version: '1.0.0' });

    expect(existsSync(explicitPath)).toBe(true);
    expect(existsSync(join(root, '.deploy-journal.json'))).toBe(false);

    await rm(root, { recursive: true, force: true });
  });

  it('a corrupt journal file on disk is treated as closed, not a thrown construction error', async () => {
    const root = await scratchDir();
    const path = join(root, '.deploy-journal.json');
    await writeFile(path, 'not json', { mode: 0o600 });

    const warn = vi.fn();
    const j = new DeploymentJournal(root, { warn }, 'trust-node-1');

    expect(j.isOpen()).toBe(false);
    expect(warn).toHaveBeenCalled();

    await rm(root, { recursive: true, force: true });
  });

  it('logger.info is called with the version on both open() and close()', async () => {
    const root = await scratchDir();
    const info = vi.fn();
    const j = new DeploymentJournal(root, { info }, 'trust-node-1');

    j.open({ version: '2.0.0' });
    expect(info).toHaveBeenCalledWith({ version: '2.0.0' }, expect.stringContaining('opened'));

    j.close();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2.0.0', durationMs: expect.any(Number) }),
      expect.stringContaining('closed'),
    );

    await rm(root, { recursive: true, force: true });
  });
});
