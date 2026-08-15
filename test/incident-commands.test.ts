// Path: test/incident-commands.test.ts
// Covers what `znvault trust incident …` actually DOES: which endpoint each
// command calls, with which body, and what it prints.
//
// Every dependency is injected (`IncidentCommandDeps`), so no test here touches
// a real vault, a real TOTP clock, a real git checkout, or the network — `fetch`
// itself is a fake that records every request. Same pattern as
// commands-run.test.ts, which fakes tar/upload/lease for the deploy path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerIncidentCommands, type IncidentCommandDeps } from '../src/cli/incident/commands.js';

const PASSWORD = 'the-import-bot-password';
const SEED = 'JBSWY3DPEHPK3PXP';

interface RecordedCall {
  method: string;
  url: string;
  init?: RequestInit;
}

type RouteHandler = (call: RecordedCall) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Fake `fetch` dispatching on `"<METHOD> <path fragment>"`. Insertion order
 * matters: `POST /api/v1/incidents/ingest` must be registered before
 * `POST /api/v1/incidents`, since the match is a substring test.
 */
function makeFetch(routes: Record<string, RouteHandler>) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { method: (init?.method ?? 'GET').toUpperCase(), url, init };
    calls.push(call);
    for (const [key, handler] of Object.entries(routes)) {
      const [method, fragment] = key.split(' ');
      if (call.method === method && url.includes(fragment!)) return handler(call);
    }
    return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
  });
  return Object.assign(fn, { calls });
}

function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>;
}

function makeCtx() {
  return {
    client: { get: vi.fn(), post: vi.fn() },
    output: {
      success: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      table: vi.fn(),
      keyValue: vi.fn(),
    },
    getConfig: () => ({ url: 'http://localhost' }),
    isPlainMode: () => true,
  };
}

/** Everything the reporter printed, in one string, for leak assertions. */
function allOutput(ctx: ReturnType<typeof makeCtx>): string {
  return (['success', 'error', 'warn', 'info'] as const)
    .flatMap((k) => ctx.output[k].mock.calls.map((c) => String(c[0])))
    .concat(ctx.output.table.mock.calls.map((c) => JSON.stringify(c)))
    .concat(ctx.output.keyValue.mock.calls.map((c) => JSON.stringify(c)))
    .join('\n');
}

const LOGIN_OK: Record<string, RouteHandler> = { 'POST /auth/login': () => json({ token: 'session-jwt' }) };

let emitted: string[];

function makeDeps(routes: Record<string, RouteHandler>, overrides: Partial<IncidentCommandDeps> = {}) {
  const fetchFn = makeFetch({ ...LOGIN_OK, ...routes });
  const deps: IncidentCommandDeps & { fetchFn: typeof fetchFn } = {
    fetchFn,
    resolveCredentials: vi.fn(async () => ({ email: 'import-bot@example.com', password: PASSWORD, totpSecret: SEED })),
    totp: vi.fn(async () => '123456'),
    repoContext: () => ({ repo: 'teltonika-gateway', root: '/src/teltonika-gateway', commit: 'abc1234' }),
    env: { TRUST_API: 'https://trust.example.test' },
    emit: (text: string) => emitted.push(text),
    readFile: vi.fn(async () => Buffer.from('# nothing\n')),
    ...overrides,
  };
  return deps;
}

function run(ctx: ReturnType<typeof makeCtx>, deps: IncidentCommandDeps, argv: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  const trust = program.command('trust');
  const incident = trust.command('incident');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerIncidentCommands(incident, ctx as any, deps);
  return program.parseAsync(['node', 'znvault', 'trust', 'incident', ...argv]);
}

beforeEach(() => {
  emitted = [];
});

