// Path: test/commands-run.test.ts
// Covers `deploy run`'s real (Task 5) behavior: config validation gates,
// version resolution + skip-if-current, drain/upload/activate/health/ready
// ordering (with the finally re-ready pattern) for the serving class,
// non-blocking poll-to-active for the worker class, the post-deploy
// migration gate, `rollback`'s required --confirm, and validateTrustConfig's
// pure rules (workers-before-api ordering, hostnames coverage).
//
// deploy-core's own executor/haproxy/health/tunnel functions are mocked
// (same pattern as znvault-plugin-archon's test/canary-rollout.test.ts) so
// these tests assert *how commands.ts wires them together*, not their
// internal behavior. tar/upload/migration-lease primitives are injected via
// DeployCommandDeps fakes — no real tar, network, or npx/prisma ever runs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const {
  openTunnelMock,
  setEndpointOverrideMock,
  clearEndpointOverrideMock,
  executeStrategyMock,
  drainServerMock,
  readyServerMock,
  performHealthCheckMock,
  testHAProxyConnectivityMock,
  getUnmappedHostsMock,
  agentGetMock,
  agentPostMock,
  getConfigMock,
} = vi.hoisted(() => ({
  openTunnelMock: vi.fn(),
  setEndpointOverrideMock: vi.fn(),
  clearEndpointOverrideMock: vi.fn(),
  executeStrategyMock: vi.fn(),
  drainServerMock: vi.fn(),
  readyServerMock: vi.fn(),
  performHealthCheckMock: vi.fn(),
  testHAProxyConnectivityMock: vi.fn(),
  getUnmappedHostsMock: vi.fn(),
  agentGetMock: vi.fn(),
  agentPostMock: vi.fn(),
  getConfigMock: vi.fn(),
}));

vi.mock('@zincapp/znvault-deploy-core', async () => {
  const actual = await vi.importActual<typeof import('@zincapp/znvault-deploy-core')>('@zincapp/znvault-deploy-core');
  return {
    ...actual,
    getConfig: getConfigMock,
    agentGet: agentGetMock,
    agentPost: agentPostMock,
    openTunnel: openTunnelMock,
    setEndpointOverride: setEndpointOverrideMock,
    clearEndpointOverride: clearEndpointOverrideMock,
    executeStrategy: executeStrategyMock,
    drainServer: drainServerMock,
    readyServer: readyServerMock,
    performHealthCheck: performHealthCheckMock,
    testHAProxyConnectivity: testHAProxyConnectivityMock,
    getUnmappedHosts: getUnmappedHostsMock,
  };
});

// Import AFTER vi.mock so commands.ts binds to the mocked module.
const { registerTrustCommands, validateTrustConfig } = await import('../src/cli/commands.js');
type TrustDeployConfig = import('../src/cli/commands.js').TrustDeployConfig;
type DeployCommandDeps = import('../src/cli/commands.js').DeployCommandDeps;

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

