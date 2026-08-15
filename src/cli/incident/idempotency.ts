// Path: src/cli/incident/idempotency.ts
//
// Deterministic derivation of the idempotency key (`sourceEventId` for a
// candidate, `ingestKey` for a post-mortem).
//
// The whole capture design rests on one property: THE SAME FINDING MUST PRODUCE
// THE SAME KEY. The API is idempotent on it (`@@unique([providerId,
// sourceEventId])` for events, a stored `ingestKey` for ingest), so a key that
// is stable makes a re-capture a no-op and a key that is not turns every re-run
// into a duplicate row in the register an auditor reads. A random id or one
// seeded from the clock would silently destroy that property, so neither is used
// anywhere in this file — `Math.random`, `Date.now` and uuid are all absent by
// design.
//
// Shape follows the design doc's recommendation, `<repo>/<path-or-slug>@<hash>`:
//
//   teltonika-gateway/gateway-dropped-every-codec8-frame@3f7a21c9
//   trust/docs-postmortems-2026-06-13-root-ca.md@9b40e1d2
//
// The human-readable middle makes the key greppable in the portal; the trailing
// hash makes it collision-safe after the middle is truncated.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, sep } from 'node:path';

/** `ingestKey` is `@MaxLength(200)` server-side; stay well inside it. */
const MAX_KEY_LENGTH = 180;

/** Longest human-readable middle segment before the `@<hash>` suffix. */
const MAX_SLUG_LENGTH = 96;

/** Hex characters of SHA-256 kept as the collision guard. */
const HASH_LENGTH = 8;

/** Injection seam so tests never shell out to git or touch a real cwd. */
export interface RepoContextDeps {
  /** Run a git command in `cwd`, returning trimmed stdout, or undefined if git failed. */
  git?: (args: string[], cwd: string) => string | undefined;
  cwd?: () => string;
}

/**
 * Lowercase, hyphen-separated, ASCII-safe form of arbitrary text.
 *
 * Deliberately lossy and deliberately stable: accents are stripped via NFKD so
 * "cronología" and "cronologia" collapse to the same slug, and any run of
 * non-alphanumerics becomes a single hyphen. Two summaries that differ only in
 * punctuation, case or whitespace therefore share a key — which is what "the
 * same finding" means in practice when it is retyped a week later.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/** Whitespace/case-normalised text used as hash input, so the hash is as stable as the slug. */
function normalizeForHash(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function shortHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, HASH_LENGTH);
}

/** Git timeout: long enough for a cold FS cache, short enough not to stall a capture. */
const GIT_TIMEOUT_MS = 5000;

function runGit(args: string[], cwd: string): string | undefined {
  try {
    // stderr is discarded on purpose: outside a repository git writes "not a git
    // repository" there, and that is an expected, handled outcome — not
    // something to spill over an operator's incident capture.
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Where the capture is being made from: repository name, root, and commit. */
export interface RepoContext {
  /** Repository name — the git toplevel's basename, or the cwd's if not a repo. */
  repo: string;
  /** Absolute path of the git toplevel, or undefined outside a repository. */
  root?: string;
  /** Short commit sha, or undefined outside a repository / on an empty repo. */
  commit?: string;
}

/**
 * Detect the repository the operator is standing in.
 *
 * Falls back to the working directory's own basename outside a git checkout
 * rather than failing: a capture from `/var/log` during an outage is still worth
 * far more than an error message about git.
 */
export function detectRepoContext(deps: RepoContextDeps = {}): RepoContext {
  const git = deps.git ?? runGit;
  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return { repo: basename(cwd) || 'unknown' };
  return {
    repo: basename(root) || 'unknown',
    root,
    commit: git(['rev-parse', '--short', 'HEAD'], cwd),
  };
}

/** Trim a composed key to the server's length budget without losing the hash. */
function capLength(prefix: string, hash: string): string {
  const suffix = `@${hash}`;
  const room = MAX_KEY_LENGTH - suffix.length;
  return `${prefix.slice(0, room).replace(/[-/]+$/g, '')}${suffix}`;
}

/**
 * Derive a key from the finding's summary — the path taken by
 * `incident capture --summary …` with no `--file`.
 */
export function deriveKeyFromSummary(repo: string, summary: string): string {
  const normalized = normalizeForHash(summary);
  return capLength(`${repo}/${slugify(summary)}`, shortHash(repo, normalized));
}

/**
 * Derive a key from a post-mortem's path — the path taken by
 * `incident capture --file …`.
 *
 * The FILE PATH, not the title, is the identity here: a post-mortem gets its
 * wording edited long after it is written, and re-ingesting an edited document
 * must update the existing incident rather than mint a second one. Paths are
 * taken relative to the repository root and forced to POSIX separators so the
 * same document yields the same key on macOS and on the Linux dev VM.
 */
export function deriveKeyFromFile(repo: string, filePath: string, repoRoot?: string): string {
  const relPath = repoRoot && isAbsolute(filePath) ? relative(repoRoot, filePath) : filePath;
  const posix = relPath.split(sep).join('/').replace(/^\.\//, '').replace(/^\/+/, '');
  return capLength(`${repo}/${posix}`, shortHash(repo, posix.toLowerCase()));
}
