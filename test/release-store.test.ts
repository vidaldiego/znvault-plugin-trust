// Path: test/release-store.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReleaseStore } from '../src/release-store.js';
import type { RunFn, RunResult } from '../src/trust-manager.js';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): RunResult => ({ code: 1, stdout: '', stderr });

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Version validation — security boundary: release versions name filesystem
// paths (releases/<version>, the tar -C target, the /tmp buffer name).
// ---------------------------------------------------------------------------
describe('ReleaseStore — version validation', () => {
  it('rejects a version attempting path traversal ("../evil")', () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(() => store.beginUpload('../evil', 1)).toThrow(/invalid release version/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a version containing a path separator ("a/b")', () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(() => store.beginUpload('a/b', 1)).toThrow(/invalid release version/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects an invalid version on appendChunk, commitUpload, and activate too', async () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(() => store.appendChunk('../evil', 0, Buffer.from('x'))).toThrow(/invalid release version/i);
    await expect(store.commitUpload('a/b', 'deadbeef')).rejects.toThrow(/invalid release version/i);
    await expect(store.activate('../evil')).rejects.toThrow(/invalid release version/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('accepts an ordinary semver-ish version', () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(() => store.beginUpload('1.2.0', 1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// beginUpload / appendChunk — in-memory chunk tracking
// ---------------------------------------------------------------------------
describe('ReleaseStore.beginUpload / appendChunk', () => {
  it('appendChunk without a prior beginUpload throws', () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(() => store.appendChunk('1.2.0', 0, Buffer.from('x'))).toThrow(/no upload in progress/i);
  });

  it('appendChunk with an out-of-range index throws', () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    store.beginUpload('1.2.0', 2);
    expect(() => store.appendChunk('1.2.0', 2, Buffer.from('x'))).toThrow(/out of range/i);
    expect(() => store.appendChunk('1.2.0', -1, Buffer.from('x'))).toThrow(/out of range/i);
  });

  it('beginUpload rejects a non-positive totalChunks', () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(() => store.beginUpload('1.2.0', 0)).toThrow(/positive integer/i);
    expect(() => store.beginUpload('1.2.0', -1)).toThrow(/positive integer/i);
  });
});

// ---------------------------------------------------------------------------
// commitUpload — fake run recording commands
// ---------------------------------------------------------------------------
describe('ReleaseStore.commitUpload', () => {
  it('sha256 mismatch: throws and issues NO run() calls at all (no tar, no sudo)', async () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    store.beginUpload('1.2.0', 1);
    store.appendChunk('1.2.0', 0, Buffer.from('release-bytes'));
    await expect(store.commitUpload('1.2.0', 'not-the-real-hash')).rejects.toThrow(/sha256 mismatch/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('incomplete chunk set (missing index) throws before assembling — no run() calls', async () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    store.beginUpload('1.2.0', 3);
    store.appendChunk('1.2.0', 0, Buffer.from('a'));
    store.appendChunk('1.2.0', 2, Buffer.from('c')); // index 1 missing
    await expect(store.commitUpload('1.2.0', 'irrelevant')).rejects.toThrow(/missing chunk 1/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('correct hash: issues exactly sudo -u trust mkdir -p then tar -xzf against the assembled buffer', async () => {
    const data = Buffer.from('fake-tarball-bytes');
    const digest = sha256(data);
    const run = vi.fn().mockResolvedValue(ok('manifest.json\napi\nweb\n'));
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    store.beginUpload('1.2.0', 1);
    store.appendChunk('1.2.0', 0, data);
    await store.commitUpload('1.2.0', digest);

    const calls = run.mock.calls as [string, string[]][];
    const mkdirCall = calls.find(([cmd, args]) => cmd === 'sudo' && args[2] === 'mkdir');
    expect(mkdirCall?.[1]).toEqual(['-u', 'trust', 'mkdir', '-p', '/opt/trust/releases/1.2.0']);

    const tarCall = calls.find(([cmd, args]) => cmd === 'sudo' && args[2] === 'tar');
    expect(tarCall?.[1]).toEqual([
      '-u', 'trust', 'tar', '-xzf', '/tmp/trust-release-1.2.0.tgz', '-C', '/opt/trust/releases/1.2.0',
    ]);

    const manifestCall = calls.find(([cmd, args]) => cmd === 'sudo' && args[2] === 'ls' && args.includes('/opt/trust/releases/1.2.0'));
    expect(manifestCall).toBeTruthy();

    // mkdir must precede tar, which must precede the manifest check.
    const mkdirIdx = calls.indexOf(mkdirCall!);
    const tarIdx = calls.indexOf(tarCall!);
    const manifestIdx = calls.indexOf(manifestCall!);
    expect(mkdirIdx).toBeLessThan(tarIdx);
    expect(tarIdx).toBeLessThan(manifestIdx);
  });

  it('splits chunks appended OUT OF ORDER back into the correct byte sequence before hashing', async () => {
    const data = Buffer.from('0123456789abcdef');
    const c0 = data.subarray(0, 4);
    const c1 = data.subarray(4, 10);
    const c2 = data.subarray(10);
    const digest = sha256(data);
    const run = vi.fn().mockResolvedValue(ok('manifest.json\n'));
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    store.beginUpload('1.2.0', 3);
    // Appended out of order: 2, 0, 1.
    store.appendChunk('1.2.0', 2, c2);
    store.appendChunk('1.2.0', 0, c0);
    store.appendChunk('1.2.0', 1, c1);
    // If assembly were done in append-order instead of index-order, the hash
    // would mismatch and this would throw.
    await expect(store.commitUpload('1.2.0', digest)).resolves.toBeUndefined();
  });

  it('throws and cleans up dest via rm -rf when manifest.json is missing after extraction', async () => {
    const data = Buffer.from('fake-tarball-bytes-2');
    const digest = sha256(data);
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'sudo' && args[2] === 'ls') return Promise.resolve(ok('api\nweb\n')); // no manifest.json
      return Promise.resolve(ok());
    });
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    store.beginUpload('1.2.0', 1);
    store.appendChunk('1.2.0', 0, data);
    await expect(store.commitUpload('1.2.0', digest)).rejects.toThrow(/manifest\.json/i);

    const calls = run.mock.calls as [string, string[]][];
    const rmCall = calls.find(([cmd, args]) => cmd === 'sudo' && args[2] === 'rm');
    expect(rmCall?.[1]).toEqual(['-u', 'trust', 'rm', '-rf', '/opt/trust/releases/1.2.0']);
  });

  it('propagates a non-zero mkdir exit as a thrown error (no tar attempted)', async () => {
    const data = Buffer.from('x');
    const digest = sha256(data);
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'sudo' && args[2] === 'mkdir') return Promise.resolve(fail('permission denied'));
      return Promise.resolve(ok());
    });
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    store.beginUpload('1.2.0', 1);
    store.appendChunk('1.2.0', 0, data);
    await expect(store.commitUpload('1.2.0', digest)).rejects.toThrow(/mkdir/i);
    const calls = run.mock.calls as [string, string[]][];
    expect(calls.some(([cmd, args]) => cmd === 'sudo' && args[2] === 'tar')).toBe(false);
  });

  it('propagates a non-zero tar exit as the thrown error AND cleans up the half-extracted dest via rm -rf', async () => {
    // The most likely real-world commitUpload failure: mkdir succeeded (dest
    // now exists) but the extraction itself failed (corrupt archive, disk
    // full, mid-extraction error) — dest must never be left half-installed.
    const data = Buffer.from('looks-fine-but-tar-will-fail');
    const digest = sha256(data);
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'sudo' && args[2] === 'tar') return Promise.resolve(fail('gzip: stdin: not in gzip format'));
      return Promise.resolve(ok());
    });
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    store.beginUpload('1.2.0', 1);
    store.appendChunk('1.2.0', 0, data);
    await expect(store.commitUpload('1.2.0', digest)).rejects.toThrow(/tar -xzf|gzip/i);

    const calls = run.mock.calls as [string, string[]][];
    expect(calls.some(([cmd, args]) => cmd === 'sudo' && args[2] === 'mkdir')).toBe(true);
    expect(calls.some(([cmd, args]) => cmd === 'sudo' && args[2] === 'tar')).toBe(true);
    // Manifest check (ls) is never reached — tar already failed.
    expect(calls.some(([cmd, args]) => cmd === 'sudo' && args[2] === 'ls')).toBe(false);
    const rmCall = calls.find(([cmd, args]) => cmd === 'sudo' && args[2] === 'rm');
    expect(rmCall?.[1]).toEqual(['-u', 'trust', 'rm', '-rf', '/opt/trust/releases/1.2.0']);
  });

  it('if the cleanup rm -rf itself fails after a tar failure, still throws the ORIGINAL tar error (with a cleanup note appended)', async () => {
    const data = Buffer.from('x');
    const digest = sha256(data);
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'sudo' && args[2] === 'tar') return Promise.resolve(fail('gzip: stdin: not in gzip format'));
      if (cmd === 'sudo' && args[2] === 'rm') return Promise.resolve(fail('permission denied'));
      return Promise.resolve(ok());
    });
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    store.beginUpload('1.2.0', 1);
    store.appendChunk('1.2.0', 0, data);

    // Capture the single thrown error and assert BOTH the original tar
    // failure and the appended cleanup-failure note are present in it —
    // two separate commitUpload() calls would each need their own
    // beginUpload/appendChunk (state is consumed on assembly), so this
    // checks one thrown Error's message against both substrings instead.
    let caught: unknown;
    try {
      await store.commitUpload('1.2.0', digest);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/gzip|tar -xzf/i);
    expect(message).toMatch(/cleanup/i);
  });
});

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------
describe('ReleaseStore.activate', () => {
  it('throws when the release does not exist under releases/', async () => {
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('ls')) return Promise.resolve(ok('1.0.0\n')); // 9.9.9 not present
      return Promise.resolve(ok());
    });
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    await expect(store.activate('9.9.9')).rejects.toThrow(/not found/i);
    const calls = run.mock.calls as [string, string[]][];
    expect(calls.some(([cmd, args]) => cmd === 'sudo' && args[2] === 'ln')).toBe(false);
  });

  it('flips with `ln -sfn releases/<v> current` using a RELATIVE target, and returns the previous read via readlink', async () => {
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('ls')) return Promise.resolve(ok('1.1.0\n1.2.0\n'));
      if (args.includes('readlink')) return Promise.resolve(ok('releases/1.1.0\n'));
      if (args.includes('ln')) return Promise.resolve(ok());
      return Promise.resolve(ok());
    });
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    const result = await store.activate('1.2.0');
    expect(result).toEqual({ previous: '1.1.0' });

    const calls = run.mock.calls as [string, string[]][];
    const lnCall = calls.find(([cmd, args]) => cmd === 'sudo' && args[2] === 'ln');
    expect(lnCall?.[1]).toEqual(['-u', 'trust', 'ln', '-sfn', 'releases/1.2.0', '/opt/trust/current']);
  });

  it('returns previous: null when no current symlink exists yet', async () => {
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('ls')) return Promise.resolve(ok('1.2.0\n'));
      if (args.includes('readlink')) return Promise.resolve(fail());
      return Promise.resolve(ok());
    });
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    const result = await store.activate('1.2.0');
    expect(result).toEqual({ previous: null });
  });

  it('propagates a non-zero ln exit as a thrown error', async () => {
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('ls')) return Promise.resolve(ok('1.2.0\n'));
      if (args.includes('readlink')) return Promise.resolve(fail());
      if (args.includes('ln')) return Promise.resolve(fail('disk full'));
      return Promise.resolve(ok());
    });
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    await expect(store.activate('1.2.0')).rejects.toThrow(/disk full|activate/i);
  });
});