function makeDeps(overrides: Partial<DeployCommandDeps> = {}): DeployCommandDeps {
  return {
    tarReleaseDir: vi.fn(async () => Buffer.from('fake-tarball-bytes')),
    uploadRelease: vi.fn(async () => undefined),
    chunkPoster: vi.fn(async () => ({})),
    readManifest: vi.fn(async () => JSON.stringify({ version: '2.0.0' })),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

function buildProgram(ctx: ReturnType<typeof makeCtx>, deps?: DeployCommandDeps) {
  const program = new Command();
  program.exitOverride(); // don't process.exit() on commander's own validation errors
  const trust = program.command('trust').description('Trust portal deployment & management');
  registerTrustCommands(trust, ctx as any, deps);
  return program;
}

// Workers listed BEFORE the serving api class — the design-mandated order
// (executeMultiClassDeployment runs classes in array order; the spec
// requires workers to deploy first). See validateTrustConfig's ordering
// warning, tested below.
const baseConfig: TrustDeployConfig = {
  name: 'staging',
  trustRepoPath: '/tmp/trust-repo',
  releaseDir: '/tmp/trust-release',
  port: 9100,
  classes: [
    {
      name: 'workers',
      hosts: ['192.0.2.35'],
      strategy: 'sequential',
      blocking: false,
    },
    {
      name: 'api',
      hosts: ['192.0.2.30', '192.0.2.31'],
      strategy: '1+R',
      healthCheck: { path: '/healthz', port: 3000, expectedStatus: 200, timeout: 5000, retries: 10, retryDelay: 3000 },
      haproxy: {
        hosts: ['198.51.100.20'],
        backend: 'trust_backend',
        serverMap: { '192.0.2.30': 'trust-api-1', '192.0.2.31': 'trust-api-2' },
      },
    },
  ],
  hostnames: {
    '192.0.2.35': 'trust-worker-1',
    '192.0.2.30': 'trust-api-1',
    '192.0.2.31': 'trust-api-2',
  },
};

describe('deploy run — config gates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('errors clearly and exits when migration.roleId is not configured and --skip-migrations is absent', async () => {
    getConfigMock.mockResolvedValue({ ...baseConfig }); // no `migration` field
    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());

    await expect(program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging'])).rejects.toThrow();

    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringMatching(/migration\.roleId is.*required/i));
    expect(openTunnelMock).not.toHaveBeenCalled();
  });

  it('proceeds past the migration gate (no error) when --skip-migrations is passed, even with no migration configured', async () => {
    getConfigMock.mockResolvedValue({ ...baseConfig, tunnel: true });
    executeStrategyMock.mockImplementation(async (_s: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      for (const h of hosts) results.set(h, await deployFn(h));
      return { total: hosts.length, successful: hosts.length, failed: 0, skipped: 0, results, aborted: false };
    });
    testHAProxyConnectivityMock.mockResolvedValue({ success: true, results: [] });
    getUnmappedHostsMock.mockReturnValue([]);
    drainServerMock.mockResolvedValue({ success: true, results: [] });
    readyServerMock.mockResolvedValue({ success: true, results: [] });
    performHealthCheckMock.mockResolvedValue({ success: true, status: 200, attempts: 1, totalTime: 10 });
    agentGetMock.mockResolvedValue({ currentVersion: '1.0.0', active: true });
    agentPostMock.mockResolvedValue({ previous: '1.0.0' });

    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());

    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--skip-migrations']);

    expect(ctx.output.error).not.toHaveBeenCalled();
  });

  it('--dry-run does not open any tunnels', async () => {
    getConfigMock.mockResolvedValue({ ...baseConfig, tunnel: true });
    const ctx = makeCtx();
    const deps = makeDeps();
    const program = buildProgram(ctx, deps);

    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--dry-run', '--skip-migrations']);

    expect(openTunnelMock).not.toHaveBeenCalled();
    expect(deps.tarReleaseDir).not.toHaveBeenCalled();
    expect(deps.uploadRelease).not.toHaveBeenCalled();
  });
});

describe('deploy run — skip already-current hosts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips upload+activate for a host already reporting the target version', async () => {
    getConfigMock.mockResolvedValue({ ...baseConfig });
    agentGetMock.mockResolvedValue({ currentVersion: '2.0.0', active: true, service: 'trust-worker.service', releases: ['2.0.0'], journalOpen: false });
    const deps = makeDeps(); // readManifest resolves version '2.0.0'
    const ctx = makeCtx();
    const program = buildProgram(ctx, deps);

    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'workers', '--skip-migrations']);

    expect(deps.uploadRelease).not.toHaveBeenCalled();
    expect(agentPostMock).not.toHaveBeenCalled();
    expect(ctx.output.info).toHaveBeenCalledWith(expect.stringContaining('already at 2.0.0'));
  });
});

