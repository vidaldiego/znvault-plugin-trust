// Path: src/cli/incident/client.ts
//
// HTTP client for the Trust portal's incident surface.
//
// Structurally a port of `trust/apps/trust-mcp/src/client.ts` (same API, same
// single-shot re-login on 401, same "errors say what to do next" contract),
// trimmed to the endpoints `znvault trust incident …` needs and with the token
// source folded in — the CLI only ever has one auth mode, the import-bot local
// account resolved by credentials.ts.
//
// Nothing here ever logs, returns, or embeds the password, the TOTP seed or the
// session token. The token exists only as a private field and in an
// `authorization` header.

import type { TrustCredentials } from './credentials.js';
import { generateTotpToken } from './credentials.js';

/** Event-level severity — the vocabulary of a candidate (`SecurityEvent`). */
export type EventSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/** Incident-level severity — the vocabulary of a confirmed incident. */
export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type IncidentStatus = 'OPEN' | 'INVESTIGATING' | 'MITIGATED' | 'RESOLVED' | 'CLOSED';

export type IncidentRegime = 'ISO_27001' | 'GDPR_BREACH';

/** `POST /api/v1/providers` — register a TrustProvider. */
export interface RegisterProviderBody {
  service: string;
  baseUrl: string;
  /**
   * The provider's manifest, supplied at registration and NOT optional.
   *
   * manifest/evidence/status are pulled on three independent queues with no
   * ordering. If evidence wins that race against an empty manifest, the mapper
   * resolves zero control codes and the snapshot is stored anyway — no links,
   * no error, and no second chance, because nothing re-maps a stored snapshot.
   * Registering with the manifest already present makes the mapping correct
   * whichever job lands first.
   */
  manifestJson: Record<string, unknown>;
  webhookMaxSilence?: number;
}

export interface RegisterProviderResult {
  id: string;
  created: boolean;
}

/** `POST /api/v1/security-events` — manual candidate capture (design §4.1). */
export interface CaptureEventBody {
  sourceEventId: string;
  type: string;
  severity: EventSeverity;
  summary: string;
  detail?: Record<string, unknown>;
  controlCodes?: string[];
  occurredAt?: string;
}

/**
 * Capture/ingest result.
 *
 * `droppedControlCodes` is the whole point of point 5 of the design: a control
 * code that is not in the seeded SoA is REPORTED, never a reason to reject the
 * capture. It is optional here only because the endpoint that returns it is
 * being built in parallel — treat its absence as "none dropped".
 */
export interface CaptureResult {
  id: string;
  created: boolean;
  droppedControlCodes?: string[];
}

/** `POST /api/v1/incidents/ingest` — bulk post-mortem load. */
export interface IngestBody {
  ingestKey: string;
  title: string;
  severity: IncidentSeverity;
  status?: IncidentStatus;
  timeline?: { note: string; occurredAt?: string }[];
  controlCodes?: string[];
  evidenceSnapshotId?: string;
}

/** `POST /api/v1/security-events/:id/promote` — the human gate (design §4.1). */
export interface PromoteBody {
  severity: IncidentSeverity;
  regime?: IncidentRegime;
  title?: string;
}

/** A row of `GET /api/v1/incidents`. Only the fields the CLI renders are typed. */
export interface IncidentSummary {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  regime?: string;
  createdAt: string;
  _count?: { timeline?: number; correctiveActions?: number; evidenceLinks?: number; controlLinks?: number };
}

/** A row of `GET /api/v1/security-events`. */
export interface SecurityEventSummary {
  id: string;
  sourceEventId: string;
  type: string;
  severity: EventSeverity;
  summary: string;
  receivedAt: string;
  provider?: { service?: string };
  /** Non-null once promoted — this is what `list --pending` filters on. */
  incident?: { id: string } | null;
}

/** Anything `fetch`-shaped. Injected in tests; no live call ever happens there. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** An HTTP failure from the Trust API, carrying actionable guidance. */
export class TrustApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'TrustApiError';
  }
}

const MAX_BODY_IN_MESSAGE = 400;

export interface TrustIncidentClientOptions {
  apiUrl: string;
  credentials: TrustCredentials;
  fetchFn?: FetchLike;
  /** Overridable only so tests never depend on a real TOTP clock. */
  totp?: (credentials: TrustCredentials) => Promise<string>;
}

export class TrustIncidentClient {
  private readonly apiUrl: string;
  private readonly credentials: TrustCredentials;
  private readonly fetchFn: FetchLike;
  private readonly totp: (credentials: TrustCredentials) => Promise<string>;
  private token: string | undefined;

  constructor(options: TrustIncidentClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.credentials = options.credentials;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.totp = options.totp ?? generateTotpToken;
  }

  // ------------------------------------------------------------------ auth

