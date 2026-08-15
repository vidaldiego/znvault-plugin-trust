// Path: src/cli/incident/credentials.ts
//
// Credential resolution for `znvault trust incident …`.
//
// The Trust portal has no long-lived service key: the only non-interactive way
// in is a LOCAL account — password + TOTP. Internal humans sign in with Google
// SSO and have no password at all, so automation authenticates as the dedicated
// `import-bot` account whose credential lives in vault at `trust/import-manager`
// with the shape `{ data: { email, password, totpSecret } }`.
//
// THE CREDENTIAL IS NEVER A FLAG. A password or a TOTP seed passed as
// `--password …` lands in `~/.zsh_history` verbatim, which leaks BOTH factors of
// an ISMS account into a world-readable-ish file that is never rotated. There is
// deliberately no flag to pass one; the only inputs are vault (default) and
// environment variables (CI, where the value never reaches a shell history).
//
// Resolution order:
//   1. Explicit `TRUST_EMAIL` / `TRUST_PASSWORD` / `TRUST_TOTP(_SECRET)` env vars.
//   2. `TRUST_CREDENTIALS_JSON` — the captured output of
//      `znvault secret decrypt trust/import-manager --json`, for CI runners that
//      already have it. See `parseJsonAfterBanner` for the trap that hides in
//      that capture.
//   3. Vault, read in-process through the CLI's own authenticated client
//      (`ctx.client`) — the default, and the reason this needs no extra config:
//      the operator is already logged into vault or the command would not run.
//
// Mirrors trust's own `scripts/lib/credentials.ts` (same secret, same field
// aliases, same failure modes) so an operator who has debugged one has debugged
// both.

import type { CLIPluginContext } from '@zincapp/znvault-deploy-core';
import { getErrorMessage } from '../../utils/error.js';

/** Vault alias holding the import-bot credential. Override with `$TRUST_CREDENTIAL_ALIAS`. */
export const DEFAULT_CREDENTIAL_ALIAS = 'trust/import-manager';

/**
 * A resolved Trust login. Either `totpSecret` (the base32 enrollment seed, from
 * which a fresh code is generated at each login) or `totpToken` (a pre-generated
 * 6-digit code) is present — never neither.
 *
 * This object is passed straight to the login call and is never logged,
 * serialised into `--json` output, or included in an error message.
 */
export interface TrustCredentials {
  email: string;
  password: string;
  /** Base32 enrollment seed. Preferred: codes are generated per login attempt. */
  totpSecret?: string;
  /** Pre-generated 6-digit code. Single-use — expires within 30s. */
  totpToken?: string;
}

/**
 * Field names accepted in the vault secret, most specific first. The secret is
 * hand-maintained, so this tolerates the obvious spellings rather than making an
 * operator rename fields to match a CLI.
 */
const FIELD_ALIASES: Record<'email' | 'password' | 'totpSecret', string[]> = {
  email: ['TRUST_EMAIL', 'email', 'user', 'username', 'login'],
  password: ['TRUST_PASSWORD', 'password', 'pass', 'secret'],
  totpSecret: ['TRUST_TOTP_SECRET', 'totpSecret', 'totp_secret', 'totp', 'mfa', 'otp'],
};

/** Envelope keys a decrypted secret may hide its fields behind. */
const PAYLOAD_KEYS = ['value', 'data', 'secret', 'fields'];

/** Base32 as RFC 4648 §6: A-Z and 2-7, optionally `=`-padded. */
const BASE32 = /^[A-Z2-7]+=*$/;

/** Characters that only appear in a placeholder that was never substituted. */
const PLACEHOLDER = /[…]|^\.\.\.$|^<.*>$/;

const VAULT_HINT =
  `The real values live in vault under \`${DEFAULT_CREDENTIAL_ALIAS}\`. ` +
  'Do not paste an example command as-is: substitute every placeholder.';

/**
 * Parses JSON that a CLI printed a banner in front of.
 *
 * `znvault … --json` writes a version/profile line to stdout before the payload
 * unless `-q` is passed, so the obvious `"$(znvault … --json)"` capture is not
 * parseable as-is. Requiring the caller to remember a global flag is exactly the
 * kind of trap this command exists to remove, so tolerate it instead.
 *
 * The scan is LINE-BASED on purpose: the banner itself can start with `[`
 * (`[znvault v4.19.0] [profile: prod]`), so "seek the first bracket in the raw
 * text" lands *inside the banner* and then fails to parse. Returns undefined
 * when nothing parses — the caller owns the error message.
 */
