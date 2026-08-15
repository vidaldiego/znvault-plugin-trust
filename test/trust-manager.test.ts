// Path: test/trust-manager.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TrustManager, resolveConfig } from '../src/trust-manager.js';

const cfg = { service: 'trust-api.service' };

describe('resolveConfig', () => {
  it('applies documented defaults when appRoot/user/journalPath are omitted', () => {
    expect(resolveConfig({})).toEqual({
      appRoot: '/opt/trust',
      user: 'trust',
      journalPath: '/var/lib/zn-vault-agent/trust-deploy-journal.json',
    });
  });

  it('honors explicit appRoot/user overrides, still defaulting journalPath', () => {
    expect(resolveConfig({ appRoot: '/srv/trust', user: 'deploy-user' })).toEqual({
      appRoot: '/srv/trust',
      user: 'deploy-user',
      journalPath: '/var/lib/zn-vault-agent/trust-deploy-journal.json',
    });
  });

  it('honors an explicit journalPath override — NOT derived from appRoot', () => {
    expect(resolveConfig({ appRoot: '/srv/trust', journalPath: '/custom/journal.json' })).toEqual({
      appRoot: '/srv/trust',
      user: 'trust',
      journalPath: '/custom/journal.json',
    });
  });
});

describe('TrustManager verbs', () => {
  it('restart runs sudo systemctl restart <service> exactly', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await new TrustManager(cfg, run).restart();
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'restart', 'trust-api.service']);
  });

  it('start runs sudo systemctl start <service>', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await new TrustManager(cfg, run).start();
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'start', 'trust-api.service']);
  });

  it('stop runs sudo systemctl stop <service>', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await new TrustManager(cfg, run).stop();
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'stop', 'trust-api.service']);
  });

  it('throws when the underlying systemctl call fails (non-zero exit)', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'unit not found' });
    await expect(new TrustManager(cfg, run).restart()).rejects.toThrow(/systemctl restart trust-api\.service failed/);
  });

  it('has no reboot() — deliberately out of scope for trust (unlike archon)', () => {
    const m = new TrustManager(cfg, vi.fn());
    expect((m as unknown as { reboot?: unknown }).reboot).toBeUndefined();
  });
});

describe('TrustManager.status', () => {
  it('parses "active" is-active output', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'active\n', stderr: '' });
    const status = await new TrustManager(cfg, run).status();
    expect(status).toEqual({ active: true, raw: 'active' });
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'is-active', 'trust-api.service']);
  });

  it('parses "inactive" is-active output', async () => {
    const run = vi.fn().mockResolvedValue({ code: 3, stdout: 'inactive\n', stderr: '' });
    const status = await new TrustManager(cfg, run).status();
    expect(status).toEqual({ active: false, raw: 'inactive' });
  });
});

describe('TrustManager.getService — explicit config.service', () => {
  it('normalizes a service name given WITHOUT the .service suffix', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const m = new TrustManager({ service: 'trust-api' }, run);
    expect(await m.getService()).toBe('trust-api.service');
    await m.restart();
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'restart', 'trust-api.service']);
  });

  it('honors a service name given WITH the .service suffix unchanged', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const m = new TrustManager({ service: 'trust-worker.service' }, run);
    expect(await m.getService()).toBe('trust-worker.service');
    await m.restart();
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'restart', 'trust-worker.service']);
  });

  it('explicit config.service skips detection entirely', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await new TrustManager(cfg, run).restart();
    const detectCalls = run.mock.calls.filter(([cmd, args]) => cmd === 'systemctl' && (args as string[]).includes('list-units'));
    expect(detectCalls).toHaveLength(0);
  });
});

describe('TrustManager service auto-detection (config.service omitted)', () => {
  const noService = {};

  it('detects the service via non-sudo list-units, then acts on it', async () => {
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args.includes('list-units')) {
        return Promise.resolve({ code: 0, stdout: 'trust-worker.service loaded active running Trust Portal Worker\n', stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    await new TrustManager(noService, run).restart();
    // detection call is non-sudo:
    expect(run).toHaveBeenCalledWith('systemctl', expect.arrayContaining(['list-units', 'trust-*.service']));
    // the resolved service is what gets restarted:
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'restart', 'trust-worker.service']);
  });

  it('detects only ONCE and caches the result across calls', async () => {
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args.includes('list-units')) {
        return Promise.resolve({ code: 0, stdout: 'trust-api.service loaded active running Trust Portal API\n', stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: 'active', stderr: '' });
    });
    const m = new TrustManager(noService, run);
    await m.getService();
    await m.getService();
    const detectCalls = run.mock.calls.filter(([cmd, args]) => cmd === 'systemctl' && (args as string[]).includes('list-units'));
    expect(detectCalls).toHaveLength(1);
  });

  it('caches across different verb calls too (restart, then status, then stop)', async () => {
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args.includes('list-units')) {
        return Promise.resolve({ code: 0, stdout: 'trust-api.service loaded active running Trust Portal API\n', stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: 'active', stderr: '' });
    });
    const m = new TrustManager(noService, run);
    await m.restart();
    await m.status();
    await m.stop();
    const detectCalls = run.mock.calls.filter(([cmd, args]) => cmd === 'systemctl' && (args as string[]).includes('list-units'));
    expect(detectCalls).toHaveLength(1);
  });

  it('propagates the ambiguity error when >1 trust service exists', async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: 'trust-api.service loaded active running x\ntrust-worker.service loaded active running y\n',
      stderr: '',
    });
    await expect(new TrustManager(noService, run).restart()).rejects.toThrow(/multiple|ambiguous/i);
  });

  it('propagates the "none found" error when no trust service exists', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await expect(new TrustManager(noService, run).status()).rejects.toThrow(/no trust-\*\.service/i);
  });

  it('does NOT cache a failed detection — retries on the next call (no permanent wedge)', async () => {
    let detectCall = 0;
    const run = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'systemctl' && args.includes('list-units')) {
        detectCall += 1;
        // first detection: transient empty result (throws); second: succeeds
        return Promise.resolve(
          detectCall === 1
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 0, stdout: 'trust-worker.service loaded active running Trust Portal Worker\n', stderr: '' },
        );
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    });
    const m = new TrustManager(noService, run);
    await expect(m.restart()).rejects.toThrow(/no trust-\*\.service/i);
    // the failure was NOT cached: the retry detects successfully and acts
    await m.restart();
    expect(run).toHaveBeenCalledWith('sudo', ['systemctl', 'restart', 'trust-worker.service']);
    expect(detectCall).toBe(2);
  });
});