  /**
   * `POST /auth/login` with a code generated at THIS moment.
   *
   * The code is generated per attempt, never cached with the credential: TOTP
   * codes live 30 seconds, and a cached one would turn every command run more
   * than half a minute after the first into a spurious 401.
   */
  private async login(): Promise<string> {
    const totpToken = await this.totp(this.credentials);
    const res = await this.fetchFn(`${this.apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.credentials.email, password: this.credentials.password, totpToken }),
    });
    if (!res.ok) {
      const body = (await safeText(res)).slice(0, MAX_BODY_IN_MESSAGE);
      throw new TrustApiError(res.status, '/auth/login', body, loginGuidance(res.status, body, this.credentials.email));
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      throw new TrustApiError(500, '/auth/login', '', 'Trust login succeeded but returned no token — the API response is malformed.');
    }
    this.token = data.token;
    return data.token;
  }

  /**
   * Perform a request, re-authenticating EXACTLY once on 401. Strictly
   * single-shot: the retried response is returned as-is, so a permanently-401
   * API can never loop.
   */
  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.token ?? (await this.login());
    let res = await this.fetchFn(`${this.apiUrl}${path}`, withAuth(init, token));
    if (res.status === 401) {
      const fresh = await this.login();
      res = await this.fetchFn(`${this.apiUrl}${path}`, withAuth(init, fresh));
    }
    return res;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.send(path, init);
    if (!res.ok) throw await toError(path, res);
    return (await res.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // -------------------------------------------------------------- capture

  /** `POST /api/v1/security-events` — idempotent on `sourceEventId`. */
  async captureEvent(body: CaptureEventBody): Promise<CaptureResult> {
    return this.postJson<CaptureResult>('/api/v1/security-events', body);
  }

  // ------------------------------------------------------------- providers

  /**
   * `POST /api/v1/providers` — register (or re-register) a TrustProvider.
   *
   * Lives on this client rather than a new one because the transport is the
   * whole value here: login, single-shot 401 retry and error guidance are
   * already solved, and a second copy of that is a second place for the TOTP
   * clock to go wrong.
   *
   * Upsert on `service`, so re-running to correct a baseUrl or a drifted
   * manifest is the same command. The portal records PROVIDER_REGISTERED in its
   * hash-chained audit log on every call — which is the reason this goes
   * through the API and not through the database the deploy path already has
   * credentials for.
   */
  async registerProvider(body: RegisterProviderBody): Promise<RegisterProviderResult> {
    return this.postJson<RegisterProviderResult>('/api/v1/providers', body);
  }

  /** `POST /api/v1/incidents/ingest` — idempotent on `ingestKey`. */
  async ingestPostmortem(body: IngestBody): Promise<CaptureResult> {
    return this.postJson<CaptureResult>('/api/v1/incidents/ingest', body);
  }

  /**
   * `POST /api/v1/security-events/:id/promote` — candidate → incident.
   *
   * HUMAN-ONLY BY CHARTER. Deliberately has no MCP counterpart: promotion fixes
   * severity and regime, and the portal's founding act reserves that judgement
   * to a person ("AI-augmented, human-decided"). See the note on the `promote`
   * command in commands.ts before considering adding one.
   */
  async promoteEvent(id: string, body: PromoteBody): Promise<CaptureResult> {
    return this.postJson<CaptureResult>(`/api/v1/security-events/${encodeURIComponent(id)}/promote`, body);
  }

  // ----------------------------------------------------------------- read

  async listIncidents(filter: { severity?: IncidentSeverity; status?: IncidentStatus } = {}): Promise<IncidentSummary[]> {
    const qs = new URLSearchParams();
    if (filter.severity) qs.set('severity', filter.severity);
    if (filter.status) qs.set('status', filter.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return unwrapList<IncidentSummary>(await this.request<unknown>(`/api/v1/incidents${suffix}`));
  }

  async listSecurityEvents(filter: { severity?: EventSeverity; limit?: number } = {}): Promise<SecurityEventSummary[]> {
    const qs = new URLSearchParams();
    if (filter.severity) qs.set('severity', filter.severity);
    if (filter.limit) qs.set('limit', String(filter.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return unwrapList<SecurityEventSummary>(await this.request<unknown>(`/api/v1/security-events${suffix}`));
  }

  /** `GET /api/v1/incidents/:id`, or undefined on 404 (so `show` can fall through). */
  async findIncident(id: string): Promise<Record<string, unknown> | undefined> {
    return this.findOne(`/api/v1/incidents/${encodeURIComponent(id)}`);
  }

  /** `GET /api/v1/security-events/:id`, or undefined on 404. */
  async findSecurityEvent(id: string): Promise<Record<string, unknown> | undefined> {
    return this.findOne(`/api/v1/security-events/${encodeURIComponent(id)}`);
  }

  private async findOne(path: string): Promise<Record<string, unknown> | undefined> {
    const res = await this.send(path);
    if (res.status === 404) return undefined;
    if (!res.ok) throw await toError(path, res);
    return (await res.json()) as Record<string, unknown>;
  }

  // -------------------------------------------------------------- mutate

  async appendTimeline(id: string, note: string, occurredAt?: string): Promise<{ id: string }> {
    return this.postJson<{ id: string }>(`/api/v1/incidents/${encodeURIComponent(id)}/timeline`, { note, occurredAt });
  }

  async transition(id: string, to: IncidentStatus): Promise<{ id: string }> {
    return this.postJson<{ id: string }>(`/api/v1/incidents/${encodeURIComponent(id)}/transition`, { to });
  }

  async createCorrectiveAction(id: string, title: string, priority: string): Promise<{ id: string }> {
    return this.postJson<{ id: string }>(`/api/v1/incidents/${encodeURIComponent(id)}/corrective-actions`, { title, priority });
  }

  async linkEvidence(id: string, snapshotId: string): Promise<{ ok: true }> {
    return this.postJson<{ ok: true }>(`/api/v1/incidents/${encodeURIComponent(id)}/evidence`, { snapshotId });
  }

  /**
   * `POST /api/v1/evidence/manual` — multipart upload of a file as immutable,
   * hashed evidence. The portal computes and stores its own SHA-256; the CLI
   * prints one computed locally so the operator can see the two agree.
   */
  async uploadEvidence(input: {
    filename: string;
    bytes: Uint8Array;
    contentType?: string;
    controlCodes: string[];
    note?: string;
  }): Promise<{ snapshotId: string }> {
    const form = new FormData();
    // Copied into a fresh, plain-ArrayBuffer-backed view: a Node `Buffer` is
    // `Uint8Array<ArrayBufferLike>`, which `BlobPart` does not accept because it
    // could in principle be SharedArrayBuffer-backed. Evidence files are capped
    // at 25 MB server-side, so the copy is bounded and cheap.
    const view = new Uint8Array(input.bytes);
    form.append('file', new Blob([view], { type: input.contentType ?? 'application/octet-stream' }), input.filename);
    form.append('controlCodes', JSON.stringify(input.controlCodes));
    if (input.note) form.append('note', input.note);
    return this.request<{ snapshotId: string }>('/api/v1/evidence/manual', { method: 'POST', body: form });
  }
}

function withAuth(init: RequestInit, token: string): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function toError(path: string, res: Response): Promise<TrustApiError> {
  const body = (await safeText(res)).slice(0, MAX_BODY_IN_MESSAGE);
  return new TrustApiError(res.status, path, body, guidance(res.status, path, body));
}

/** Accepts either a bare array or an `{ items | data | results: [] }` envelope. */
function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    for (const key of ['items', 'data', 'results']) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}

/** Turns an HTTP status into a message that says what to DO about it. */
export function guidance(status: number, path: string, body: string): string {
  const tail = body ? ` Server said: ${body}` : '';
  switch (status) {
    case 401:
      return (
        `Trust rejected the request as unauthenticated (401 on ${path}). The session could not be renewed: ` +
        `check the credential in vault at \`trust/import-manager\` (email + password + base32 totpSecret) ` +
        `and that this machine's clock is in sync — a skewed clock invalidates every TOTP code.${tail}`
      );
    case 403:
      return (
        `Trust refused the request (403 on ${path}): the account's role is not allowed to do this. ` +
        `Capturing, promoting and closing all need ADMIN or MANAGER. Confirm the vault credential is the ` +
        `import-bot account and that its role has not been downgraded.${tail}`
      );
    case 404:
      return (
        `Not found (404 on ${path}). Check the id — \`znvault trust incident list\` shows incidents and ` +
        `\`… list --pending\` shows candidates awaiting promotion.${tail}`
      );
    case 400:
    case 422:
      return (
        `Trust rejected the payload (${status} on ${path}). Fix the fields and retry: candidate severity is ` +
        `INFO/WARNING/CRITICAL, incident severity LOW/MEDIUM/HIGH/CRITICAL, status ` +
        `OPEN/INVESTIGATING/MITIGATED/RESOLVED/CLOSED, and any timestamp must be ISO-8601 ` +
        `(e.g. 2026-08-15T09:41:02Z).${tail}`
      );
    case 409:
      return (
        `Conflict (409 on ${path}). The capture is idempotent on its id, so a conflict means the same id is ` +
        `already attached to a different finding — pass an explicit \`--id\` to disambiguate.${tail}`
      );
    case 429:
      return `Trust is rate-limiting (429 on ${path}). Wait a moment and retry, or capture fewer items at a time.${tail}`;
    default:
      if (status >= 500) {
        return (
          `Trust returned a server error (${status} on ${path}). The capture was NOT recorded — retry; the ` +
          `id is deterministic, so a retry cannot create a duplicate.${tail}`
        );
      }
      return `Trust API ${path} failed (${status}).${tail}`;
  }
}

function loginGuidance(status: number, body: string, email: string): string {
  if (status === 401) {
    return (
      `Trust login failed for ${email} (401). The credential in vault at \`trust/import-manager\` is wrong or ` +
      `stale: it must hold the account's password and the BASE32 TOTP SEED (not a 6-digit code — the CLI ` +
      `generates the code itself). Check the machine clock too. Repeated failures lock the account, so fix ` +
      `the values before retrying. [${body}]`
    );
  }
  if (status === 403) {
    return (
      `Trust login refused for ${email} (403) — the account is temporarily locked after repeated failed ` +
      `logins, or its access window expired. Wait for the lockout to lapse or ask an ADMIN. [${body}]`
    );
  }
  return `Trust login failed (${status}): ${body}`;
}