describe('incident capture — candidate path', () => {
  it('posts to /api/v1/security-events with a derived, deterministic id and prints it for reuse', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) });

    await run(ctx, deps, ['capture', '--summary', 'etcd filled to 2GB', '--type', 'outage', '--severity', 'CRITICAL']);

    const post = deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/security-events'));
    const body = bodyOf(post);
    expect(body.sourceEventId).toMatch(/^teltonika-gateway\/etcd-filled-to-2gb@[0-9a-f]{8}$/);
    expect(body.type).toBe('outage');
    expect(body.severity).toBe('CRITICAL');
    expect(body.summary).toBe('etcd filled to 2GB');
    expect(allOutput(ctx)).toContain(`id: ${String(body.sourceEventId)}`);
  });

  it('re-capturing the same finding sends the same id, so the API can dedupe instead of duplicating', async () => {
    const ids: unknown[] = [];
    const routes = { 'POST /api/v1/security-events': (c: RecordedCall) => (ids.push(bodyOf(c).sourceEventId), json({ id: 'evt-1', created: false })) };
    await run(makeCtx(), makeDeps(routes), ['capture', '--summary', 'clock skew on vault-3']);
    await run(makeCtx(), makeDeps(routes), ['capture', '--summary', '  Clock   skew on vault-3 ']);
    expect(ids[0]).toBe(ids[1]);
  });

  it('reports an already-existing candidate as an update, not a failure', async () => {
    const ctx = makeCtx();
    await run(ctx, makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: false }) }), [
      'capture',
      '--summary',
      'clock skew',
    ]);
    expect(allOutput(ctx)).toMatch(/already existed — updated, not duplicated/);
    expect(ctx.output.error).not.toHaveBeenCalled();
  });

  it('honours an explicit --id over the derived one', async () => {
    const deps = makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) });
    await run(makeCtx(), deps, ['capture', '--summary', 'x', '--id', 'manual/key@deadbeef']);
    expect(bodyOf(deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/security-events'))).sourceEventId).toBe('manual/key@deadbeef');
  });

  it('attaches the repository and commit as detail without being asked, and merges explicit --detail', async () => {
    const deps = makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) });
    await run(makeCtx(), deps, ['capture', '--summary', 'x', '--detail', 'file=src/pool.ts:184', '--detail', 'who=diego']);
    const detail = bodyOf(deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/security-events'))).detail as Record<string, unknown>;
    expect(detail).toMatchObject({ repo: 'teltonika-gateway', commit: 'abc1234', file: 'src/pool.ts:184', who: 'diego' });
  });

  it('rejects a --detail that is not key=value, with an example', async () => {
    const ctx = makeCtx();
    await expect(run(ctx, makeDeps({}), ['capture', '--summary', 'x', '--detail', 'justakey'])).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/key=value/);
  });

  it('WARNS about control codes the server dropped and still reports success — a mistyped code never costs the capture', async () => {
    const ctx = makeCtx();
    await run(
      ctx,
      makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true, droppedControlCodes: ['A.5.99'] }) }),
      ['capture', '--summary', 'x', '--control', 'A.5.99', '--control', 'A.8.16'],
    );
    expect(ctx.output.warn).toHaveBeenCalled();
    expect(String(ctx.output.warn.mock.calls[0]?.[0])).toContain('A.5.99');
    expect(ctx.output.success).toHaveBeenCalled();
    expect(ctx.output.error).not.toHaveBeenCalled();
  });

  it('translates an incident severity into the candidate vocabulary rather than refusing the capture', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) });
    await run(ctx, deps, ['capture', '--summary', 'x', '--severity', 'high']);
    expect(bodyOf(deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/security-events'))).severity).toBe('CRITICAL');
    expect(String(ctx.output.warn.mock.calls[0]?.[0])).toMatch(/incident severity/);
  });

  it('refuses an unknown severity, naming both vocabularies', async () => {
    const ctx = makeCtx();
    await expect(run(ctx, makeDeps({}), ['capture', '--summary', 'x', '--severity', 'SEVERE'])).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/INFO\/WARNING\/CRITICAL/);
  });

  it('says what to pass when neither --summary nor --file is given', async () => {
    const ctx = makeCtx();
    await expect(run(ctx, makeDeps({}), ['capture'])).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/--summary .*--file/s);
  });

  it('normalises --occurred-at and rejects a non-ISO one with an example', async () => {
    const deps = makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) });
    await run(makeCtx(), deps, ['capture', '--summary', 'x', '--occurred-at', '2026-08-15T09:41:02Z']);
    expect(bodyOf(deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/security-events'))).occurredAt).toBe('2026-08-15T09:41:02.000Z');

    const ctx = makeCtx();
    await expect(run(ctx, makeDeps({}), ['capture', '--summary', 'x', '--occurred-at', 'yesterday'])).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/ISO-8601/);
  });
});

