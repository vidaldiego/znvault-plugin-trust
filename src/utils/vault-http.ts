/**
 * Vault HTTP adapter + guarded revoke.
 *
 * Ported verbatim from @zincapp/znvault-plugin-archon's
 * src/utils/vault-http.ts (same reasoning applies here): `@zincapp/znvault-migrate`
 * does NOT barrel-export `makeVaultHttpAdapter`, `makeRevokeOnce`, `withTimeout`,
 * or `REVOKE_SETTLE_MS` — only `makeDynamicSecretsClient` + `Lease` are exported
 * (see its index.d.ts). These primitives are small enough (~50 lines) to
 * re-implement here rather than fork the library or widen its public surface
 * for two consumers.
 */

/** Adapts the plugin's existing `ctx.client` (a `post<T>(path, body): Promise<T>`,
 * throws on error) to the `VaultHttp` shape `makeDynamicSecretsClient` expects
 * (`post(path, body): Promise<{status, body}>`). */
export function makeVaultHttpAdapter(client: { post<T>(p: string, b: unknown): Promise<T> }) {
  return {
    async post(path: string, body: unknown) {
      const r = await client.post<unknown>(path, body);
      return { status: 200, body: r };
    },
  };
}

const REVOKE_DELAYS = [200, 600];

function isNonRevocable(e: unknown): boolean {
  return /cannot revoke .* lease|failed lease/i.test(e instanceof Error ? e.message : String(e));
}

/**
 * Wrap a revoke call so it only ever executes once (idempotent — safe to call
 * from both the normal-completion path and a signal handler without double-revoking),
 * retrying transient failures up to 3 attempts total with [200, 600]ms backoff.
 * Gives up (logs, does not throw) on a FAILED-lease response or after the last attempt —
 * a stuck revoke must never block process exit or mask the migration's real result.
 */
export function makeRevokeOnce(revoke: () => Promise<void>, log: (m: string) => void): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    const attempts = 1 + REVOKE_DELAYS.length;
    for (let i = 1; i <= attempts; i++) {
      try {
        await revoke();
        return;
      } catch (e) {
        if (isNonRevocable(e) || i === attempts) {
          log(`revoke gave up: ${String((e as Error).message)}`);
          return;
        }
        await new Promise((r) => setTimeout(r, REVOKE_DELAYS[i - 1]));
      }
    }
  };
}

/** Race a promise against a timeout; never rejects — resolves either way so a
 * hung revoke can't hang the CLI exit. */
export function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    p.finally(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Grace period after the migration child exits, before revoking the lease —
 * lets Prisma's own connection pool finish closing so the revoke doesn't race
 * a still-open connection using the credential being revoked. */
export const REVOKE_SETTLE_MS = 1500;
