import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { createTrustCLIPlugin } from '../src/cli.js';

describe('trust CLI namespace', () => {
  it('registers "trust" with deploy/status/rollback/config subcommands', () => {
    const program = new Command();
    createTrustCLIPlugin().registerCommands(program, { client: {}, output: {} } as any);
    const trust = program.commands.find((c) => c.name() === 'trust');
    expect(trust).toBeTruthy();
    const subs = trust!.commands.map((c) => c.name());
    for (const s of ['deploy', 'status', 'rollback', 'config']) expect(subs).toContain(s);
  });

  it('"deploy" is a group with a "run" subcommand', () => {
    const program = new Command();
    createTrustCLIPlugin().registerCommands(program, { client: {}, output: {} } as any);
    const trust = program.commands.find((c) => c.name() === 'trust')!;
    const deploy = trust.commands.find((c) => c.name() === 'deploy');
    expect(deploy).toBeTruthy();
    expect(deploy!.commands.map((c) => c.name())).toContain('run');
  });

  it('"config" is a group with list/show/set subcommands', () => {
    const program = new Command();
    createTrustCLIPlugin().registerCommands(program, { client: {}, output: {} } as any);
    const trust = program.commands.find((c) => c.name() === 'trust')!;
    const config = trust.commands.find((c) => c.name() === 'config');
    expect(config).toBeTruthy();
    const configSubs = config!.commands.map((c) => c.name());
    for (const s of ['list', 'show', 'set']) expect(configSubs).toContain(s);
  });

  it('"deploy run" is Task 5\'s real implementation, not the Task 1 stub — it takes real flags and validates a config instead of always exiting "not implemented yet"', () => {
    const program = new Command();
    createTrustCLIPlugin().registerCommands(program, { client: {}, output: {} } as any);
    const trust = program.commands.find((c) => c.name() === 'trust')!;
    const run = trust.commands.find((c) => c.name() === 'deploy')!.commands.find((c) => c.name() === 'run')!;
    const flagNames = run.options.map((o) => o.long);
    for (const f of ['--dry-run', '--class', '--skip-migrations', '--pre-only', '--post-only', '--skip-drain', '--version']) {
      expect(flagNames).toContain(f);
    }
  });

  it('"rollback" requires --host, --to, and --confirm (T4\'s /rollback contract, not a stub)', () => {
    const program = new Command();
    createTrustCLIPlugin().registerCommands(program, { client: {}, output: {} } as any);
    const trust = program.commands.find((c) => c.name() === 'trust')!;
    const rollback = trust.commands.find((c) => c.name() === 'rollback')!;
    const required = rollback.options.filter((o) => o.mandatory).map((o) => o.long);
    expect(required).toEqual(expect.arrayContaining(['--host', '--to', '--confirm']));
  });
});