describe('incident capture — post-mortem path', () => {
  const POSTMORTEM = [
    '# etcd filled the disk and took Patroni down',
    '',
    '## Timeline',
    '- 09:41:02 first alert',
    '- 09:43:10 failover began',
    '',
    '## Root cause',
    'no auto-compaction',
  ].join('\n');

  it('uses the idempotent ingest endpoint, keyed on the file path', async () => {
    const deps = makeDeps({ 'POST /api/v1/incidents/ingest': () => json({ id: 'inc-1', created: true, droppedControlCodes: [] }) }, {
      readFile: vi.fn(async () => Buffer.from(POSTMORTEM)),
    });
    await run(makeCtx(), deps, ['capture', '--file', '/src/teltonika-gateway/docs/POSTMORTEM-2026-06-13-etcd.md', '--severity', 'HIGH']);

    const call = deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/incidents/ingest'));
    expect(call).toBeTruthy();
    const body = bodyOf(call);
    // Keyed on the path relative to the repo root, POSIX separators.
    expect(body.ingestKey).toMatch(/^teltonika-gateway\/docs\/POSTMORTEM-2026-06-13-etcd\.md@[0-9a-f]{8}$/);
    expect(body.title).toBe('etcd filled the disk and took Patroni down');
    expect(body.severity).toBe('HIGH');
    expect(body.timeline).toHaveLength(2);
  });

  it('lets --summary override the title read from the document', async () => {
    const deps = makeDeps({ 'POST /api/v1/incidents/ingest': () => json({ id: 'inc-1', created: true }) }, {
      readFile: vi.fn(async () => Buffer.from(POSTMORTEM)),
    });
    await run(makeCtx(), deps, ['capture', '--file', 'docs/pm.md', '--summary', 'A better title']);
    expect(bodyOf(deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/incidents/ingest'))).title).toBe('A better title');
  });

  it('ingests a document with no recognisable timeline, warning instead of failing', async () => {
    const ctx = makeCtx();
    await run(
      ctx,
      makeDeps({ 'POST /api/v1/incidents/ingest': () => json({ id: 'inc-1', created: true }) }, {
        readFile: vi.fn(async () => Buffer.from('# Just prose\n\nIt broke, we fixed it.')),
      }),
      ['capture', '--file', 'docs/pm.md'],
    );
    expect(String(ctx.output.warn.mock.calls[0]?.[0])).toMatch(/No timeline section recognised/);
    expect(ctx.output.success).toHaveBeenCalled();
  });

  it('surfaces droppedControlCodes from ingest as a warning, keeping the incident', async () => {
    const ctx = makeCtx();
    await run(
      ctx,
      makeDeps({ 'POST /api/v1/incidents/ingest': () => json({ id: 'inc-1', created: true, droppedControlCodes: ['A.9.9'] }) }, {
        readFile: vi.fn(async () => Buffer.from(POSTMORTEM)),
      }),
      ['capture', '--file', 'docs/pm.md', '--control', 'A.9.9'],
    );
    expect(String(ctx.output.warn.mock.calls.map((c) => c[0]).join(' '))).toContain('A.9.9');
    expect(ctx.output.error).not.toHaveBeenCalled();
  });

  it('reports an unreadable file against the file, not against the API', async () => {
    const ctx = makeCtx();
    await expect(
      run(ctx, makeDeps({}, { readFile: vi.fn(async () => { throw new Error('ENOENT'); }) }), ['capture', '--file', 'nope.md']),
    ).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/Could not read the post-mortem/);
  });
});

describe('authentication', () => {
  it('logs in once and reuses the session token for the request', async () => {
    const deps = makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) });
    await run(makeCtx(), deps, ['capture', '--summary', 'x']);
    expect(deps.fetchFn.calls.filter((c) => c.url.endsWith('/auth/login'))).toHaveLength(1);
    const post = deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/security-events'));
    expect((post?.init?.headers as Record<string, string>).authorization).toBe('Bearer session-jwt');
  });

  it('re-authenticates exactly once on a 401 and then gives up — never loops', async () => {
    let attempts = 0;
    const deps = makeDeps({
      'POST /api/v1/security-events': () => {
        attempts += 1;
        return new Response('unauthorized', { status: 401 });
      },
    });
    const ctx = makeCtx();
    await expect(run(ctx, deps, ['capture', '--summary', 'x'])).rejects.toThrow();
    expect(attempts).toBe(2);
    expect(deps.fetchFn.calls.filter((c) => c.url.endsWith('/auth/login'))).toHaveLength(2);
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/clock|credential/i);
  });

  it('generates the TOTP code at login time, never caching one that would expire', async () => {
    const deps = makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) });
    await run(makeCtx(), deps, ['capture', '--summary', 'x']);
    expect(deps.totp).toHaveBeenCalledTimes(1);
    expect(bodyOf(deps.fetchFn.calls.find((c) => c.url.endsWith('/auth/login'))).totpToken).toBe('123456');
  });

  it('never prints the password, the seed or the session token', async () => {
    const ctx = makeCtx();
    await run(ctx, makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) }), [
      'capture',
      '--summary',
      'x',
      '--json',
    ]);
    const printed = `${allOutput(ctx)}\n${emitted.join('\n')}`;
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain(SEED);
    expect(printed).not.toContain('session-jwt');
  });

  it('surfaces a login failure with an instruction about the seed and the clock', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ 'POST /auth/login': () => new Response('bad credentials', { status: 401 }) });
    await expect(run(ctx, deps, ['capture', '--summary', 'x'])).rejects.toThrow();
    const message = String(ctx.output.error.mock.calls[0]?.[0]);
    expect(message).toMatch(/BASE32 TOTP SEED/);
    expect(message).toMatch(/clock/);
    expect(message).not.toContain(PASSWORD);
  });
});

