// Path: src/release-store.ts
/**
 * ReleaseStore — chunked upload, atomic activation, and rollback-safe pruning
 * of Trust portal releases on a single agent node.
 *
 * Release layout on disk (owned by the app user, e.g. `trust`):
 *
 *   <appRoot>/releases/<version>/{api,web,systemd,manifest.json}
 *   <appRoot>/current -> releases/<version>            (RELATIVE symlink)
 *
 * Every filesystem operation under `appRoot` — reads and writes alike — runs
 * `sudo -u <user> <tool>` through the injected `RunFn`, never directly via
 * Node's `fs` module. This mirrors `TrustManager`'s `sudo systemctl ...`
 * pattern (trust-manager.ts) and is deliberate even for pure reads
 * (`readlink`, `ls`): appRoot is owned by the app user and the agent process
 * that hosts this plugin may not itself have read access to it, so a single
 * consistent "always go through sudo -u <user>" policy is used rather than
 * assuming a particular permission layout survives every deployment.
 *
 * Tool inventory actually issued by this file: `mkdir`, `tar`, `ln`, `rm`,
 * `readlink` (the five named in the task-3 design decisions) **plus `ls`**,
 * needed for `listReleases()` (directory enumeration) and reused for the
 * post-extraction manifest.json presence check and activate()'s
 * dest-exists precondition (see doc comments below for why `ls` was chosen
 * over introducing a second new verb like `test`). Task 6 (sudoers) must
 * allow-list `ls -1 <appRoot>/releases[/*]` alongside the other five.
 *
 * The chunked-upload buffer, by contrast, is PLAIN filesystem I/O with no
 * sudo at all: `/tmp/trust-release-<version>.tgz{.part,}` is owned by the
 * agent/plugin process itself (not by the app user), so no privilege
 * elevation is needed or wanted for it.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { RunFn, RunResult } from './trust-manager.js';

export interface ReleaseStoreDeps {
  run: RunFn;
  appRoot: string;
  user: string;
}

/**
 * Release version strings name filesystem paths directly (`releases/<version>`,
 * the `.tgz` buffer name, the sudo `tar -C <dest>` target) — this is a
 * security boundary, not just cosmetic validation. Must start with an
 * alphanumeric character and contain only alphanumerics, `.`, `_`, `-`.
 * Rejects path separators and `..` traversal outright (neither `/` nor `.`
 * as a leading character are in the allowed set).
 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertValidVersion(version: string): void {
  if (!VERSION_RE.test(version)) {
    throw new Error(`invalid release version ${JSON.stringify(version)}: must match ${VERSION_RE}`);
  }
}

/** Plugin-owned upload buffer location — literal `/tmp`, not `os.tmpdir()`:
 * production trust nodes are Linux hosts where `/tmp` is always present and
 * agent-writable; pinning the literal path keeps the buffer name predictable
 * (and matches the task-3 design decision verbatim) rather than depending on
 * `TMPDIR` env resolution. */
const TMP_DIR = '/tmp';

function bufferPartPath(version: string): string {
  return join(TMP_DIR, `trust-release-${version}.tgz.part`);
}
function bufferTgzPath(version: string): string {
  return join(TMP_DIR, `trust-release-${version}.tgz`);
}

