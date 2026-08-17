// Path: src/cli/provider/commands.ts
//
// `znvault trust provider register` — the only way to register a TrustProvider.
//
// WHY A COMMAND AND NOT A CLICK: the portal has no registration screen. Its
// providers UI lists what exists and offers SYNC NOW, and the single provider
// in the database came from a seed that hardcodes `manual`. Before this, adding
// one meant a hand-written SQL INSERT — which has to supply `id` and
// `updatedAt` itself and, worse, leaves no PROVIDER_REGISTERED entry in the
// hash-chained audit log. An ISMS whose providers appear without a trace is not
// one an auditor can lean on.
//
// The manifest is read from a FILE, never typed. It has to match byte for byte
// what the provider signs, or the first manifest pull reports `itemCount = 1`
// and any evidence ingested in between was mapped against something else.

import type { Command } from 'commander';
import type { CLIPluginContext } from '@zincapp/znvault-deploy-core';
import { readFile as readFileAsync } from 'node:fs/promises';
import { TrustIncidentClient, TrustApiError } from '../incident/client.js';
import { resolveTrustCredentials } from '../incident/credentials.js';
import { getErrorMessage } from '../../utils/error.js';

export interface ProviderCommandDeps {
  env?: NodeJS.ProcessEnv;
  resolveCredentials?: typeof resolveTrustCredentials;
  fetchFn?: ConstructorParameters<typeof TrustIncidentClient>[0]['fetchFn'];
  totp?: ConstructorParameters<typeof TrustIncidentClient>[0]['totp'];
  readFile?: (path: string) => Promise<Buffer>;
}

interface RegisterOptions {
  service: string;
  baseUrl: string;
  manifest: string;
  webhookMaxSilence?: string;
  apiUrl?: string;
  json?: boolean;
}

const DEFAULT_API_URL = 'https://trust.zincapp.com';

function resolveApiUrl(option: string | undefined, env: NodeJS.ProcessEnv): string {
  return option ?? env.TRUST_API ?? DEFAULT_API_URL;
}

/**
 * Read and validate the manifest file.
 *
 * Validated here rather than left to the API because the failure it prevents is
 * silent: a manifest that parses but is the wrong shape registers fine and only
 * shows up later as evidence mapped to nothing.
 */
export async function loadManifest(
  path: string,
  readFile: (p: string) => Promise<Buffer>,
): Promise<Record<string, unknown>> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (err) {
    throw new Error(`Could not read the manifest '${path}': ${getErrorMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf-8'));
  } catch (err) {
    throw new Error(`The manifest '${path}' is not valid JSON: ${getErrorMessage(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The manifest '${path}' must be a JSON object, not ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`);
  }
  const manifest = parsed as Record<string, unknown>;
  for (const field of ['service', 'trustContractVersion', 'evidenceTypes'] as const) {
    if (!(field in manifest)) {
      throw new Error(
        `The manifest '${path}' has no '${field}'. Export it from the provider's own source ` +
        `(for vault: src/routes/trust/manifest.ts) rather than writing it by hand — it must match ` +
        `byte for byte what the provider signs.`,
      );
    }
  }
  return manifest;
}

/**
 * Warn when the manifest names a different service than the flag.
 *
 * `service` decides the alias of the HMAC secret
 * (`trust/providers/<service>/manifest-secret`), so a mismatch does not fail
 * loudly: the sync job dies looking for a secret that is not there, BEFORE it
 * can write a SyncLog, and the portal shows nothing at all.
 */
export function serviceMismatch(flag: string, manifest: Record<string, unknown>): string | null {
  const declared = manifest.service;
  if (typeof declared !== 'string' || declared === flag) return null;
  return `The manifest declares service '${declared}' but --service says '${flag}'.`;
}

async function runRegister(
  ctx: CLIPluginContext,
  options: RegisterOptions,
  deps: ProviderCommandDeps | undefined,
): Promise<void> {
  const env = deps?.env ?? process.env;
  const readFile = deps?.readFile ?? ((p: string) => readFileAsync(p));
  const manifestJson = await loadManifest(options.manifest, readFile);

  const mismatch = serviceMismatch(options.service, manifestJson);
  if (mismatch) throw new Error(`${mismatch} Registering with the wrong service name leaves the sync job unable to find its signing secret.`);

  let webhookMaxSilence: number | undefined;
  if (options.webhookMaxSilence !== undefined) {
    webhookMaxSilence = Number(options.webhookMaxSilence);
    if (!Number.isInteger(webhookMaxSilence)) {
      throw new Error(`--webhook-max-silence must be an integer number of seconds, got '${options.webhookMaxSilence}'.`);
    }
  }

  const resolve = deps?.resolveCredentials ?? resolveTrustCredentials;
  const credentials = await resolve(ctx.client, env);
  const client = new TrustIncidentClient({
    apiUrl: resolveApiUrl(options.apiUrl, env),
    credentials,
    fetchFn: deps?.fetchFn,
    totp: deps?.totp,
  });

  let result;
  try {
    result = await client.registerProvider({
      service: options.service,
      baseUrl: options.baseUrl,
      manifestJson,
      ...(webhookMaxSilence === undefined ? {} : { webhookMaxSilence }),
    });
  } catch (err) {
    // A 403 here is not a bug to work around: registering a provider decides
    // what the ISMS will trust. Say which identity was refused and what the
    // options are, instead of leaving an operator guessing at a bare 403.
    if (err instanceof TrustApiError && err.status === 403) {
      throw new Error(
        `The Trust portal refused this account: ${err.body}\n` +
        `Registering a provider requires ADMIN; the default automation account (import-bot) is MANAGER.\n` +
        `Either point the command at an ADMIN credential with $TRUST_CREDENTIAL_ALIAS, ` +
        `or grant that role deliberately and write down why.`,
      );
    }
    throw err;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...result, service: options.service, baseUrl: options.baseUrl })}\n`);
    return;
  }
  ctx.output.success(`${result.created ? 'Registered' : 'Updated'} provider '${options.service}' (${result.id})`);
  ctx.output.info(`  baseUrl: ${options.baseUrl}`);
  ctx.output.info('');
  ctx.output.info('It starts as REGISTERED, not ACTIVE: that is earned by the first successful pull.');
  ctx.output.info('Next: restart the portal worker (repeatable jobs are only scheduled at boot),');
  ctx.output.info('then run a sync and check the MANIFEST log shows itemCount=0 — meaning the manifest');
  ctx.output.info('you registered is byte-identical to the one the provider signs.');
}

export function registerProviderCommands(
  provider: Command,
  ctx: CLIPluginContext,
  deps?: ProviderCommandDeps,
): void {
  provider
    .command('register')
    .description('Register a TrustProvider so the portal starts pulling evidence from it')
    .requiredOption('--service <name>', "Stable service id, e.g. 'vault'. Decides the HMAC secret alias")
    .requiredOption('--base-url <url>', 'HTTPS base URL of the provider /trust/* surface')
    .requiredOption('--manifest <path>', "JSON file holding the provider's manifest, exported from its source")
    .option('--webhook-max-silence <seconds>', 'Webhook silence tolerated before the provider is flagged')
    .option('--api-url <url>', `Trust portal API (default: $TRUST_API or ${DEFAULT_API_URL})`)
    .option('--json', 'Machine-readable output')
    .action(async (options: RegisterOptions) => {
      await runRegister(ctx, options, deps);
    });
}