describe('deploy run — canary rollout + HAProxy drain (serving class)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testHAProxyConnectivityMock.mockResolvedValue({ success: true, results: [] });
    getUnmappedHostsMock.mockReturnValue([]);
    drainServerMock.mockResolvedValue({ success: true, results: [] });
    readyServerMock.mockResolvedValue({ success: true, results: [] });
    performHealthCheckMock.mockResolvedValue({ success: true, status: 200, attempts: 1, totalTime: 10 });
    // currentVersion '1.0.0' != resolved target '2.0.0' -> every host uploads+activates.
    agentGetMock.mockResolvedValue({ currentVersion: '1.0.0', active: true });
    agentPostMock.mockResolvedValue({ previous: '1.0.0' });
    getConfigMock.mockResolvedValue({ ...baseConfig });
  });

  it('runs the api (serving) class through executeStrategy with its configured strategy', async () => {
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      for (const h of hosts) results.set(h, await deployFn(h));
      return { total: hosts.length, successful: hosts.length, failed: 0, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());
    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations']);

    expect(executeStrategyMock).toHaveBeenCalledTimes(1);
    const [strategyArg, hostsArg] = executeStrategyMock.mock.calls[0]!;
    expect(strategyArg).toMatchObject({ name: '1+R', isCanary: true });
    expect(hostsArg).toEqual(['192.0.2.30', '192.0.2.31']);
  });

  it('checks status + uploads BEFORE draining, then drains -> activates -> readies, for every host in the serving class', async () => {
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      for (const h of hosts) results.set(h, await deployFn(h));
      return { total: hosts.length, successful: hosts.length, failed: 0, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const deps = makeDeps();
    const program = buildProgram(ctx, deps);
    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations']);

    expect(drainServerMock).toHaveBeenCalledTimes(2);
    expect(readyServerMock).toHaveBeenCalledTimes(2);
    for (const host of ['192.0.2.30', '192.0.2.31']) {
      expect(drainServerMock).toHaveBeenCalledWith(baseConfig.classes![1]!.haproxy, host);
      expect(readyServerMock).toHaveBeenCalledWith(baseConfig.classes![1]!.haproxy, host);
    }

    // The critical ordering fix: upload happens BEFORE the drain window (a
    // host must never sit out of rotation for a version check + a
    // potentially-large tarball upload), and activate/ready happen AFTER
    // drain, inside the window.
    const uploadOrder = (deps.uploadRelease as any).mock.invocationCallOrder[0]!;
    const drainOrder = drainServerMock.mock.invocationCallOrder[0]!;
    const activateOrder = agentPostMock.mock.invocationCallOrder[0]!;
    const readyOrder = readyServerMock.mock.invocationCallOrder[0]!;
    expect(uploadOrder).toBeLessThan(drainOrder);
    expect(drainOrder).toBeLessThan(activateOrder);
    expect(activateOrder).toBeLessThan(readyOrder);
  });

  it('skips a host already at the target version WITHOUT any drainServer/readyServer call', async () => {
    // Both api hosts already report the target version — the skip-check must
    // short-circuit before the drain window is ever entered.
    agentGetMock.mockResolvedValue({ currentVersion: '2.0.0', active: true });
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      for (const h of hosts) results.set(h, await deployFn(h));
      return { total: hosts.length, successful: hosts.length, failed: 0, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const deps = makeDeps();
    const program = buildProgram(ctx, deps);
    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations']);

    expect(drainServerMock).not.toHaveBeenCalled();
    expect(readyServerMock).not.toHaveBeenCalled();
    expect(deps.uploadRelease).not.toHaveBeenCalled();
    expect(agentPostMock).not.toHaveBeenCalled();
  });

  it('a pre-drain upload failure fails the host WITHOUT ever draining it', async () => {
    const deps = makeDeps({ uploadRelease: vi.fn(async () => { throw new Error('upload rejected: disk full'); }) });
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      let failed = 0, successful = 0;
      for (const h of hosts) {
        const r = await deployFn(h);
        results.set(h, r);
        if (r.success) successful++; else failed++;
      }
      return { total: hosts.length, successful, failed, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx, deps);
    // Both hosts fail their (blocking) upload -> the class gate fails ->
    // multi-class run aborts -> process.exit(1) -> thrown under vitest.
    await expect(
      program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations']),
    ).rejects.toThrow();

    expect(drainServerMock).not.toHaveBeenCalled();
    expect(readyServerMock).not.toHaveBeenCalled();
    expect(agentPostMock).not.toHaveBeenCalled(); // never reached /activate either
    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringContaining('upload rejected: disk full'));
  });

  it('re-readies a host in `finally` when the health check fails after a successful drain+activate', async () => {
    performHealthCheckMock.mockImplementationOnce(async () => ({ success: false, error: 'HTTP 503', attempts: 3, totalTime: 30 }));
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      let failed = 0, successful = 0;
      for (const h of hosts) {
        const r = await deployFn(h);
        results.set(h, r);
        if (r.success) successful++; else failed++;
      }
      return { total: hosts.length, successful, failed, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());
    // The api class is blocking (active serverMap) — a health-check failure
    // fails the class gate, which aborts the multi-class run -> process.exit(1)
    // -> (under vitest's threads pool) a thrown error, not a real exit.
    await expect(
      program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations']),
    ).rejects.toThrow();

    expect(drainServerMock).toHaveBeenCalledTimes(2);
    // readyServer must STILL be called for the unhealthy host (via `finally`), plus the healthy one.
    expect(readyServerMock).toHaveBeenCalledTimes(2);
    expect(readyServerMock).toHaveBeenCalledWith(baseConfig.classes![1]!.haproxy, '192.0.2.30');
    expect(readyServerMock).toHaveBeenCalledWith(baseConfig.classes![1]!.haproxy, '192.0.2.31');
  });

  it('a drainServer failure (resolved {success:false}, never a throw) fails the host, never activates, and never calls readyServer', async () => {
    drainServerMock.mockResolvedValue({ success: false, results: [{ host: '198.51.100.20', success: false, error: 'ssh: connection refused' }] });
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      let failed = 0, successful = 0;
      for (const h of hosts) {
        const r = await deployFn(h);
        results.set(h, r);
        if (r.success) successful++; else failed++;
      }
      return { total: hosts.length, successful, failed, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());
    await expect(
      program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations']),
    ).rejects.toThrow();

    expect(agentPostMock).not.toHaveBeenCalled(); // /activate never reached
    expect(readyServerMock).not.toHaveBeenCalled(); // drain never actually succeeded — `drained` stays false, so no ready call at all
    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringContaining('drain failed'));
  });

  it('a readyServer failure after a green drain+activate+health-check marks the host failed, mentioning it may be left drained', async () => {
    readyServerMock
      .mockResolvedValueOnce({ success: false, results: [{ host: '198.51.100.20', success: false, error: 'ssh timeout' }] })
      .mockResolvedValue({ success: true, results: [] }); // the finally recovery re-ready succeeds
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      let failed = 0, successful = 0;
      for (const h of hosts) {
        const r = await deployFn(h);
        results.set(h, r);
        if (r.success) successful++; else failed++;
      }
      return { total: hosts.length, successful, failed, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());
    await expect(
      program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations']),
    ).rejects.toThrow();

    expect(agentPostMock).toHaveBeenCalled(); // activate DID happen — the green path up to ready
    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringMatching(/ready failed.*may be left drained/));
  });

  it('a finally-path re-ready failure (after an earlier failure elsewhere in the try) is logged on its own, without clobbering the original failure', async () => {
    performHealthCheckMock.mockResolvedValueOnce({ success: false, error: 'HTTP 503', attempts: 3, totalTime: 30 });
    readyServerMock.mockResolvedValue({ success: false, results: [{ host: '198.51.100.20', success: false, error: 'ssh: broken pipe' }] });
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      let failed = 0, successful = 0;
      for (const h of hosts) {
        const r = await deployFn(h);
        results.set(h, r);
        if (r.success) successful++; else failed++;
      }
      return { total: hosts.length, successful, failed, skipped: 0, results, aborted: false };
    });

    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());
    await expect(
      program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations']),
    ).rejects.toThrow();

    // The ORIGINAL failure (health check) is still logged...
    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringContaining('health check failed'));
    // ...and the finally-path recovery re-ready failure is logged separately, not silently swallowed.
    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringMatching(/recovery re-ready.*may be left drained/));
  });

  it('does NOT call drainServer/readyServer/executeStrategy for the workers class', async () => {
    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());
    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'workers', '--skip-migrations']);

    expect(drainServerMock).not.toHaveBeenCalled();
    expect(readyServerMock).not.toHaveBeenCalled();
    expect(executeStrategyMock).not.toHaveBeenCalled();
  });

  it('polls worker status up to "active" after activating, non-blocking on timeout', async () => {
    // Worker never reports active -> pollWorkerActive exhausts its attempts,
    // but this must NOT abort the run (worker failures are non-blocking).
    const deps = makeDeps();
    const ctx = makeCtx();
    const program = buildProgram(ctx, deps);

    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'workers', '--skip-migrations']);

    expect(deps.sleep).toHaveBeenCalled();
    expect(ctx.output.warn).toHaveBeenCalledWith(expect.stringContaining('non-blocking'));
    // A non-blocking worker failure must not raise/exit the run.
    expect(ctx.output.error).not.toHaveBeenCalledWith(expect.stringContaining('ABORTED'));
  });
});

