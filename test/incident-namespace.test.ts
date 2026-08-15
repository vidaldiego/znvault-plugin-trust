// Path: test/incident-namespace.test.ts
// Covers the shape of `znvault trust incident …` as it appears under
// `znvault trust --help`: that the group is mounted next to deploy/status/
// rollback/config, that every subcommand from design §4.2 exists with the flags
// that section specifies, and that `promote`/`close` are present here even
// though they are deliberately absent from the MCP tool set (§4.3).
//
// Registration only — no network, no vault, no credentials.

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createTrustCLIPlugin } from '../src/cli.js';

function incidentGroup(): Command {
  const program = new Command();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createTrustCLIPlugin().registerCommands(program, { client: {}, output: {} } as any);
  const trust = program.commands.find((c) => c.name() === 'trust')!;
  return trust.commands.find((c) => c.name() === 'incident')!;
}

function sub(name: string): Command {
  return incidentGroup().commands.find((c) => c.name() === name)!;
}

describe('trust incident namespace', () => {
  it('mounts "incident" under "trust", beside deploy/status/rollback/config', () => {
    const program = new Command();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createTrustCLIPlugin().registerCommands(program, { client: {}, output: {} } as any);
    const trust = program.commands.find((c) => c.name() === 'trust')!;
    const subs = trust.commands.map((c) => c.name());
    for (const s of ['deploy', 'status', 'rollback', 'config', 'incident']) expect(subs).toContain(s);
  });

  it('exposes every subcommand from design §4.2', () => {
    const subs = incidentGroup().commands.map((c) => c.name());
    for (const s of ['capture', 'list', 'show', 'promote', 'timeline', 'evidence', 'close']) {
      expect(subs).toContain(s);
    }
  });

  it('"capture" takes the §4.2 flags, including the bulk --file path and the explicit --id', () => {
    const flags = sub('capture').options.map((o) => o.long);
    for (const f of ['--summary', '--type', '--severity', '--control', '--detail', '--file', '--id']) {
      expect(flags).toContain(f);
    }
  });

  it('"capture" has NO flag that would put a credential in shell history', () => {
    const flags = sub('capture').options.map((o) => o.long ?? '');
    for (const forbidden of ['--password', '--token', '--totp', '--totp-secret', '--secret']) {
      expect(flags).not.toContain(forbidden);
    }
  });

  it('"list" filters by status/severity and can show unpromoted candidates', () => {
    const flags = sub('list').options.map((o) => o.long);
    for (const f of ['--status', '--severity', '--pending']) expect(flags).toContain(f);
  });

  it('"promote" requires --severity (the human decision it exists to record)', () => {
    const required = sub('promote').options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toContain('--severity');
  });

  it('"timeline" requires --what and accepts --at', () => {
    const timeline = sub('timeline');
    expect(timeline.options.filter((o) => o.mandatory).map((o) => o.long)).toContain('--what');
    expect(timeline.options.map((o) => o.long)).toContain('--at');
  });

  it('"evidence" requires --file', () => {
    expect(sub('evidence').options.filter((o) => o.mandatory).map((o) => o.long)).toContain('--file');
  });

  it('"close" requires --root-cause and accepts repeatable --action', () => {
    const close = sub('close');
    expect(close.options.filter((o) => o.mandatory).map((o) => o.long)).toContain('--root-cause');
    expect(close.options.map((o) => o.long)).toContain('--action');
  });

  it('promote and close live in the CLI even though §4.3 withholds them from MCP — the asymmetry is the control', () => {
    const subs = incidentGroup().commands.map((c) => c.name());
    expect(subs).toContain('promote');
    expect(subs).toContain('close');
    // Both are described as human acts so `--help` carries the reason.
    expect(sub('promote').description()).toMatch(/HUMAN/);
    expect(sub('close').description()).toMatch(/HUMAN/);
  });

  it('every subcommand supports --json and --api-url for scripting and CI', () => {
    for (const name of ['capture', 'list', 'show', 'promote', 'timeline', 'evidence', 'close']) {
      const flags = sub(name).options.map((o) => o.long);
      expect(flags, `${name} should support --json`).toContain('--json');
      expect(flags, `${name} should support --api-url`).toContain('--api-url');
    }
  });
});
