// Path: test/incident-credentials.test.ts
// Covers credential resolution for `znvault trust incident …`.
//
// Two properties are load-bearing and are asserted explicitly here:
//
//   1. The credential comes from VAULT, not from argv. There is no flag; the
//      only inputs are the vault client and the environment.
//   2. Every failure produces an INSTRUCTION, not a diagnosis — the historical
//      failures (a copy-pasted `…` placeholder, and confusing the base32 seed
//      with a 6-digit code) both used to surface as otplib's opaque "not base32
//      encoded string".
//
// Nothing here touches a real vault or a real network.

import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_CREDENTIAL_ALIAS,
  credentialsFromPayload,
  generateTotpToken,
  parseJsonAfterBanner,
  resolveTrustCredentials,
} from '../src/cli/incident/credentials.js';

const SEED = 'JBSWY3DPEHPK3PXP';

function makeVaultClient(secret: unknown = { data: { email: 'import-bot@zincapp.com', password: 'p4ssw0rd', totpSecret: SEED } }) {
  const get = vi.fn(async (path: string) => {
    if (path.startsWith('/v1/secrets/alias/')) return { id: 'sec-uuid-1' };
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string) => {
    if (path === '/v1/secrets/sec-uuid-1/decrypt') return secret;
    throw new Error(`unexpected POST ${path}`);
  });
  return { get, post } as never as import('../src/cli/incident/credentials.js').VaultClient & {
    get: typeof get;
    post: typeof post;
  };
}