describe('incident list', () => {
  const INCIDENTS = [
    { id: 'inc-1', title: 'etcd outage', severity: 'CRITICAL', status: 'CLOSED', createdAt: '2026-06-13T09:00:00.000Z' },
  ];
  const EVENTS = [
    { id: 'evt-1', sourceEventId: 'a/b@1', type: 'outage', severity: 'CRITICAL', summary: 'unpromoted', receivedAt: '2026-08-01T00:00:00.000Z', incident: null },
    { id: 'evt-2', sourceEventId: 'a/c@2', type: 'outage', severity: 'WARNING', summary: 'already promoted', receivedAt: '2026-08-02T00:00:00.000Z', incident: { id: 'inc-9' } },
  ];

  it('lists incidents as a table, passing the filters through as query params', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ 'GET /api/v1/incidents': () => json(INCIDENTS) });
    await run(ctx, deps, ['list', '--status', 'closed', '--severity', 'critical']);
    const url = deps.fetchFn.calls.find((c) => c.url.includes('/api/v1/incidents'))!.url;
    expect(url).toContain('severity=CRITICAL');
    expect(url).toContain('status=CLOSED');
    expect(ctx.output.table).toHaveBeenCalled();
  });

  it('--pending shows only candidates no human has promoted yet', async () => {
    const ctx = makeCtx();
    await run(ctx, makeDeps({ 'GET /api/v1/security-events': () => json(EVENTS) }), ['list', '--pending']);
    const rows = ctx.output.table.mock.calls[0]?.[1] as unknown[][];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toBe('evt-1');
  });

  it('refuses to mix --pending with --status, which belongs to incidents', async () => {
    const ctx = makeCtx();
    await expect(run(ctx, makeDeps({}), ['list', '--pending', '--status', 'OPEN'])).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/Use one or the other/);
  });

  it('--json prints the payload and nothing else', async () => {
    const ctx = makeCtx();
    await run(ctx, makeDeps({ 'GET /api/v1/incidents': () => json(INCIDENTS) }), ['list', '--json']);
    expect(ctx.output.table).not.toHaveBeenCalled();
    expect(ctx.output.info).not.toHaveBeenCalled();
    expect(JSON.parse(emitted.join(''))).toMatchObject({ mode: 'incidents', count: 1 });
  });

  it('says where to look when nothing matches', async () => {
    const ctx = makeCtx();
    await run(ctx, makeDeps({ 'GET /api/v1/incidents': () => json([]) }), ['list']);
    expect(String(ctx.output.info.mock.calls[0]?.[0])).toMatch(/--pending/);
  });
});

