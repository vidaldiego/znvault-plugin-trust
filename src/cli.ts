// Path: src/cli.ts
// CLI-side entry point: registers the `znvault trust …` command group with
// the znvault CLI plugin host. Mirrors znvault-plugin-archon's src/cli.ts
// structure — a top-level per-deployer group as a peer of `archon`,
// `payara`, etc.

import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CLIPluginContext, CLIPlugin } from '@zincapp/znvault-deploy-core';
import { registerTrustCommands } from './cli/commands.js';

// Read version from package.json at module load time (same pattern as archon).
let pluginVersion = '0.0.0';
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
  pluginVersion = pkg.version ?? '0.0.0';
} catch {
  pluginVersion = '0.0.0';
}

// Re-export CLIPlugin for consumers.
export type { CLIPlugin } from '@zincapp/znvault-deploy-core';

/**
 * Trust CLI plugin.
 *
 * Adds `znvault trust deploy/status/rollback/config` commands.
 */
export function createTrustCLIPlugin(): CLIPlugin {
  return {
    name: 'trust',
    version: pluginVersion,
    description: 'Trust portal deployment commands (release-dir deploy, atomic symlink activation, Prisma migrations)',

    registerCommands(program: Command, ctx: CLIPluginContext): void {
      // Top-level per-deployer group — a peer of `archon`, `payara`, and any
      // future deployer plugin's own top-level group.
      const trust = program
        .command('trust')
        .description('Trust portal deployment & management');

      registerTrustCommands(trust, ctx);
    },
  };
}

// Default export for CLI plugin.
export default createTrustCLIPlugin;