/**
 * Semver-ish comparator for release version strings, used only to pick the
 * "newest of the rest" window in prune(). NOT a strict semver parser —
 * release versions only have to satisfy VERSION_RE, not semver's full
 * grammar, so a best-effort numeric-aware compare is used instead of a hard
 * parse that could throw on a valid-but-non-semver version string.
 *
 * Sort rule: split each version on `.`; compare field by field. When BOTH
 * fields at a position are purely numeric, compare as integers (so "1.10.0"
 * sorts after "1.2.0", unlike a plain string compare). Otherwise (a
 * non-numeric field, or one side ran out of fields) fall back to a plain
 * string compare of that field. Returns <0 if a<b, >0 if a>b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const av = as[i] ?? '';
    const bv = bs[i] ?? '';
    if (av === bv) continue;
    const bothNumeric = /^\d+$/.test(av) && /^\d+$/.test(bv);
    if (bothNumeric) {
      const diff = Number(av) - Number(bv);
      if (diff !== 0) return diff;
      continue;
    }
    return av < bv ? -1 : 1;
  }
  return 0;
}

interface UploadState {
  totalChunks: number;
  chunks: Map<number, Buffer>;
}

export class ReleaseStore {
  private readonly run: RunFn;
  private readonly appRoot: string;
  private readonly user: string;

  /** In-flight chunked uploads, keyed by version. Cleared on commit (success
   * or sha mismatch) — never left dangling across a commitUpload call. */
  private readonly uploads = new Map<string, UploadState>();

  /** The `previous` returned by the most recent activate() call, if any.
   * prune() treats this as protected even if it would otherwise fall outside
   * its keep-newest window — see prune() doc comment. Deliberately simple
   * (only the LAST activate is remembered, not a full history) per the
   * task-3 design decision: "never delete the previous returned by the last
   * activate". `null` until the first activate() call on this instance. */
  private lastPrevious: string | null = null;

  constructor(deps: ReleaseStoreDeps) {
    this.run = deps.run;
    this.appRoot = deps.appRoot;
    this.user = deps.user;
  }

  private releasesDir(): string {
    return join(this.appRoot, 'releases');
  }
  private releaseDir(version: string): string {
    return join(this.appRoot, 'releases', version);
  }
  private currentLink(): string {
    return join(this.appRoot, 'current');
  }

  /** Run `<tool> <args>` as the app user via `sudo -u <user>`. Raw — callers
   * decide how to interpret a non-zero exit (some need custom cleanup, e.g.
   * commitUpload's manifest check; others just want a thrown error, see
   * sudoOrThrow). Argv array only, never a shell string — no interpolation. */
  private sudo(args: string[]): Promise<RunResult> {
    return this.run('sudo', ['-u', this.user, ...args]);
  }

  private async sudoOrThrow(args: string[], what: string): Promise<RunResult> {
    const r = await this.sudo(args);
    if (r.code !== 0) {
      throw new Error(`${what} (exit ${r.code}): ${r.stderr.trim() || 'unknown error'}`);
    }
    return r;
  }

  /**
   * Begin a chunked upload for `version`. Resets/creates in-memory chunk
   * tracking (no disk I/O here — chunks are buffered in memory and flushed
   * to the plugin-owned `/tmp/trust-release-<version>.tgz.part` buffer as a
   * single write at commitUpload() time, once the full set is known to be
   * contiguous and complete). Re-calling beginUpload for a version that
   * already has an in-flight upload discards the old state (last caller
   * wins) — callers are expected to beginUpload once per logical attempt.
   */
  beginUpload(version: string, totalChunks: number): void {
    assertValidVersion(version);
    if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
      throw new Error(`totalChunks must be a positive integer, got ${totalChunks}`);
    }
    this.uploads.set(version, { totalChunks, chunks: new Map() });
  }

  /**
   * Record chunk `index` of an in-flight upload. Chunks may arrive out of
   * order (indexed, not streamed) — commitUpload() enforces that the full
   * contiguous set [0, totalChunks) is present before assembling anything.
   */
  appendChunk(version: string, index: number, data: Buffer): void {
    assertValidVersion(version);
    const state = this.uploads.get(version);
    if (!state) {
      throw new Error(`no upload in progress for release ${version} — call beginUpload first`);
    }
    if (!Number.isInteger(index) || index < 0 || index >= state.totalChunks) {
      throw new Error(`chunk index ${index} out of range for release ${version} (totalChunks=${state.totalChunks})`);
    }
    state.chunks.set(index, data);
  }

  /**
   * Assemble the buffered chunks, verify their sha256, extract as the app
   * user, and verify the extracted release looks real (manifest.json
   * present). Order matters and is security-relevant:
   *
   *   1. Enforce a contiguous, complete chunk set (no gaps).
   *   2. Assemble + write the buffer to the plugin-owned `.tgz.part` path
   *      (plain fs — no sudo yet).
   *   3. Verify sha256 BEFORE any privileged call. Mismatch → delete the
   *      `.tgz.part` buffer and throw. No `sudo` call is ever issued on
   *      this path.
   *   4. Only on a verified match: promote `.tgz.part` -> `.tgz`, then
   *      `sudo -u <user> mkdir -p <dest>`, `sudo -u <user> tar -xzf <tgz>
   *      -C <dest>`, then verify manifest.json is present in the extracted
   *      root (via `ls -1 <dest>`, see class doc comment for why `ls`
   *      rather than `test`). ANY failure once `dest` exists — a failed/
   *      corrupt tar extraction, an unreadable dest, or a missing
   *      manifest.json — triggers `rm -rf <dest>` before the error
   *      propagates: a release directory is never left half-installed for
   *      listReleases()/activate() to pick up. (A failed `mkdir` itself
   *      needs no such cleanup — `dest` was never created.)
   *
   * The `.tgz` buffer is removed (best-effort) once the attempt concludes,
   * success or failure, so `/tmp` never accumulates release tarballs.
   */
  async commitUpload(version: string, sha256: string): Promise<void> {
    assertValidVersion(version);
    const state = this.uploads.get(version);
    if (!state) {
      throw new Error(`no upload in progress for release ${version} — call beginUpload first`);
    }

    const parts: Buffer[] = [];
    for (let i = 0; i < state.totalChunks; i++) {
      const chunk = state.chunks.get(i);
      if (chunk === undefined) {
        throw new Error(`incomplete upload for release ${version}: missing chunk ${i} of ${state.totalChunks}`);
      }
      parts.push(chunk);
    }
    const assembled = Buffer.concat(parts);
    // The in-memory copy is no longer needed once assembled, regardless of
    // whether the rest of commit succeeds — clear it now so a retry after
    // failure requires a fresh beginUpload rather than silently reusing
    // stale chunks.
    this.uploads.delete(version);

    const partPath = bufferPartPath(version);
    const tgzPath = bufferTgzPath(version);
    await fsp.writeFile(partPath, assembled);

    const actual = createHash('sha256').update(assembled).digest('hex');
    if (actual.toLowerCase() !== sha256.toLowerCase()) {
      await fsp.rm(partPath, { force: true });
      throw new Error(`sha256 mismatch for release ${version}: expected ${sha256}, got ${actual}`);
    }

    // Commit point: promote the verified buffer. Everything from here on is
    // a privileged (sudo -u <user>) operation.
    await fsp.rename(partPath, tgzPath);

    const dest = this.releaseDir(version);
    try {
      await this.sudoOrThrow(['mkdir', '-p', dest], `mkdir -p ${dest}`);

      // From here on, `dest` exists — ANY failure (corrupt/failed tar
      // extraction, an unreadable dest, a missing manifest.json) must clean
      // it up before the error propagates. A single catch covers all three,
      // so a mid-extraction failure (the most likely real-world case: a
      // truncated/corrupt archive, disk full) can't leave a half-extracted
      // directory behind for listReleases()/activate() to pick up.
      try {
        await this.sudoOrThrow(['tar', '-xzf', tgzPath, '-C', dest], `tar -xzf ${tgzPath} -C ${dest}`);

        const listing = await this.sudo(['ls', '-1', dest]);
        if (listing.code !== 0) {
          throw new Error(`release ${version}: could not list ${dest} after extraction (exit ${listing.code}): ${listing.stderr.trim() || 'unknown error'}`);
        }
        const entries = listing.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        if (!entries.includes('manifest.json')) {
          throw new Error(`release ${version}: extracted tarball is missing manifest.json under ${dest}`);
        }
      } catch (err) {
        // Best-effort cleanup: if `rm -rf` itself fails too, don't swallow
        // the ORIGINAL error (that's the actionable one) — append a note so
        // an operator knows `dest` may still be lying around.
        const cleanup = await this.sudo(['rm', '-rf', dest]);
        if (cleanup.code !== 0) {
          const originalMessage = err instanceof Error ? err.message : String(err);
          throw new Error(
            `${originalMessage} (additionally, cleanup "rm -rf ${dest}" failed: exit ${cleanup.code}: ${cleanup.stderr.trim() || 'unknown error'})`,
          );
        }
        throw err;
      }
    } finally {
      await fsp.rm(tgzPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Flip `<appRoot>/current` to point at `releases/<version>` (a RELATIVE
   * symlink target — survives appRoot being moved wholesale, e.g. a restore
   * to a new path). `dest` must already exist (i.e. commitUpload'd) — this
   * is checked via listReleases() membership rather than a standalone
   * existence probe, so activate() introduces no additional sudo verb
   * beyond what listReleases already needs.
   *
   * Returns the PREVIOUS active version (basename of the prior `current`
   * target, or null if `current` didn't exist yet) — same extraction logic
   * as currentVersion(). The flip itself is a single `ln -sfn`, atomic on
   * the same filesystem (no temp-symlink-then-rename dance needed).
   */
  async activate(version: string): Promise<{ previous: string | null }> {
    assertValidVersion(version);

    const releases = await this.listReleases();
    if (!releases.includes(version)) {
      throw new Error(`cannot activate release ${version}: not found under ${this.releasesDir()} — commitUpload it first`);
    }

    const previous = await this.currentVersion();

    const relTarget = `releases/${version}`;
    await this.sudoOrThrow(
      ['ln', '-sfn', relTarget, this.currentLink()],
      `activate ${version} (ln -sfn ${relTarget} ${this.currentLink()})`,
    );

    this.lastPrevious = previous;
    return { previous };
  }

  /** `readlink <appRoot>/current` (as the app user) → the basename of the
   * link target, or null if `current` doesn't exist (readlink fails). */
  async currentVersion(): Promise<string | null> {
    const r = await this.sudo(['readlink', this.currentLink()]);
    if (r.code !== 0) return null;
    const target = r.stdout.trim();
    if (!target) return null;
    const segments = target.split('/');
    const base = segments[segments.length - 1];
    return base !== undefined && base !== '' ? base : null;
  }

  /** List release directory names under `<appRoot>/releases`. A non-zero
   * exit from `ls` (most commonly: the releases dir doesn't exist yet on a
   * fresh install) is treated as "no releases", not an error — listing is a
   * pure query and an absent collection is a legitimate empty result. */
  async listReleases(): Promise<string[]> {
    const dir = this.releasesDir();
    const r = await this.sudo(['ls', '-1', dir]);
    if (r.code !== 0) return [];
    return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  }

  /**
   * Delete old release directories, keeping:
   *   - the CURRENT active release (never a deletion candidate at all), and
   *   - the newest `keep` non-current releases (sorted via compareVersions,
   *     descending — see its doc comment for the exact rule), and
   *   - the `previous` returned by the most recent activate() on this
   *     instance, if any, EVEN IF it would otherwise fall outside the
   *     newest-`keep` window (e.g. an operator rolled back to an old
   *     version, making the "previous" release older than several other
   *     retained ones) — a floor guarantee on top of the keep-window, not
   *     an additional budget. With no prior activate() call in this
   *     instance's lifetime, `previous` is unknown and only `current` is
   *     protected.
   *
   * Example: 4 releases, current=v4, previous=v3 (the newest non-current
   * release already), keep=2 → retains {v4, v3, v2} (v3 is within the
   * newest-2 window already; v2 is the second-newest), deletes {v1}.
   *
   * Returns the versions actually deleted (oldest-protected-window first,
   * i.e. in ascending version order as filtered from the sorted list).
   */
  async prune(keep: number): Promise<string[]> {
    if (!Number.isInteger(keep) || keep < 0) {
      throw new Error(`prune: keep must be a non-negative integer, got ${keep}`);
    }
    const released = await this.listReleases();
    const current = await this.currentVersion();
    const nonCurrent = released.filter((v) => v !== current);

    const newestFirst = [...nonCurrent].sort((a, b) => compareVersions(b, a));
    const retained = new Set(newestFirst.slice(0, keep));
    if (this.lastPrevious !== null) retained.add(this.lastPrevious);

    const toDelete = nonCurrent.filter((v) => !retained.has(v));
    const deleted: string[] = [];
    for (const version of toDelete) {
      const dest = this.releaseDir(version);
      await this.sudoOrThrow(['rm', '-rf', dest], `prune rm -rf ${dest}`);
      deleted.push(version);
    }
    return deleted;
  }
}