export function parseJsonAfterBanner(raw: string): unknown {
  const lines = raw.trim().split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Also tolerate trailing output printed after the payload.
      const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
      if (end <= 0) continue;
      try {
        return JSON.parse(candidate.slice(0, end + 1));
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Pull the three credential fields out of a decrypted-secret payload, unwrapping
 * one level of `value`/`data`/`secret`/`fields` — the vault decrypt response is
 * `{ id, alias, …, data: { … } }`, but the shape is not part of this command's
 * contract, so accept the bare object too.
 */
export function credentialsFromPayload(parsed: unknown): Record<string, string> {
  let payload = asRecord(parsed);
  if (!payload) return {};
  for (const key of PAYLOAD_KEYS) {
    const inner = asRecord(payload[key]);
    if (inner) {
      payload = inner;
      break;
    }
  }

  const out: Record<string, string> = {};
  for (const [target, aliases] of Object.entries(FIELD_ALIASES)) {
    const hit = aliases.find((a) => typeof payload?.[a] === 'string' && (payload[a] as string).length > 0);
    if (hit) out[target] = payload[hit] as string;
  }
  return out;
}

/** Minimal view of the vault HTTP client the CLI host hands every plugin. */
export type VaultClient = CLIPluginContext['client'];

/**
 * Read + decrypt the import-bot credential through the CLI's own authenticated
 * vault client. Two calls, both already used by `znvault secret decrypt`:
 * resolve the alias to a UUID, then decrypt by UUID.
 */
async function readFromVault(client: VaultClient, alias: string): Promise<Record<string, string>> {
  let secretId: string;
  try {
    const meta = await client.get<{ id: string }>(`/v1/secrets/alias/${encodeURIComponent(alias)}`);
    secretId = meta.id;
  } catch (err) {
    throw new Error(
      `Could not find the Trust credential in vault at alias '${alias}': ${getErrorMessage(err)}. ` +
        `Check you are on the right profile (\`znvault profile list\`) and that the secret exists ` +
        `(\`znvault secret get ${alias}\`). Set $TRUST_CREDENTIAL_ALIAS to read it from a different alias.`,
    );
  }

  let decrypted: unknown;
  try {
    decrypted = await client.post<unknown>(`/v1/secrets/${secretId}/decrypt`, {});
  } catch (err) {
    throw new Error(
      `Could not decrypt the Trust credential '${alias}': ${getErrorMessage(err)}. ` +
        `The account needs the \`secret:decrypt\` permission on it — ask a vault admin to grant it, ` +
        `or export $TRUST_EMAIL/$TRUST_PASSWORD/$TRUST_TOTP_SECRET instead.`,
    );
  }

  const fields = credentialsFromPayload(decrypted);
  if (!fields.email || !fields.password || !fields.totpSecret) {
    const found = Object.keys(fields).join(', ') || '(nothing usable)';
    throw new Error(
      `The vault secret '${alias}' does not hold a complete Trust login (found: ${found}). ` +
        `It must carry email, password and totpSecret — the shape is ` +
        `{"email":"…","password":"…","totpSecret":"…"}.`,
    );
  }
  return fields;
}

/** Reject a value that is still an unsubstituted example placeholder. */
function rejectPlaceholder(name: string, value: string | undefined): void {
  if (value !== undefined && PLACEHOLDER.test(value.trim())) {
    throw new Error(`$${name} is still the placeholder from an example command. ${VAULT_HINT}`);
  }
}

/**
 * Resolve the Trust login, preferring explicit env vars, then a captured
 * `TRUST_CREDENTIALS_JSON`, then vault.
 *
 * Throws with an instruction (not a diagnosis) on every failure path: the two
 * historical failure modes here are a copy-pasted `…` placeholder and confusing
 * the base32 TOTP *seed* with a 6-digit *code*, and both used to surface as
 * otplib's opaque "not base32 encoded string".
 */
export async function resolveTrustCredentials(
  client: VaultClient,
  env: NodeJS.ProcessEnv,
): Promise<TrustCredentials> {
  // An empty (but present) TRUST_CREDENTIALS_JSON means the `$(znvault …)`
  // substitution produced nothing — i.e. that command failed and printed its
  // error to stderr. Saying "credentials are missing" here would send the
  // reader looking in entirely the wrong place.
  if ('TRUST_CREDENTIALS_JSON' in env && !env.TRUST_CREDENTIALS_JSON?.trim()) {
    throw new Error(
      '$TRUST_CREDENTIALS_JSON is empty: the command inside $(…) produced no output, so it failed. ' +
        `Run \`znvault secret decrypt ${DEFAULT_CREDENTIAL_ALIAS} --json\` on its own to see its error. ` +
        '(Global flags like -q go BEFORE the subcommand: `znvault -q secret decrypt …`.)',
    );
  }

  let fromJson: Record<string, string> = {};
  if (env.TRUST_CREDENTIALS_JSON) {
    const parsed = parseJsonAfterBanner(env.TRUST_CREDENTIALS_JSON);
    if (parsed === undefined) {
      throw new Error(
        '$TRUST_CREDENTIALS_JSON is not valid JSON. Expected the output of ' +
          `\`znvault secret decrypt ${DEFAULT_CREDENTIAL_ALIAS} --json\`.`,
      );
    }
    fromJson = credentialsFromPayload(parsed);
  }

  for (const name of ['TRUST_EMAIL', 'TRUST_PASSWORD', 'TRUST_TOTP', 'TRUST_TOTP_SECRET'] as const) {
    rejectPlaceholder(name, env[name]);
  }

  let email = env.TRUST_EMAIL ?? fromJson.email;
  let password = env.TRUST_PASSWORD ?? fromJson.password;
  let totpSecret = env.TRUST_TOTP_SECRET ?? fromJson.totpSecret;
  const totpToken = env.TRUST_TOTP;

  // Nothing supplied by the environment: go to vault, which is the normal path.
  if (!email || !password || (!totpToken && !totpSecret)) {
    const alias = env.TRUST_CREDENTIAL_ALIAS?.trim() || DEFAULT_CREDENTIAL_ALIAS;
    const fromVault = await readFromVault(client, alias);
    email = email ?? fromVault.email;
    password = password ?? fromVault.password;
    totpSecret = totpSecret ?? fromVault.totpSecret;
  }

  if (!email || !password) {
    throw new Error(`No Trust email/password could be resolved. ${VAULT_HINT}`);
  }

  if (totpToken) {
    const code = totpToken.trim();
    if (!/^\d{6}$/.test(code)) {
      throw new Error(
        `$TRUST_TOTP must be the 6-digit code, got ${code.length} character(s). ` +
          'If you have the enrollment seed instead, set $TRUST_TOTP_SECRET and let the CLI generate the code.',
      );
    }
    return { email, password, totpToken: code };
  }

  // Authenticator apps display the seed in spaced, lower-case groups; accept
  // that shape rather than making the operator reformat it.
  const seed = (totpSecret ?? '').replace(/\s+/g, '').toUpperCase();
  if (/^\d{6}$/.test(seed)) {
    throw new Error(
      'The TOTP value looks like a 6-digit code, not the base32 enrollment seed. ' +
        'Put a code in $TRUST_TOTP; the seed belongs in $TRUST_TOTP_SECRET (or in the vault secret).',
    );
  }
  if (!BASE32.test(seed)) {
    throw new Error(`The TOTP value is not a base32 secret. ${VAULT_HINT}`);
  }

  return { email, password, totpSecret: seed };
}

/**
 * Generate the 6-digit code for a login attempt.
 *
 * Loaded lazily so `otplib` is only pulled in when a login actually happens —
 * `znvault trust --help` and every deploy-side command stay untouched. The
 * interop dance covers otplib being CJS: under NodeNext the named export is
 * present, but a `default`-only namespace is the documented fallback.
 */
export async function generateTotpToken(credentials: TrustCredentials): Promise<string> {
  if (credentials.totpToken) return credentials.totpToken;
  if (!credentials.totpSecret) {
    throw new Error('No TOTP secret or code available — cannot complete a Trust login.');
  }
  const mod = (await import('otplib')) as unknown as {
    authenticator?: { generate(secret: string): string };
    default?: { authenticator: { generate(secret: string): string } };
  };
  const authenticator = mod.authenticator ?? mod.default?.authenticator;
  if (!authenticator) {
    throw new Error('otplib did not expose an authenticator — reinstall @zincapp/znvault-plugin-trust.');
  }
  return authenticator.generate(credentials.totpSecret);
}