describe('deploy run — --skip-drain (serving class runs minus drain/ready only)', () => {
  // Regression coverage: --skip-drain used to reroute api (serving) hosts
  // into the non-blocking WORKER branch (isServing was `hasActiveServerMap
  // && !skipDrain`), so a failed activate landed in workerFailed —
  // deliberately excluded from deploy-core's classGateFailed — and the run
  // exited 0. --skip-drain must instead stay on the SERVING branch and just
  // suppress the drainServer/readyServer calls inside it.
  beforeEach(() => {
    vi.clearAllMocks();
    testHAProxyConnectivityMock.mockResolvedValue({ success: true, results: [] });
    getUnmappedHostsMock.mockReturnValue([]);
    drainServerMock.mockResolvedValue({ success: true, results: [] });
    readyServerMock.mockResolvedValue({ success: true, results: [] });
    performHealthCheckMock.mockResolvedValue({ success: true, status: 200, attempts: 1, totalTime: 10 });
    agentGetMock.mockResolvedValue({ currentVersion: '1.0.0', active: true });
    agentPostMock.mockResolvedValue({ previous: '1.0.0' });
    getConfigMock.mockResolvedValue({ ...baseConfig });
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      let failed = 0, successful = 0;
      for (const h of hosts) {
        const r = await deployFn(h);
        results.set(h, r);
        if (r.success) successful++; else failed++;
      }
      return { total: hosts.length, successful, failed, skipped: 0, results, aborted: false };
    });
  });

  it('a failed activate under --skip-drain still fails/exits the run (does not silently exit 0 via the worker branch)', async () => {
    agentPostMock.mockRejectedValue(new Error('activate rejected: version mismatch'));

    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());
    await expect(
      program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations', '--skip-drain']),
    ).rejects.toThrow();

    expect(drainServerMock).not.toHaveBeenCalled();
    expect(readyServerMock).not.toHaveBeenCalled();
    // still routed through the SERVING branch (executeStrategy), not the non-blocking worker loop:
    expect(executeStrategyMock).toHaveBeenCalledTimes(1);
    expect(ctx.output.error).toHaveBeenCalledWith(expect.stringContaining('activate rejected'));
  });

  it('--skip-drain happy path: no drain/ready calls at all, but the health gate still runs and activate still happens for every host', async () => {
    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());
    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api', '--skip-migrations', '--skip-drain']);

    expect(drainServerMock).not.toHaveBeenCalled();
    expect(readyServerMock).not.toHaveBeenCalled();
    expect(performHealthCheckMock).toHaveBeenCalledTimes(2); // once per api host — the health gate still runs
    expect(agentPostMock).toHaveBeenCalledTimes(2); // activate still happens for both hosts
    expect(ctx.output.error).not.toHaveBeenCalled();
  });
});

