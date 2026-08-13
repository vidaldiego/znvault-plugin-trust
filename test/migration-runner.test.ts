import { describe, it, expect, vi } from 'vitest';
import { composeEphemeralUrl, makeTrustRunPhase } from '../src/cli/migration-runner.js';

describe('composeEphemeralUrl', () => {
  it('percent-encodes user + password and pins sslmode=require, direct port', () => {
    const url = composeEphemeralUrl({
      leaseId: 'l', username: 'v-migrate-x/y', password: 'p@ss:w#rd',
      host: '198.51.100.250', port: 5432, database: 'trust',
    } as any);
    expect(url).toBe('postgresql://v-migrate-x%2Fy:p%40ss%3Aw%23rd@198.51.100.250:5432/trust?sslmode=require');
  });

  it('throws when no database on lease and no override', () => {
    expect(() => composeEphemeralUrl({ leaseId: 'l', username: 'u', password: 'p', host: 'h', port: 5432 } as any))
      .toThrow(/database/i);
  });
});

describe('makeTrustRunPhase orchestration', () => {
  const lease = { leaseId: 'L1', username: 'u', password: 'p', host: 'h', port: 5432, database: 'trust' };

  function deps() {
    const events: string[] = [];
    const client = {
      issueCredential: vi.fn(async (_r, o) => { events.push(`mint:${o.ttlSeconds}`); return lease; }),
      revokeCredential: vi.fn(async () => { events.push('revoke'); }),
    };
    const child = {
      env: undefined as any, killed: false,
      on(ev: string, cb: (c: number) => void) { if (ev === 'close') setTimeout(() => { events.push('child-exit'); cb(0); }, 5); },
      kill() { this.killed = true; },
    };
    const spawn = vi.fn((_c, _a, opts) => { child.env = opts.env; child.cwd = opts.cwd; events.push('spawn'); return child; });
    return { events, client, spawn, settleMs: 0 };
  }

  it('mints 14400s, spawns prisma migrate deploy with cwd=<trustRepoPath>/apps/api and the composed URL, then revokes AFTER child exit', async () => {
    const d = deps();
    const runPhase = makeTrustRunPhase({ output: { info: vi.fn(), warn: vi.fn() } } as any, '/home/operator/src/trust', d as any);
    await runPhase({ roleId: 'dbr_x' } as any, 'pre-deploy', {} as any);

    expect(d.client.issueCredential).toHaveBeenCalledWith('dbr_x', { ttlSeconds: 14400 });

    expect(d.spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = d.spawn.mock.calls[0]!;
    expect(cmd).toBe('npx');
    expect(args).toEqual(['prisma', 'migrate', 'deploy']);
    expect(opts.cwd).toBe('/home/operator/src/trust/apps/api');
    expect(opts.env.DATABASE_URL).toBe('postgresql://u:p@h:5432/trust?sslmode=require');
    expect(opts.env.DIRECT_URL).toBe(opts.env.DATABASE_URL);

    // revoke happens after child-exit, never before
    expect(d.events.indexOf('revoke')).toBeGreaterThan(d.events.indexOf('child-exit'));
  });

  it('revokes the lease even when the migration exits non-zero', async () => {
    const d = deps();
    const failingChild = {
      env: undefined as any, killed: false,
      on(ev: string, cb: (c: number) => void) { if (ev === 'close') setTimeout(() => cb(1), 5); },
      kill() { this.killed = true; },
    };
    d.spawn = vi.fn(() => failingChild) as any;

    const runPhase = makeTrustRunPhase({ output: { info: vi.fn(), warn: vi.fn() } } as any, '/repo', d as any);
    await expect(runPhase({ roleId: 'dbr_x' } as any, 'pre-deploy', {} as any)).rejects.toThrow(/exited 1/);

    expect(d.client.revokeCredential).toHaveBeenCalledWith('L1', { reason: 'migration complete' });
  });

  it('revokes the lease even when spawn itself fails to start', async () => {
    const d = deps();
    const brokenChild = {
      on(ev: string, cb: (err: Error) => void) { if (ev === 'error') setTimeout(() => cb(new Error('ENOENT: npx not found')), 5); },
      kill() {},
      killed: false,
    };
    d.spawn = vi.fn(() => brokenChild) as any;

    const runPhase = makeTrustRunPhase({ output: { info: vi.fn(), warn: vi.fn() } } as any, '/repo', d as any);
    await expect(runPhase({ roleId: 'dbr_x' } as any, 'pre-deploy', {} as any)).rejects.toThrow(/ENOENT/);

    expect(d.client.issueCredential).toHaveBeenCalledTimes(1);
    expect(d.client.revokeCredential).toHaveBeenCalledWith('L1', { reason: 'migration complete' });
  });
});
