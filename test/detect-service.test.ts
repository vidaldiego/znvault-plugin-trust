// Path: test/detect-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { detectTrustService } from '../src/detect-service.js';

// list-units output shape mirrors archon's (verified live on a real archon
// node); trust units follow the same systemd unit-file conventions.
const line = (unit: string) => `${unit} loaded active running Trust Portal`;

describe('detectTrustService', () => {
  it('returns the single trust-*.service unit name via a non-sudo list-units query', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: line('trust-worker.service') + '\n', stderr: '' });
    const svc = await detectTrustService(run);
    expect(svc).toBe('trust-worker.service');
    // detection is a read-only query — the ONLY call it makes is a non-sudo
    // `systemctl list-units` (list-units is not in the scoped sudoers allow-list).
    expect(run).toHaveBeenCalledTimes(1);
    const [cmd, args] = run.mock.calls[0]!;
    expect(cmd).toBe('systemctl');
    expect(args).toEqual(expect.arrayContaining(['list-units', '--type=service', 'trust-*.service']));
  });

  it('ignores stale not-found / masked leftovers surfaced by --all (LOAD != loaded)', async () => {
    // `--all` can list a dead reference; only the `loaded` unit is real.
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout:
        'trust-api.service not-found inactive dead trust-api.service\n' +
        line('trust-worker.service') + '\n' +
        'trust-scheduler.service masked inactive dead trust-scheduler.service\n',
      stderr: '',
    });
    expect(await detectTrustService(run)).toBe('trust-worker.service');
  });

  it('finds the single loaded unit among one not-found and one loaded entry (1 not-found + 1 loaded)', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout:
        'trust-api.service not-found inactive dead trust-api.service\n' +
        line('trust-api.service'),
      stderr: '',
    });
    // The `not-found` line and the `loaded` line share a unit name here to
    // prove the filter picks the loaded copy rather than treating them as
    // two distinct entries.
    expect(await detectTrustService(run)).toBe('trust-api.service');
  });

  it('accepts a unit name with the .service suffix as returned by systemctl', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'trust-api.service loaded active running Trust Portal API\n', stderr: '' });
    expect(await detectTrustService(run)).toBe('trust-api.service');
  });

  it('throws a clear error when NO trust service is found', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await expect(detectTrustService(run)).rejects.toThrow(/no trust-\*\.service/i);
  });

  it('throws when MORE THAN ONE trust service is found (ambiguous — require explicit config.service)', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: line('trust-api.service') + '\n' + line('trust-worker.service') + '\n',
      stderr: '',
    });
    await expect(detectTrustService(run)).rejects.toThrow(/multiple|ambiguous/i);
  });

  it('ignores blank lines and systemctl noise', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: '\n  \n' + line('trust-worker.service') + '\n\n',
      stderr: '',
    });
    expect(await detectTrustService(run)).toBe('trust-worker.service');
  });

  it('throws when systemctl itself fails (non-zero exit)', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'Failed to list units: connection refused' });
    await expect(detectTrustService(run)).rejects.toThrow(/list.*units|connection refused/i);
  });
});
