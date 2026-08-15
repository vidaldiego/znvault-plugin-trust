// Path: test/incident-idempotency.test.ts
// Covers the derivation of the idempotency key and the post-mortem parser.
//
// The key is the load-bearing part of the whole capture design: the API is
// idempotent on it, so a STABLE key makes a re-capture a no-op while an unstable
// one turns every re-run into a duplicate row in the register an auditor reads.
// These tests exist to make a future "just add a timestamp for uniqueness"
// change fail loudly.

import { describe, it, expect } from 'vitest';
import {
  detectRepoContext,
  deriveKeyFromFile,
  deriveKeyFromSummary,
  slugify,
} from '../src/cli/incident/idempotency.js';
import { extractDayHint, parsePostmortem } from '../src/cli/incident/postmortem.js';

describe('slugify', () => {
  it('lower-cases, strips accents and collapses punctuation to single hyphens', () => {
    expect(slugify('Cronología: etcd LLENÓ el disco!!')).toBe('cronologia-etcd-lleno-el-disco');
  });

  it('never leaves a leading or trailing hyphen', () => {
    expect(slugify('  --- what happened? ---  ')).toBe('what-happened');
  });
});

describe('deriveKeyFromSummary', () => {
  const repo = 'teltonika-gateway';
  const summary = 'etcd filled to 2GB and took down Patroni';

  it('is deterministic — the same finding always yields the same key', () => {
    expect(deriveKeyFromSummary(repo, summary)).toBe(deriveKeyFromSummary(repo, summary));
  });

  it('is stable across case, punctuation and whitespace differences in the retyped summary', () => {
    const a = deriveKeyFromSummary(repo, 'etcd filled to 2GB and took down Patroni');
    const b = deriveKeyFromSummary(repo, '  ETCD   filled to 2GB and took down Patroni  ');
    expect(b).toBe(a);
  });

  it('carries the repository and a readable slug, so the key is greppable in the portal', () => {
    expect(deriveKeyFromSummary(repo, summary)).toMatch(/^teltonika-gateway\/etcd-filled-to-2gb-and-took-down-patroni@[0-9a-f]{8}$/);
  });

  it('separates two different findings in the same repository', () => {
    expect(deriveKeyFromSummary(repo, 'disk full')).not.toBe(deriveKeyFromSummary(repo, 'clock skew'));
  });

  it('separates the same finding reported from two different repositories', () => {
    expect(deriveKeyFromSummary('trust', summary)).not.toBe(deriveKeyFromSummary('zn-vault', summary));
  });

  it('stays inside the server-side 200-char limit and keeps the hash when the summary is enormous', () => {
    const key = deriveKeyFromSummary(repo, 'x'.repeat(4000));
    expect(key.length).toBeLessThanOrEqual(180);
    expect(key).toMatch(/@[0-9a-f]{8}$/);
  });

  it('distinguishes two long summaries that share a truncated prefix', () => {
    const prefix = 'the database connection pool was exhausted during the nightly reconciliation job because ';
    const a = deriveKeyFromSummary(repo, `${prefix} of a leaked transaction`);
    const b = deriveKeyFromSummary(repo, `${prefix} of a runaway migration`);
    expect(a).not.toBe(b);
  });
});

describe('deriveKeyFromFile', () => {
  it('keys a post-mortem on its path, so editing its wording still updates the same incident', () => {
    const a = deriveKeyFromFile('trust', 'docs/POSTMORTEM-2026-06-13-root-ca.md');
    const b = deriveKeyFromFile('trust', 'docs/POSTMORTEM-2026-06-13-root-ca.md');
    expect(a).toBe(b);
    expect(a).toMatch(/^trust\/docs\/POSTMORTEM-2026-06-13-root-ca\.md@[0-9a-f]{8}$/);
  });

  it('takes the path relative to the repository root, so an absolute path yields the same key', () => {
    const relative = deriveKeyFromFile('trust', 'docs/pm.md');
    const absolute = deriveKeyFromFile('trust', '/Users/someone/src/trust/docs/pm.md', '/Users/someone/src/trust');
    expect(absolute).toBe(relative);
  });

  it('drops a leading ./ so the same file typed two ways is one incident', () => {
    expect(deriveKeyFromFile('trust', './docs/pm.md')).toBe(deriveKeyFromFile('trust', 'docs/pm.md'));
  });
});