describe('deploy run — post-deploy migration gate', () => {
  function fakeRunnerDeps() {
    const events: string[] = [];
    const client = {
      issueCredential: vi.fn(async (roleId: string, o: { ttlSeconds: number }) => {
        events.push(`issue:${roleId}:${o.ttlSeconds}`);
        return { leaseId: `L-${roleId}`, username: 'u', password: 'p', host: 'h', port: 5432, database: 'trust' };
      }),
      revokeCredential: vi.fn(async () => { events.push('revoke'); }),
    };
    const spawn = vi.fn(() => ({
      on(ev: string, cb: (c: number) => void) { if (ev === 'close') setTimeout(() => cb(0), 1); },
      kill() {},
      killed: false,
    }));
    return { events, client, spawn, settleMs: 0 };
  }

  const migratedConfig: TrustDeployConfig = {
    ...baseConfig,
    migration: { roleId: 'dbr_pre', migrationsDir: '/x' },
    postMigration: { roleId: 'dbr_post', migrationsDir: '/y' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    testHAProxyConnectivityMock.mockResolvedValue({ success: true, results: [] });
    getUnmappedHostsMock.mockReturnValue([]);
    drainServerMock.mockResolvedValue({ success: true, results: [] });
    readyServerMock.mockResolvedValue({ success: true, results: [] });
    performHealthCheckMock.mockResolvedValue({ success: true, status: 200, attempts: 1, totalTime: 10 });
    executeStrategyMock.mockImplementation(async (strategy: unknown, hosts: string[], deployFn: (h: string) => Promise<any>) => {
      const results = new Map();
      let failed = 0, successful = 0;
      for (const h of hosts) {
        const r = await deployFn(h);
        results.set(h, r);
        if (r.success) successful++; else failed++;
      }
      return { total: hosts.length, successful, failed, skipped: 0, results, aborted: false };
    });
    agentGetMock.mockResolvedValue({ currentVersion: '1.0.0', active: true });
    agentPostMock.mockResolvedValue({ previous: '1.0.0' });
  });

  it('runs the post-deploy migration phase when the rollout has full coverage and no failures', async () => {
    getConfigMock.mockResolvedValue({ ...migratedConfig });
    const runnerDeps = fakeRunnerDeps();
    const ctx = makeCtx();
    const program = buildProgram(ctx, { ...makeDeps(), runPhaseDeps: runnerDeps as any });

    // Per-host call sequencing: the FIRST GET /status for a host reports the
    // stale version (forces upload+activate); every call after that (i.e.
    // the worker's post-activate poll) reports the new version as active —
    // so the worker's poll-to-active succeeds on its first attempt instead
    // of exhausting all 10 tries (which would register as a non-blocking
    // workerFailed, breaking this test's "no failures" premise).
    const callsPerUrl = new Map<string, number>();
    agentGetMock.mockImplementation(async (url: string) => {
      const n = (callsPerUrl.get(url) ?? 0) + 1;
      callsPerUrl.set(url, n);
      return n === 1 ? { currentVersion: '1.0.0', active: true } : { currentVersion: '2.0.0', active: true };
    });

    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging']);

    expect(runnerDeps.client.issueCredential).toHaveBeenCalledTimes(2); // pre + post
    expect(runnerDeps.events[0]).toBe('issue:dbr_pre:14400');
    expect(runnerDeps.events).toContain('issue:dbr_post:14400');
  });

  it('skips the post-deploy phase with a scoped-subset reason when --class narrows the rollout', async () => {
    getConfigMock.mockResolvedValue({ ...migratedConfig });
    const runnerDeps = fakeRunnerDeps();
    const ctx = makeCtx();
    const program = buildProgram(ctx, { ...makeDeps(), runPhaseDeps: runnerDeps as any });

    await program.parseAsync(['node', 'znvault', 'trust', 'deploy', 'run', 'staging', '--class', 'api']);

    // Only the pre-deploy phase ran — post was gated off (scoped subset).
    expect(runnerDeps.client.issueCredential).toHaveBeenCalledTimes(1);
    expect(runnerDeps.client.issueCredential).toHaveBeenCalledWith('dbr_pre', { ttlSeconds: 14400 });
    expect(ctx.output.info).toHaveBeenCalledWith(expect.stringMatching(/scoped/i));
  });
});