describe('incident show', () => {
  it('shows an incident, with its timeline', async () => {
    const ctx = makeCtx();
    await run(
      ctx,
      makeDeps({
        'GET /api/v1/incidents/inc-1': () =>
          json({ id: 'inc-1', title: 'etcd', severity: 'HIGH', status: 'OPEN', createdAt: '2026-06-13T09:00:00.000Z', timeline: [{ note: 'first alert', createdAt: '2026-06-13T09:41:00.000Z' }] }),
      }),
      ['show', 'inc-1'],
    );
    expect(ctx.output.keyValue).toHaveBeenCalled();
    expect(ctx.output.table).toHaveBeenCalled();
  });

  it('falls back to the candidate surface when the id is not an incident', async () => {
    const ctx = makeCtx();
    await run(
      ctx,
      makeDeps({
        'GET /api/v1/incidents/evt-1': () => new Response('nope', { status: 404 }),
        'GET /api/v1/security-events/evt-1': () => json({ id: 'evt-1', sourceEventId: 'a/b@1', type: 'outage', severity: 'CRITICAL', summary: 's', receivedAt: '2026-08-01T00:00:00.000Z', incident: null }),
      }),
      ['show', 'evt-1'],
    );
    const shown = ctx.output.keyValue.mock.calls[0]?.[0] as Record<string, string>;
    expect(shown.promoted).toMatch(/awaiting a human decision/);
  });

  it('tells you how to find the id when it matches nothing', async () => {
    const ctx = makeCtx();
    await expect(
      run(ctx, makeDeps({
        'GET /api/v1/incidents/zzz': () => new Response('', { status: 404 }),
        'GET /api/v1/security-events/zzz': () => new Response('', { status: 404 }),
      }), ['show', 'zzz']),
    ).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/incident list/);
  });
});

describe('incident promote (human)', () => {
  it('posts the human decision — severity and regime — to the promote endpoint', async () => {
    const deps = makeDeps({ 'POST /api/v1/security-events/evt-1/promote': () => json({ id: 'inc-7', created: true }) });
    await run(makeCtx(), deps, ['promote', 'evt-1', '--severity', 'high', '--regime', 'gdpr-breach']);
    const body = bodyOf(deps.fetchFn.calls.find((c) => c.url.includes('/promote')));
    expect(body).toEqual({ severity: 'HIGH', regime: 'GDPR_BREACH' });
  });

  it('reports an already-promoted candidate without failing', async () => {
    const ctx = makeCtx();
    await run(ctx, makeDeps({ 'POST /api/v1/security-events/evt-1/promote': () => json({ id: 'inc-7', created: false }) }), [
      'promote',
      'evt-1',
      '--severity',
      'HIGH',
    ]);
    expect(String(ctx.output.success.mock.calls[0]?.[0])).toMatch(/already promoted/);
  });

  it('refuses an unknown regime, naming the valid ones', async () => {
    const ctx = makeCtx();
    await expect(run(ctx, makeDeps({}), ['promote', 'evt-1', '--severity', 'HIGH', '--regime', 'PCI'])).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/ISO_27001, GDPR_BREACH/);
  });
});