describe('parseJsonAfterBanner', () => {
  it('skips the znvault banner, which itself starts with "[" — the trap a first-bracket scan falls into', () => {
    const raw = '[znvault v4.19.0] [profile: prod]\n{"data":{"email":"a@b.c"}}';
    expect(parseJsonAfterBanner(raw)).toEqual({ data: { email: 'a@b.c' } });
  });

  it('parses a bare payload with no banner at all', () => {
    expect(parseJsonAfterBanner('{"email":"a@b.c"}')).toEqual({ email: 'a@b.c' });
  });

  it('tolerates trailing output printed after the payload', () => {
    const raw = '[znvault v4.19.0]\n{"email":"a@b.c"}\nDone in 0.3s';
    expect(parseJsonAfterBanner(raw)).toEqual({ email: 'a@b.c' });
  });

  it('parses a top-level array payload', () => {
    expect(parseJsonAfterBanner('[banner]\n[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('returns undefined when nothing parses, leaving the message to the caller', () => {
    expect(parseJsonAfterBanner('total gibberish, no json here')).toBeUndefined();
  });
});

describe('credentialsFromPayload', () => {
  it('unwraps one level of data/value/secret/fields', () => {
    expect(credentialsFromPayload({ id: 'x', data: { email: 'a@b.c', password: 'p', totpSecret: SEED } })).toEqual({
      email: 'a@b.c',
      password: 'p',
      totpSecret: SEED,
    });
  });

  it('accepts the alternative field spellings the hand-maintained secret may use', () => {
    expect(credentialsFromPayload({ username: 'a@b.c', pass: 'p', totp: SEED })).toEqual({
      email: 'a@b.c',
      password: 'p',
      totpSecret: SEED,
    });
  });

  it('returns an empty object rather than throwing on a non-object payload', () => {
    expect(credentialsFromPayload('nope')).toEqual({});
  });
});

describe('resolveTrustCredentials', () => {
  it('reads the import-bot credential from vault by default — never from a flag', async () => {
    const client = makeVaultClient();
    const creds = await resolveTrustCredentials(client, {});
    expect(creds).toEqual({ email: 'import-bot@zincapp.com', password: 'p4ssw0rd', totpSecret: SEED });
    expect(client.get).toHaveBeenCalledWith(`/v1/secrets/alias/${encodeURIComponent(DEFAULT_CREDENTIAL_ALIAS)}`);
    expect(client.post).toHaveBeenCalledWith('/v1/secrets/sec-uuid-1/decrypt', {});
  });

  it('honours $TRUST_CREDENTIAL_ALIAS for a differently-placed secret', async () => {
    const client = makeVaultClient();
    await resolveTrustCredentials(client, { TRUST_CREDENTIAL_ALIAS: 'isms/bot' });
    expect(client.get).toHaveBeenCalledWith(`/v1/secrets/alias/${encodeURIComponent('isms/bot')}`);
  });

  it('lets explicit env vars win and does not touch vault at all', async () => {
    const client = makeVaultClient();
    const creds = await resolveTrustCredentials(client, {
      TRUST_EMAIL: 'ci@zincapp.com',
      TRUST_PASSWORD: 'ci-pass',
      TRUST_TOTP_SECRET: SEED,
    });
    expect(creds.email).toBe('ci@zincapp.com');
    expect(client.get).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
  });

  it('accepts a captured $TRUST_CREDENTIALS_JSON, banner and all', async () => {
    const client = makeVaultClient();
    const raw = `[znvault v4.19.0] [profile: prod]\n${JSON.stringify({ data: { email: 'a@b.c', password: 'p', totpSecret: SEED } })}`;
    const creds = await resolveTrustCredentials(client, { TRUST_CREDENTIALS_JSON: raw });
    expect(creds).toEqual({ email: 'a@b.c', password: 'p', totpSecret: SEED });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('names the real cause when $TRUST_CREDENTIALS_JSON is empty (the $(…) command failed)', async () => {
    await expect(resolveTrustCredentials(makeVaultClient(), { TRUST_CREDENTIALS_JSON: '  ' })).rejects.toThrow(
      /produced no output, so it failed/,
    );
  });

  it('rejects an unsubstituted placeholder instead of letting otplib complain about base32', async () => {
    await expect(
      resolveTrustCredentials(makeVaultClient(), { TRUST_EMAIL: 'a@b.c', TRUST_PASSWORD: 'p', TRUST_TOTP_SECRET: '…' }),
    ).rejects.toThrow(/still the placeholder/);
  });

  it('tells you which variable to use when a 6-digit code is put in the seed slot', async () => {
    await expect(
      resolveTrustCredentials(makeVaultClient(), { TRUST_EMAIL: 'a@b.c', TRUST_PASSWORD: 'p', TRUST_TOTP_SECRET: '123456' }),
    ).rejects.toThrow(/\$TRUST_TOTP for a code|Put a code in \$TRUST_TOTP/);
  });

  it('rejects a $TRUST_TOTP that is not six digits, and says where the seed goes', async () => {
    await expect(
      resolveTrustCredentials(makeVaultClient(), { TRUST_EMAIL: 'a@b.c', TRUST_PASSWORD: 'p', TRUST_TOTP: 'ABCDEFGH' }),
    ).rejects.toThrow(/must be the 6-digit code/);
  });

  it('accepts a spaced, lower-case seed as authenticator apps display it', async () => {
    const creds = await resolveTrustCredentials(makeVaultClient(), {
      TRUST_EMAIL: 'a@b.c',
      TRUST_PASSWORD: 'p',
      TRUST_TOTP_SECRET: 'jbsw y3dp ehpk 3pxp',
    });
    expect(creds.totpSecret).toBe(SEED);
  });

  it('rejects a non-base32 seed with a pointer to vault', async () => {
    await expect(
      resolveTrustCredentials(makeVaultClient(), { TRUST_EMAIL: 'a@b.c', TRUST_PASSWORD: 'p', TRUST_TOTP_SECRET: 'not-base32!' }),
    ).rejects.toThrow(/not a base32 secret/);
  });

  it('says what the secret is missing, and does not echo what it found', async () => {
    const client = makeVaultClient({ data: { email: 'a@b.c' } });
    await expect(resolveTrustCredentials(client, {})).rejects.toThrow(/does not hold a complete Trust login/);
  });

  it('explains how to fix a decrypt permission failure rather than surfacing a bare 403', async () => {
    const client = makeVaultClient();
    client.post.mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(resolveTrustCredentials(client, {})).rejects.toThrow(/secret:decrypt.*permission|permission/i);
  });

  it('never puts the password into an error message', async () => {
    const client = makeVaultClient({ data: { email: 'a@b.c', password: 'super-secret-value' } });
    await expect(resolveTrustCredentials(client, {})).rejects.toThrow();
    await resolveTrustCredentials(client, {}).catch((err: Error) => {
      expect(err.message).not.toContain('super-secret-value');
    });
  });
});

describe('generateTotpToken', () => {
  it('passes a pre-generated code straight through', async () => {
    await expect(generateTotpToken({ email: 'a@b.c', password: 'p', totpToken: '654321' })).resolves.toBe('654321');
  });

  it('generates a 6-digit code from the base32 seed', async () => {
    const code = await generateTotpToken({ email: 'a@b.c', password: 'p', totpSecret: SEED });
    expect(code).toMatch(/^\d{6}$/);
  });

  it('fails loudly when neither a seed nor a code is available', async () => {
    await expect(generateTotpToken({ email: 'a@b.c', password: 'p' })).rejects.toThrow(/cannot complete a Trust login/);
  });
});