// ---------------------------------------------------------------------------
// currentVersion / listReleases
// ---------------------------------------------------------------------------
describe('ReleaseStore.currentVersion', () => {
  it('returns the basename of the readlink target', async () => {
    const run = vi.fn().mockResolvedValue(ok('releases/2.0.0\n'));
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(await store.currentVersion()).toBe('2.0.0');
    expect(run).toHaveBeenCalledWith('sudo', ['-u', 'trust', 'readlink', '/opt/trust/current']);
  });

  it('returns null when readlink fails (no current symlink)', async () => {
    const run = vi.fn().mockResolvedValue(fail());
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(await store.currentVersion()).toBeNull();
  });
});

describe('ReleaseStore.listReleases', () => {
  it('returns [] when the releases dir does not exist (fresh install)', async () => {
    const run = vi.fn().mockResolvedValue(fail('No such file or directory'));
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(await store.listReleases()).toEqual([]);
  });

  it('parses ls -1 output into an array of version names', async () => {
    const run = vi.fn().mockResolvedValue(ok('1.0.0\n1.1.0\n1.2.0\n'));
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    expect(await store.listReleases()).toEqual(['1.0.0', '1.1.0', '1.2.0']);
    expect(run).toHaveBeenCalledWith('sudo', ['-u', 'trust', 'ls', '-1', '/opt/trust/releases']);
  });
});