describe('incident timeline', () => {
  it('appends an entry with a normalised occurredAt', async () => {
    const deps = makeDeps({ 'POST /api/v1/incidents/inc-1/timeline': () => json({ id: 'tl-1' }) });
    await run(makeCtx(), deps, ['timeline', 'inc-1', '--at', '2026-06-13T09:41:02Z', '--what', 'first alert']);
    expect(bodyOf(deps.fetchFn.calls.find((c) => c.url.includes('/timeline')))).toEqual({
      note: 'first alert',
      occurredAt: '2026-06-13T09:41:02.000Z',
    });
  });

  it('rejects a --at that is not a timestamp, with an example', async () => {
    const ctx = makeCtx();
    await expect(run(ctx, makeDeps({}), ['timeline', 'inc-1', '--at', 'this morning', '--what', 'x'])).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/--at 'this morning' is not a valid timestamp/);
  });
});

describe('incident evidence', () => {
  it('uploads the file, links it to the incident, and prints the local sha256', async () => {
    const ctx = makeCtx();
    const deps = makeDeps({
      'POST /api/v1/evidence/manual': () => json({ snapshotId: 'snap-1' }),
      'POST /api/v1/incidents/inc-1/evidence': () => json({ ok: true }),
    }, { readFile: vi.fn(async () => Buffer.from('packet capture bytes')) });

    await run(ctx, deps, ['evidence', 'inc-1', '--file', '/tmp/capture.pcap', '--control', 'A.8.15', '--note', 'the capture']);

    const upload = deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/evidence/manual'));
    expect(upload?.init?.body).toBeInstanceOf(FormData);
    const form = upload?.init?.body as FormData;
    expect(form.get('controlCodes')).toBe('["A.8.15"]');
    expect(form.get('note')).toBe('the capture');
    expect(bodyOf(deps.fetchFn.calls.find((c) => c.url.endsWith('/api/v1/incidents/inc-1/evidence')))).toEqual({ snapshotId: 'snap-1' });
    // sha256("packet capture bytes")
    expect(allOutput(ctx)).toMatch(/sha256: [0-9a-f]{64}/);
  });

  it('warns when no control is given, but still attaches the evidence', async () => {
    const ctx = makeCtx();
    await run(
      ctx,
      makeDeps({
        'POST /api/v1/evidence/manual': () => json({ snapshotId: 'snap-1' }),
        'POST /api/v1/incidents/inc-1/evidence': () => json({ ok: true }),
      }),
      ['evidence', 'inc-1', '--file', '/tmp/x.log'],
    );
    expect(String(ctx.output.warn.mock.calls[0]?.[0])).toMatch(/maps to no Annex A control/);
    expect(ctx.output.success).toHaveBeenCalled();
  });
});