describe('detectRepoContext', () => {
  it('uses the git toplevel basename and the short commit', () => {
    const ctx = detectRepoContext({
      cwd: () => '/src/teltonika-gateway/internal',
      git: (args) => (args[1] === '--show-toplevel' ? '/src/teltonika-gateway' : 'abc1234'),
    });
    expect(ctx).toEqual({ repo: 'teltonika-gateway', root: '/src/teltonika-gateway', commit: 'abc1234' });
  });

  it('falls back to the working directory outside a git checkout — a capture from /var/log still beats no capture', () => {
    const ctx = detectRepoContext({ cwd: () => '/var/log/postgres', git: () => undefined });
    expect(ctx).toEqual({ repo: 'postgres' });
  });
});

describe('parsePostmortem', () => {
  it('takes the title from the first H1 and falls back to the filename', () => {
    expect(parsePostmortem('# Root CA lost after LMK rotation\n\ntext', 'pm.md').title).toBe('Root CA lost after LMK rotation');
    expect(parsePostmortem('no heading here', 'POSTMORTEM-2026-06-13.md').title).toBe('POSTMORTEM-2026-06-13');
  });

  it('reads a list-style cronology and anchors bare times to the date in the filename, keeping the original reading in the note', () => {
    const md = ['# Outage', '', '## Timeline', '- 09:41:02 first alert', '- 09:43:10 failover began', '', '## Root cause', '- unrelated'].join('\n');
    const parsed = parsePostmortem(md, 'POSTMORTEM-2026-06-13-etcd.md');
    expect(parsed.timeline).toEqual([
      { note: '09:41:02 first alert', occurredAt: '2026-06-13T09:41:02.000Z' },
      { note: '09:43:10 failover began', occurredAt: '2026-06-13T09:43:10.000Z' },
    ]);
  });

  it('reads an unzoned time as UTC, so the same document ingests identically from a Mac and from the UTC dev VM', () => {
    const parsed = parsePostmortem('## Timeline\n- 09:41 alert', 'POSTMORTEM-2026-06-13-x.md');
    expect(parsed.timeline[0]?.occurredAt).toBe('2026-06-13T09:41:00.000Z');
  });

  it('stops at the next heading so unrelated sections are not swallowed', () => {
    const md = ['## Cronología', '- 10:00 something', '## Acciones', '- do a thing'].join('\n');
    const parsed = parsePostmortem(md, '2026-01-02-x.md');
    expect(parsed.timeline).toHaveLength(1);
  });

  it('reads a markdown-table cronology and skips its header row', () => {
    const md = ['## Timeline', '| Hora | Suceso |', '|---|---|', '| 09:41 | first alert |', '| 09:45 | mitigated |'].join('\n');
    const parsed = parsePostmortem(md, '2026-06-13-x.md');
    expect(parsed.timeline.map((t) => t.note)).toEqual(['09:41 first alert', '09:45 mitigated']);
    expect(parsed.timeline[0]?.occurredAt).toBe('2026-06-13T09:41:00.000Z');
  });

  it('accepts a full ISO instant without needing a date hint', () => {
    const parsed = parsePostmortem('## Timeline\n- 2026-07-05T14:02:11Z key rotation missed', 'notes.md');
    expect(parsed.timeline[0]).toEqual({ note: 'key rotation missed', occurredAt: '2026-07-05T14:02:11.000Z' });
  });

  it('keeps an unanchored bare time inside the note rather than inventing today as its date', () => {
    const parsed = parsePostmortem('## Timeline\n- 09:41 first alert', 'notes-without-a-date.md');
    expect(parsed.timeline[0]).toEqual({ note: '- 09:41 first alert'.replace('- ', '') });
    expect(parsed.timeline[0]?.occurredAt).toBeUndefined();
  });

  it('returns an empty timeline, not an error, when no cronology section is recognised', () => {
    expect(parsePostmortem('# Title\n\nJust prose.', 'pm.md').timeline).toEqual([]);
  });
});

describe('extractDayHint', () => {
  it('finds the first ISO date across the sources it is given', () => {
    expect(extractDayHint(undefined, 'POSTMORTEM-2026-06-13-root-ca.md')).toBe('2026-06-13');
    expect(extractDayHint('no date here', 'still none')).toBeUndefined();
  });
});