// ---------------------------------------------------------------------------
// prune — brief's named scenario: prune(2) with 4 releases keeps
// current + previous + the newest remaining one.
// ---------------------------------------------------------------------------
describe('ReleaseStore.prune', () => {
  /** A tiny stateful fake `run` modeling releases/ + the current symlink, so
   * activate() and prune() can be exercised together realistically. */
  function makeFakeFs(initialReleases: string[], initialCurrentTarget: string | null) {
    let currentTarget = initialCurrentTarget;
    const releases = new Set(initialReleases);
    const run = vi.fn(async (cmd: string, args: string[]): Promise<RunResult> => {
      if (cmd !== 'sudo') return ok();
      const tool = args[2];
      if (tool === 'readlink') {
        return currentTarget ? ok(`${currentTarget}\n`) : fail();
      }
      if (tool === 'ln') {
        // argv: ['-u', user, 'ln', '-sfn', <target>, <linkPath>] — target is index 4.
        currentTarget = args[4] as string;
        return ok();
      }
      if (tool === 'ls') {
        const names = [...releases].sort();
        return ok(names.length ? names.join('\n') + '\n' : '');
      }
      if (tool === 'rm') {
        const dest = args[args.length - 1] as string;
        const version = dest.split('/').pop() as string;
        releases.delete(version);
        return ok();
      }
      return ok();
    });
    return { run: run as unknown as RunFn, releases };
  }

  it('prune(2) with 4 releases preserves current + previous + the newest remaining one', async () => {
    const { run } = makeFakeFs(['1.0.0', '1.1.0', '1.2.0', '1.3.0'], 'releases/1.2.0');
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });

    // Establish current=1.3.0, previous=1.2.0 via a real activate() call —
    // prune() only protects the previous tracked by the LAST activate().
    const { previous } = await store.activate('1.3.0');
    expect(previous).toBe('1.2.0');

    const deleted = await store.prune(2);
    expect(deleted).toEqual(['1.0.0']);
    expect((await store.listReleases()).sort()).toEqual(['1.1.0', '1.2.0', '1.3.0']);
    expect(await store.currentVersion()).toBe('1.3.0');
  });

  it('never deletes current, even with keep=0', async () => {
    const { run } = makeFakeFs(['1.0.0', '1.1.0'], 'releases/1.1.0');
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    const deleted = await store.prune(0);
    expect(deleted).toEqual(['1.0.0']);
    expect(await store.listReleases()).toEqual(['1.1.0']);
    expect(await store.currentVersion()).toBe('1.1.0');
  });

  it('when previous is unknown (no prior activate on this instance), only current is protected', async () => {
    const { run } = makeFakeFs(['1.0.0', '1.1.0', '1.2.0'], 'releases/1.2.0');
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    // keep=1 with no known previous: retains current + newest 1 non-current.
    const deleted = await store.prune(1);
    expect(deleted).toEqual(['1.0.0']);
    expect((await store.listReleases()).sort()).toEqual(['1.1.0', '1.2.0']);
  });

  it('rejects a negative keep', async () => {
    const run = vi.fn();
    const store = new ReleaseStore({ run, appRoot: '/opt/trust', user: 'trust' });
    await expect(store.prune(-1)).rejects.toThrow(/non-negative integer/i);
    expect(run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration: a REAL local run (no sudo) against a real tmpdir, exercising
// the actual `mkdir`/`tar`/`ln`/`readlink`/`ls`/`rm` binaries. Mirrors
// archon's differ.test pattern of exercising real fs/tool behavior rather
// than only mocked commands.
// ---------------------------------------------------------------------------

/**
 * A RunFn that strips a leading `sudo -u <user>` prefix and executes the
 * real underlying tool directly as the current process user. ReleaseStore
 * always issues `sudo -u <user> <tool> ...` (see class doc comment); in CI
 * there's no sudo and no `trust` user, so this local run makes the exact
 * same argv ReleaseStore would issue in production actually execute against
 * a scratch tmpdir owned by the test process.
 */
function makeLocalRun(): RunFn {
  return (cmd: string, args: string[]) =>
    new Promise<RunResult>((resolve) => {
      let realCmd = cmd;
      let realArgs = args;
      if (cmd === 'sudo' && args[0] === '-u') {
        realCmd = args[2] as string;
        realArgs = args.slice(3);
      }
      const p = spawn(realCmd, realArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      p.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    });
}

/** Build a real gzipped tarball fixture (a tiny release: api/, web/,
 * manifest.json) via the real `tar` binary, and return its bytes + sha256. */
async function buildTarballFixture(version: string): Promise<{ tarball: Buffer; sha256: string }> {
  const src = await mkdtemp(join(tmpdir(), 'trust-release-src-'));
  await mkdir(join(src, 'api'), { recursive: true });
  await mkdir(join(src, 'web'), { recursive: true });
  await writeFile(join(src, 'api', 'server.js'), 'console.log("api")');
  await writeFile(join(src, 'web', 'index.html'), '<html></html>');
  await writeFile(join(src, 'manifest.json'), JSON.stringify({ version }));

  const out = join(tmpdir(), `trust-fixture-${version}-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-czf', out, '-C', src, '.']);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar fixture build failed: exit ${code}`))));
    p.on('error', reject);
  });
  const tarball = await readFile(out);
  const digest = sha256(tarball);
  await rm(src, { recursive: true, force: true });
  await rm(out, { force: true });
  return { tarball, sha256: digest };
}