describe('incident close (human)', () => {
  function closeRoutes(status: string, transitions: string[]) {
    return {
      'GET /api/v1/incidents/inc-1': () => json({ id: 'inc-1', status }),
      'POST /api/v1/incidents/inc-1/timeline': () => json({ id: 'tl-1' }),
      'POST /api/v1/incidents/inc-1/corrective-actions': () => json({ id: 'capa-1' }),
      'POST /api/v1/incidents/inc-1/transition': (c: RecordedCall) => (transitions.push(String(bodyOf(c).to)), json({ id: 'inc-1' })),
    };
  }

  it('walks an OPEN incident forward through the server state machine instead of failing on OPEN → CLOSED', async () => {
    const transitions: string[] = [];
    await run(makeCtx(), makeDeps(closeRoutes('OPEN', transitions)), ['close', 'inc-1', '--root-cause', 'no auto-compaction']);
    expect(transitions).toEqual(['RESOLVED', 'CLOSED']);
  });

  it('records the root cause on the timeline BEFORE the state change', async () => {
    const transitions: string[] = [];
    const deps = makeDeps(closeRoutes('INVESTIGATING', transitions));
    await run(makeCtx(), deps, ['close', 'inc-1', '--root-cause', 'etcd never auto-compacted']);
    const order = deps.fetchFn.calls.filter((c) => c.method === 'POST' && c.url.includes('/inc-1/')).map((c) => c.url);
    expect(order[0]).toMatch(/\/timeline$/);
    expect(bodyOf(deps.fetchFn.calls.find((c) => c.url.endsWith('/timeline')))).toEqual({
      note: 'Root cause: etcd never auto-compacted',
      occurredAt: undefined,
    });
  });

  it('opens one corrective action per --action, at the given priority', async () => {
    const transitions: string[] = [];
    const deps = makeDeps(closeRoutes('RESOLVED', transitions));
    await run(makeCtx(), deps, [
      'close', 'inc-1', '--root-cause', 'x', '--action', 'enable auto-compaction', '--action', 'alert on db size', '--action-priority', 'HIGH',
    ]);
    const capas = deps.fetchFn.calls.filter((c) => c.url.endsWith('/corrective-actions')).map((c) => bodyOf(c));
    expect(capas).toEqual([
      { title: 'enable auto-compaction', priority: 'HIGH' },
      { title: 'alert on db size', priority: 'HIGH' },
    ]);
    expect(transitions).toEqual(['CLOSED']);
  });

  it('still records the analysis on an already-CLOSED incident, warning that no transition was needed', async () => {
    const ctx = makeCtx();
    const transitions: string[] = [];
    await run(ctx, makeDeps(closeRoutes('CLOSED', transitions)), ['close', 'inc-1', '--root-cause', 'x']);
    expect(transitions).toEqual([]);
    expect(String(ctx.output.warn.mock.calls[0]?.[0])).toMatch(/already CLOSED/);
  });

  it('tells you to promote first when the id is still a candidate', async () => {
    const ctx = makeCtx();
    await expect(
      run(ctx, makeDeps({ 'GET /api/v1/incidents/evt-1': () => new Response('', { status: 404 }) }), [
        'close', 'evt-1', '--root-cause', 'x',
      ]),
    ).rejects.toThrow();
    expect(String(ctx.output.error.mock.calls[0]?.[0])).toMatch(/promote it first/);
  });

  it('--json reports the walk it performed', async () => {
    const transitions: string[] = [];
    await run(makeCtx(), makeDeps(closeRoutes('OPEN', transitions)), ['close', 'inc-1', '--root-cause', 'x', '--json']);
    expect(JSON.parse(emitted.join(''))).toMatchObject({ id: 'inc-1', from: 'OPEN', transitions: ['RESOLVED', 'CLOSED'] });
  });
});

describe('api url resolution', () => {
  it('prefers --api-url over $TRUST_API', async () => {
    const deps = makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) });
    await run(makeCtx(), deps, ['capture', '--summary', 'x', '--api-url', 'http://localhost:3000/']);
    expect(deps.fetchFn.calls[0]?.url).toBe('http://localhost:3000/auth/login');
  });

  it('falls back to $TRUST_API', async () => {
    const deps = makeDeps({ 'POST /api/v1/security-events': () => json({ id: 'evt-1', created: true }) });
    await run(makeCtx(), deps, ['capture', '--summary', 'x']);
    expect(deps.fetchFn.calls[0]?.url).toBe('https://trust.example.test/auth/login');
  });
});
