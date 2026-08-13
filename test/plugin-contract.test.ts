import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import createTrustPlugin, { PLUGIN_VERSION } from '../src/index.js';

// Pins the exact contract zn-vault-agent's PluginLoader.validatePlugin enforces
// (loader.js): the plugin object MUST have a non-empty `name` string, a
// non-empty `version` string, and any of the lifecycle hooks it exposes must be
// functions. A missing `version` is what caused "Plugin must have a version
// property" on archon's first real load — unit tests never exercised the
// loader, so this test stands in for it (see znvault-plugin-archon's
// test/plugin-contract.test.ts, which this file mirrors).
describe('createTrustPlugin — agent loader contract', () => {
  it('is a factory function', () => {
    expect(typeof createTrustPlugin).toBe('function');
  });

  it('returns an object with a non-empty name', () => {
    const p = createTrustPlugin({});
    expect(typeof p.name).toBe('string');
    expect(p.name).toBe('trust');
  });

  it('returns a non-empty version string (loader rejects a missing/blank version)', () => {
    const p = createTrustPlugin({});
    expect(typeof p.version).toBe('string');
    expect(p.version.length).toBeGreaterThan(0);
    // matches the package version read at module load
    expect(p.version).toBe(PLUGIN_VERSION);
  });

  it('PLUGIN_VERSION is a semver string and never the 0.0.0 fallback in a normal build', () => {
    expect(PLUGIN_VERSION).not.toBe('0.0.0');
    expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exposes routes as a function (the only lifecycle hook implemented so far)', () => {
    const p = createTrustPlugin({});
    expect(typeof p.routes).toBe('function');
  });

  it('routes() wires ctx.logger into the journal via setLogger — a stale journal at the configured path re-emits its startup warn through it', async () => {
    // End-to-end proof (not just a DeploymentJournal unit test) that
    // src/index.ts really calls journal.setLogger(ctx.logger) in routes(),
    // since the journal is constructed with no logger at factory time
    // (createTrustPlugin runs before the agent hands over ctx.logger).
    const root = await mkdtemp(join(tmpdir(), 'trust-plugin-contract-'));
    const journalPath = join(root, 'stale-journal.json');
    writeFileSync(journalPath, JSON.stringify({ version: '9.9.9', startedAt: Date.now() }), { mode: 0o600 });

    const p = createTrustPlugin({ journalPath });
    const warn = vi.fn();
    const logger = { info: vi.fn(), error: vi.fn(), warn };

    const fastify = Fastify();
    await p.routes(fastify, { logger });
    await fastify.close();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ version: '9.9.9' }),
      expect.stringContaining('Found an open deployment journal on startup'),
    );

    await rm(root, { recursive: true, force: true });
  });
});