describe('ReleaseStore — real local run integration (no sudo)', () => {
  it('full cycle: beginUpload -> appendChunk -> commitUpload -> activate -> currentVersion -> rollback-flip', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'trust-approot-'));
    const run = makeLocalRun();
    const user = process.env['USER'] ?? process.env['LOGNAME'] ?? 'nobody';
    const store = new ReleaseStore({ run, appRoot, user });

    try {
      // --- Release 1.2.0: upload in 3 out-of-order chunks, commit, activate.
      const { tarball, sha256: digest1 } = await buildTarballFixture('1.2.0');
      const third = Math.ceil(tarball.length / 3);
      const chunks = [tarball.subarray(0, third), tarball.subarray(third, third * 2), tarball.subarray(third * 2)];

      store.beginUpload('1.2.0', 3);
      store.appendChunk('1.2.0', 2, chunks[2] as Buffer);
      store.appendChunk('1.2.0', 0, chunks[0] as Buffer);
      store.appendChunk('1.2.0', 1, chunks[1] as Buffer);
      await store.commitUpload('1.2.0', digest1);

      expect(await store.listReleases()).toEqual(['1.2.0']);

      const act1 = await store.activate('1.2.0');
      expect(act1.previous).toBeNull();
      expect(await store.currentVersion()).toBe('1.2.0');

      // The symlink really flipped, and the target is RELATIVE.
      const link1 = await readlink(join(appRoot, 'current'));
      expect(link1).toBe('releases/1.2.0');

      // Extracted content is really on disk under the app-owned dest.
      const manifestPath = join(appRoot, 'releases', '1.2.0', 'manifest.json');
      const manifestContent = JSON.parse(await readFile(manifestPath, 'utf-8')) as { version: string };
      expect(manifestContent.version).toBe('1.2.0');

      // --- Release 1.3.0: single-chunk upload, activate (previous=1.2.0).
      const { tarball: tarball2, sha256: digest2 } = await buildTarballFixture('1.3.0');
      store.beginUpload('1.3.0', 1);
      store.appendChunk('1.3.0', 0, tarball2);
      await store.commitUpload('1.3.0', digest2);

      const act2 = await store.activate('1.3.0');
      expect(act2.previous).toBe('1.2.0');
      expect(await store.currentVersion()).toBe('1.3.0');

      // --- Rollback-flip: activate back to 1.2.0, verify the symlink really
      // flips back and previous now reports 1.3.0.
      const act3 = await store.activate('1.2.0');
      expect(act3.previous).toBe('1.3.0');
      expect(await store.currentVersion()).toBe('1.2.0');
      const link2 = await readlink(join(appRoot, 'current'));
      expect(link2).toBe('releases/1.2.0');

      // --- prune(1): current=1.2.0, previous=1.3.0 (both protected) — with
      // only 2 releases total, nothing is old enough to prune.
      expect(await store.prune(1)).toEqual([]);
      expect((await store.listReleases()).sort()).toEqual(['1.2.0', '1.3.0']);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  }, 20000);

  it('commitUpload really rejects a tampered/mismatched sha256 and never touches appRoot', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'trust-approot-'));
    const run = makeLocalRun();
    const user = process.env['USER'] ?? process.env['LOGNAME'] ?? 'nobody';
    const store = new ReleaseStore({ run, appRoot, user });

    try {
      const { tarball } = await buildTarballFixture('9.9.9');
      store.beginUpload('9.9.9', 1);
      store.appendChunk('9.9.9', 0, tarball);
      await expect(store.commitUpload('9.9.9', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'))
        .rejects.toThrow(/sha256 mismatch/i);

      expect(await store.listReleases()).toEqual([]);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  }, 20000);

  it('commitUpload cleans up a half-extracted release dir when the REAL tar fails on a corrupt archive', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'trust-approot-'));
    const run = makeLocalRun();
    const user = process.env['USER'] ?? process.env['LOGNAME'] ?? 'nobody';
    const store = new ReleaseStore({ run, appRoot, user });

    try {
      // Not a valid gzip/tar stream — sha256 verification passes (it's just
      // hashing whatever bytes were uploaded), but the real `tar -xzf` call
      // fails once mkdir has already created the release dir. This is the
      // exact failure mode the cleanup-on-failure fix targets.
      const garbage = Buffer.from('this is not a valid gzip tarball, just plain bytes');
      const digest = sha256(garbage);
      store.beginUpload('7.7.7', 1);
      store.appendChunk('7.7.7', 0, garbage);
      await expect(store.commitUpload('7.7.7', digest)).rejects.toThrow(/tar -xzf/i);

      // dest was never left behind, half-extracted or otherwise.
      expect(await store.listReleases()).toEqual([]);
      await expect(access(join(appRoot, 'releases', '7.7.7'))).rejects.toThrow();
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  }, 20000);
});