describe('rollback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exits with an error when --confirm is not provided', async () => {
    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());

    await expect(
      program.parseAsync(['node', 'znvault', 'trust', 'rollback', 'staging', '--host', '192.0.2.30', '--to', '1.0.0']),
    ).rejects.toThrow();
  });

  it('tunnels to the target host and POSTs /rollback with toVersion + confirm', async () => {
    getConfigMock.mockResolvedValue({ ...baseConfig, tunnel: true });
    const close = vi.fn().mockResolvedValue(undefined);
    openTunnelMock.mockResolvedValue({ localPort: 45123, close });
    agentPostMock.mockResolvedValue({ previous: '1.0.0' });

    const ctx = makeCtx();
    const program = buildProgram(ctx, makeDeps());
    await program.parseAsync([
      'node', 'znvault', 'trust', 'rollback', 'staging',
      '--host', '192.0.2.30', '--to', '1.0.0', '--confirm', 'trust-api-1',
    ]);

    expect(openTunnelMock).toHaveBeenCalledWith('192.0.2.30', expect.objectContaining({ remotePort: 9100 }));
    expect(agentPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/plugins/trust'),
      { toVersion: '1.0.0', confirm: 'trust-api-1' },
    );
    expect(ctx.output.success).toHaveBeenCalledWith(expect.stringContaining('rolled back to 1.0.0'));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('validateTrustConfig', () => {
  it('accepts a config with the workers class listed before the serving api class and full hostnames coverage', () => {
    const report = validateTrustConfig(baseConfig);
    expect(report.errors).toEqual([]);
  });

  it('errors when a configured host has no hostnames entry', () => {
    const missing: TrustDeployConfig = { ...baseConfig, hostnames: { '192.0.2.30': 'trust-api-1' } };
    const report = validateTrustConfig(missing);
    expect(report.errors.some((e) => e.includes("hostnames['192.0.2.31']"))).toBe(true);
    expect(report.errors.some((e) => e.includes("hostnames['192.0.2.35']"))).toBe(true);
  });

  it('warns when a "workers" class is listed AFTER a serving class', () => {
    const reordered: TrustDeployConfig = { ...baseConfig, classes: [baseConfig.classes![1]!, baseConfig.classes![0]!] };
    const report = validateTrustConfig(reordered);
    expect(report.warnings.some((w) => /workers.*after a serving class/i.test(w))).toBe(true);
  });

  it('errors when trustRepoPath or releaseDir is missing', () => {
    const withoutRepoPath: TrustDeployConfig = { ...baseConfig, trustRepoPath: '' };
    const report = validateTrustConfig(withoutRepoPath);
    expect(report.errors.some((e) => e.includes('trustRepoPath'))).toBe(true);
  });
});
