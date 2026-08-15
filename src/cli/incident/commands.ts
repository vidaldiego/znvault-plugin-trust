// Path: src/cli/incident/commands.ts
//
// `znvault trust incident …` — capture an ISMS finding from whatever repository
// you are already standing in (design doc §4.2, 2026-08-15).
//
// WHY THIS EXISTS. The portal's incident register is at zero while a sweep of
// this workspace's 57 repositories turns up ~40 real, documented incidents. The
// analysis is not missing — there are cronologies to the millisecond and root
// causes proven with packet captures — it simply never leaves the repository
// where it happened. Anything that requires opening a browser and filling in a
// form fails for the same reason it has failed so far: the moment you hit an
// incident is the worst possible moment to ask anyone for paperwork. So the bar
// for every command here is that CAPTURING A FINDING COSTS SECONDS.
//
// Three consequences run through the whole file:
//
//   1. The credential is read from vault, never from a flag (credentials.ts).
//   2. The idempotency key is DERIVED and DETERMINISTIC (idempotency.ts), so
//      re-capturing the same finding updates instead of duplicating. The derived
//      key is always printed so it can be reused verbatim.
//   3. A mistyped control code NEVER loses a capture. The API answers with
//      `droppedControlCodes` instead of rejecting; this surfaces them loudly and
//      still reports success.
//
// Registered as a peer of `deploy`/`status`/`rollback`/`config` — see
// src/cli/commands.ts.

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFile as readFileAsync } from 'node:fs/promises';
import type { Command } from 'commander';
import type { CLIPluginContext } from '@zincapp/znvault-deploy-core';
import { getErrorMessage } from '../../utils/error.js';
import {
  TrustIncidentClient,
  type EventSeverity,
  type FetchLike,
  type IncidentRegime,
  type IncidentSeverity,
  type IncidentStatus,
} from './client.js';
import { resolveTrustCredentials, type TrustCredentials, type VaultClient } from './credentials.js';
import { detectRepoContext, deriveKeyFromFile, deriveKeyFromSummary, type RepoContext } from './idempotency.js';
import { parsePostmortem } from './postmortem.js';

/** Where the portal lives unless `--api-url` or `$TRUST_API` says otherwise. */
export const DEFAULT_TRUST_API_URL = 'https://trust.zincapp.com';

/** Candidate type when none is given — deliberately neutral, not a guess. */
const DEFAULT_EVENT_TYPE = 'operational';

/** Default candidate severity: worth recording, not worth paging anyone. */
const DEFAULT_EVENT_SEVERITY: EventSeverity = 'WARNING';

/** Default severity for an ingested post-mortem. */
const DEFAULT_INCIDENT_SEVERITY: IncidentSeverity = 'MEDIUM';

/** Default priority for a corrective action created by `close --action`. */
const DEFAULT_ACTION_PRIORITY = 'MEDIUM';

const EVENT_SEVERITIES: EventSeverity[] = ['INFO', 'WARNING', 'CRITICAL'];
const INCIDENT_SEVERITIES: IncidentSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const INCIDENT_STATUSES: IncidentStatus[] = ['OPEN', 'INVESTIGATING', 'MITIGATED', 'RESOLVED', 'CLOSED'];
const REGIMES: IncidentRegime[] = ['ISO_27001', 'GDPR_BREACH'];

/**
 * Cross-vocabulary maps. A candidate carries an EVENT severity
 * (INFO/WARNING/CRITICAL) and an incident carries an INCIDENT severity
 * (LOW/MEDIUM/HIGH/CRITICAL). Mixing them up is the single most likely typo at
 * 03:00, and refusing the capture over it would be exactly the failure this tool
 * exists to prevent — so translate and say so, rather than reject.
 */
const EVENT_FROM_INCIDENT: Record<IncidentSeverity, EventSeverity> = {
  LOW: 'INFO',
  MEDIUM: 'WARNING',
  HIGH: 'CRITICAL',
  CRITICAL: 'CRITICAL',
};
const INCIDENT_FROM_EVENT: Record<EventSeverity, IncidentSeverity> = {
  INFO: 'LOW',
  WARNING: 'MEDIUM',
  CRITICAL: 'CRITICAL',
};

/**
 * Forward-only walk to CLOSED, mirroring the server's own state machine
 * (`apps/api/src/modules/incidents/incident-state.ts`). The server is
 * authoritative and will still refuse an illegal move; this exists so that
 * `close` on an OPEN incident does the obvious thing (OPEN → RESOLVED → CLOSED)
 * instead of failing with "illegal incident transition OPEN → CLOSED" and
 * leaving the operator to guess the ladder.
 */
const PATH_TO_CLOSED: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['RESOLVED', 'CLOSED'],
  INVESTIGATING: ['RESOLVED', 'CLOSED'],
  MITIGATED: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

/**
 * Injectable deps for the incident commands — thin seams so tests can supply
 * fakes without a live server, a real vault, a real TOTP clock, or a real git
 * checkout. Mirrors `DeployCommandDeps` in src/cli/commands.ts.
 */
export interface IncidentCommandDeps {
  fetchFn?: FetchLike;
  resolveCredentials?: (client: VaultClient, env: NodeJS.ProcessEnv) => Promise<TrustCredentials>;
  totp?: (credentials: TrustCredentials) => Promise<string>;
  readFile?: (path: string) => Promise<Buffer>;
  repoContext?: () => RepoContext;
  env?: NodeJS.ProcessEnv;
  /** Where `--json` payloads are written. Defaults to stdout. */
  emit?: (text: string) => void;
}

/** Collector for repeatable options (same helper shape as src/cli/commands.ts). */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value.trim()]);
}

/**
 * Reporter that keeps `--json` output machine-clean.
 *
 * In JSON mode the human lines are suppressed (they would corrupt a piped
 * payload) but warnings are still COLLECTED and folded into the payload — a
 * dropped control code has to reach a CI log just as much as it has to reach a
 * terminal. Errors always go through `ctx.output.error`, whatever the mode.
 */
function makeReporter(ctx: CLIPluginContext, jsonMode: boolean) {
  const warnings: string[] = [];
  return {
    warnings,
    info: (m: string) => {
      if (!jsonMode) ctx.output.info(m);
    },
    success: (m: string) => {
      if (!jsonMode) ctx.output.success(m);
    },
    warn: (m: string) => {
      warnings.push(m);
      if (!jsonMode) ctx.output.warn(m);
    },
    table: (headers: string[], rows: unknown[][]) => {
      if (!jsonMode) ctx.output.table(headers, rows);
    },
    keyValue: (data: Record<string, unknown>) => {
      if (!jsonMode) ctx.output.keyValue(data);
    },
  };
}

type Reporter = ReturnType<typeof makeReporter>;

function emitJson(deps: IncidentCommandDeps | undefined, payload: unknown): void {
  const write = deps?.emit ?? ((text: string) => process.stdout.write(text));
  write(`${JSON.stringify(payload, null, 2)}\n`);
}

/** Resolve the portal URL: explicit flag, then env, then the production default. */
export function resolveApiUrl(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  return (explicit ?? env.TRUST_API ?? env.TRUST_API_URL ?? DEFAULT_TRUST_API_URL).replace(/\/+$/, '');
}

function normalizeEventSeverity(raw: string, report: Reporter): EventSeverity {
  const value = raw.trim().toUpperCase();
  if ((EVENT_SEVERITIES as string[]).includes(value)) return value as EventSeverity;
  if ((INCIDENT_SEVERITIES as string[]).includes(value)) {
    const mapped = EVENT_FROM_INCIDENT[value as IncidentSeverity];
    report.warn(
      `--severity ${value} is an incident severity; a candidate uses ${EVENT_SEVERITIES.join('/')}. ` +
        `Captured as ${mapped} — set the final severity when you promote it.`,
    );
    return mapped;
  }
  throw new Error(
    `Unknown severity '${raw}'. A candidate takes ${EVENT_SEVERITIES.join('/')} ` +
      `(an incident severity ${INCIDENT_SEVERITIES.join('/')} is also accepted and translated).`,
  );
}

function normalizeIncidentSeverity(raw: string, report: Reporter): IncidentSeverity {
  const value = raw.trim().toUpperCase();
  if ((INCIDENT_SEVERITIES as string[]).includes(value)) return value as IncidentSeverity;
  if ((EVENT_SEVERITIES as string[]).includes(value)) {
    const mapped = INCIDENT_FROM_EVENT[value as EventSeverity];
    report.warn(`--severity ${value} is a candidate severity; an incident uses ${INCIDENT_SEVERITIES.join('/')}. Recorded as ${mapped}.`);
    return mapped;
  }
  throw new Error(`Unknown severity '${raw}'. An incident takes ${INCIDENT_SEVERITIES.join('/')}.`);
}

function normalizeStatus(raw: string | undefined): IncidentStatus | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toUpperCase();
  if (!(INCIDENT_STATUSES as string[]).includes(value)) {
    throw new Error(`Unknown status '${raw}'. Valid statuses: ${INCIDENT_STATUSES.join(', ')}.`);
  }
  return value as IncidentStatus;
}

function normalizeRegime(raw: string | undefined): IncidentRegime | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!(REGIMES as string[]).includes(value)) {
    throw new Error(`Unknown regime '${raw}'. Valid regimes: ${REGIMES.join(', ')}.`);
  }
  return value as IncidentRegime;
}

/** Validate an ISO-8601 instant, returning it normalised to UTC. */
export function normalizeInstant(raw: string, flag: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `${flag} '${raw}' is not a valid timestamp. Use ISO-8601, e.g. 2026-08-15T09:41:02Z or 2026-08-15T11:41:02+02:00.`,
    );
  }
  return parsed.toISOString();
}

/** Parse repeatable `--detail key=value` pairs into a flat object. */
export function parseDetailPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`--detail '${pair}' is not a key=value pair. Example: --detail file=src/db/pool.ts:184`);
    }
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return out;
}

/** Build an authenticated client. Credentials come from vault; never from argv. */
async function makeClient(
  ctx: CLIPluginContext,
  apiUrlOption: string | undefined,
  deps: IncidentCommandDeps | undefined,
): Promise<TrustIncidentClient> {
  const env = deps?.env ?? process.env;
  const resolve = deps?.resolveCredentials ?? resolveTrustCredentials;
  const credentials = await resolve(ctx.client, env);
  return new TrustIncidentClient({
    apiUrl: resolveApiUrl(apiUrlOption, env),
    credentials,
    fetchFn: deps?.fetchFn,
    totp: deps?.totp,
  });
}

/**
 * Report control codes the server refused to link.
 *
 * The API answers unknown codes with `droppedControlCodes` rather than a 400,
 * precisely so a mistyped `A.5.24` cannot cost an entire incident. Mirror that
 * here: loud warning, exit 0, capture kept.
 */
function reportDroppedControls(dropped: string[] | undefined, report: Reporter): void {
  if (!dropped || dropped.length === 0) return;
  report.warn(
    `Control code(s) not in the seeded SoA and therefore NOT linked: ${dropped.join(', ')}. ` +
      `The capture was recorded anyway — re-run with the corrected code(s), or link them in the portal. ` +
      `Codes look like A.5.24 or A.8.16.`,
  );
}

function shortDate(value: unknown): string {
  if (typeof value !== 'string') return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toISOString().slice(0, 16).replace('T', ' ');
}

function truncate(text: unknown, max = 60): string {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ─────────────────────────────────────────────────────────── capture

interface CaptureOptions {
  summary?: string;
  type: string;
  severity?: string;
  control: string[];
  detail: string[];
  file?: string;
  id?: string;
  status?: string;
  occurredAt?: string;
  apiUrl?: string;
  json?: boolean;
}

async function runCapture(
  ctx: CLIPluginContext,
  options: CaptureOptions,
  deps: IncidentCommandDeps | undefined,
): Promise<void> {
  const report = makeReporter(ctx, !!options.json);
  const repo = (deps?.repoContext ?? (() => detectRepoContext()))();
  const client = await makeClient(ctx, options.apiUrl, deps);

  if (options.file) {
    // ── bulk path: an already-written post-mortem, via the idempotent ingest
    // endpoint that already exists and already returns droppedControlCodes.
    // This is how the ~40 documents found in the sweep get loaded without
    // anyone retyping a single cronology line.
    const readFile = deps?.readFile ?? ((p: string) => readFileAsync(p));
    let raw: Buffer;
    try {
      raw = await readFile(options.file);
    } catch (err) {
      throw new Error(`Could not read the post-mortem '${options.file}': ${getErrorMessage(err)}`);
    }
    const filename = basename(options.file);
    const parsed = parsePostmortem(raw.toString('utf-8'), filename);
    const title = options.summary ?? parsed.title;
    const ingestKey = options.id ?? deriveKeyFromFile(repo.repo, options.file, repo.root);
    const severity = normalizeIncidentSeverity(options.severity ?? DEFAULT_INCIDENT_SEVERITY, report);
    const status = normalizeStatus(options.status);

    report.info(`id: ${ingestKey}`);
    if (parsed.timeline.length === 0) {
      report.warn(
        `No timeline section recognised in ${filename} (looked for a "Timeline"/"Cronología" heading with ` +
          `list items or a table). Ingesting anyway — add entries with \`znvault trust incident timeline\`.`,
      );
    }

    const result = await client.ingestPostmortem({
      ingestKey,
      title,
      severity,
      status,
      timeline: parsed.timeline.length > 0 ? parsed.timeline : undefined,
      controlCodes: options.control.length > 0 ? options.control : undefined,
    });
    reportDroppedControls(result.droppedControlCodes, report);

    report.success(
      `${result.created ? 'Ingested' : 'Updated'} incident ${result.id} from ${filename} ` +
        `(${parsed.timeline.length} timeline entr${parsed.timeline.length === 1 ? 'y' : 'ies'}).`,
    );
    report.info(`Re-run with the same file — or \`--id ${ingestKey}\` — to update it instead of duplicating.`);

    if (options.json) {
      emitJson(deps, {
        mode: 'postmortem',
        ingestKey,
        id: result.id,
        created: result.created,
        title,
        severity,
        status: status ?? null,
        timelineEntries: parsed.timeline.length,
        droppedControlCodes: result.droppedControlCodes ?? [],
        warnings: report.warnings,
      });
    }
    return;
  }

  // ── candidate path: a finding captured in seconds, from wherever you are.
  // A CANDIDATE, not an incident: the portal's founding act says "AI-augmented,
  // human-decided", and an agent that minted firm incidents would fill the
  // register an auditor reads with false positives. A person confirms severity
  // and regime at `promote`.
  if (!options.summary) {
    throw new Error(
      'Nothing to capture: pass --summary "<what happened>", or --file <post-mortem.md> to ingest a written one.',
    );
  }

  const sourceEventId = options.id ?? deriveKeyFromSummary(repo.repo, options.summary);
  const severity = normalizeEventSeverity(options.severity ?? DEFAULT_EVENT_SEVERITY, report);
  const detail: Record<string, unknown> = {
    repo: repo.repo,
    ...(repo.commit ? { commit: repo.commit } : {}),
    capturedVia: 'znvault trust incident capture',
    ...parseDetailPairs(options.detail),
  };

  report.info(`id: ${sourceEventId}`);

  const result = await client.captureEvent({
    sourceEventId,
    type: options.type,
    severity,
    summary: options.summary,
    detail,
    controlCodes: options.control.length > 0 ? options.control : undefined,
    occurredAt: options.occurredAt ? normalizeInstant(options.occurredAt, '--occurred-at') : undefined,
  });
  reportDroppedControls(result.droppedControlCodes, report);

  report.success(
    result.created
      ? `Captured candidate ${result.id} (${severity}, ${options.type}).`
      : `Candidate ${result.id} already existed — updated, not duplicated.`,
  );
  report.info(`Promote it to a real incident with: znvault trust incident promote ${result.id} --severity <LOW|MEDIUM|HIGH|CRITICAL>`);

  if (options.json) {
    emitJson(deps, {
      mode: 'candidate',
      sourceEventId,
      id: result.id,
      created: result.created,
      type: options.type,
      severity,
      droppedControlCodes: result.droppedControlCodes ?? [],
      warnings: report.warnings,
    });
  }
}

// ─────────────────────────────────────────────────────────── list / show

interface ListOptions {
  status?: string;
  severity?: string;
  pending?: boolean;
  limit?: string;
  apiUrl?: string;
  json?: boolean;
}

async function runList(ctx: CLIPluginContext, options: ListOptions, deps: IncidentCommandDeps | undefined): Promise<void> {
  const report = makeReporter(ctx, !!options.json);
  const client = await makeClient(ctx, options.apiUrl, deps);

  if (options.pending) {
    if (options.status) {
      throw new Error('--status filters incidents; --pending lists candidates, which have no status. Use one or the other.');
    }
    const severity = options.severity ? normalizeEventSeverity(options.severity, report) : undefined;
    const limit = options.limit ? Number(options.limit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      throw new Error(`--limit '${options.limit}' must be a positive number.`);
    }
    const events = await client.listSecurityEvents({ severity, limit });
    const pending = events.filter((e) => !e.incident);

    if (options.json) {
      emitJson(deps, { mode: 'pending', count: pending.length, items: pending });
      return;
    }
    if (pending.length === 0) {
      report.info('No candidates awaiting promotion.');
      return;
    }
    report.table(
      ['ID', 'Severity', 'Type', 'Summary', 'Received'],
      pending.map((e) => [e.id, e.severity, e.type, truncate(e.summary), shortDate(e.receivedAt)]),
    );
    report.info(`${pending.length} candidate(s) awaiting a human decision — promote with: znvault trust incident promote <id> --severity <…>`);
    return;
  }

  const severity = options.severity ? normalizeIncidentSeverity(options.severity, report) : undefined;
  const status = normalizeStatus(options.status);
  const incidents = await client.listIncidents({ severity, status });

  if (options.json) {
    emitJson(deps, { mode: 'incidents', count: incidents.length, items: incidents });
    return;
  }
  if (incidents.length === 0) {
    report.info('No incidents match. (`--pending` lists candidates that have not been promoted yet.)');
    return;
  }
  report.table(
    ['ID', 'Severity', 'Status', 'Title', 'Created'],
    incidents.map((i) => [i.id, i.severity, i.status, truncate(i.title), shortDate(i.createdAt)]),
  );
}

async function runShow(
  ctx: CLIPluginContext,
  id: string,
  options: { apiUrl?: string; json?: boolean },
  deps: IncidentCommandDeps | undefined,
): Promise<void> {
  const report = makeReporter(ctx, !!options.json);
  const client = await makeClient(ctx, options.apiUrl, deps);

  // An id is an id: the operator should not have to remember whether what they
  // are holding is an incident or a candidate that was never promoted.
  const incident = await client.findIncident(id);
  const record = incident ?? (await client.findSecurityEvent(id));
  if (!record) {
    throw new Error(
      `No incident or candidate with id '${id}'. Run \`znvault trust incident list\` (or \`list --pending\`) to find it.`,
    );
  }
  const kind = incident ? 'incident' : 'candidate';

  if (options.json) {
    emitJson(deps, { kind, ...record });
    return;
  }

  if (kind === 'incident') {
    report.keyValue({
      id: String(record.id ?? id),
      title: String(record.title ?? '(untitled)'),
      severity: String(record.severity ?? '-'),
      status: String(record.status ?? '-'),
      regime: String(record.regime ?? '-'),
      created: shortDate(record.createdAt),
      promotedFrom: record.sourceSecurityEventId ? String(record.sourceSecurityEventId) : '(captured directly)',
    });
    const timeline = Array.isArray(record.timeline) ? (record.timeline as Record<string, unknown>[]) : [];
    if (timeline.length > 0) {
      report.table(
        ['When', 'Note'],
        timeline.map((t) => [shortDate(t.occurredAt ?? t.createdAt), truncate(t.note, 90)]),
      );
    }
    const capas = Array.isArray(record.correctiveActions) ? (record.correctiveActions as Record<string, unknown>[]) : [];
    if (capas.length > 0) {
      report.table(
        ['Action', 'Priority', 'Status'],
        capas.map((c) => [truncate(c.title, 60), String(c.priority ?? '-'), String(c.status ?? '-')]),
      );
    }
    return;
  }

  report.keyValue({
    id: String(record.id ?? id),
    sourceEventId: String(record.sourceEventId ?? '-'),
    type: String(record.type ?? '-'),
    severity: String(record.severity ?? '-'),
    summary: String(record.summary ?? '-'),
    received: shortDate(record.receivedAt),
    promoted: record.incident ? `yes (${String((record.incident as { id?: string }).id ?? '')})` : 'no — awaiting a human decision',
  });
}

// ─────────────────────────────────────────────────────────── human commands

/**
 * `promote` — candidate → incident.
 *
 * DELIBERATELY HUMAN-ONLY. The MCP tool set (design §4.3) ships
 * `capture_incident`, `list_incidents`, `get_incident`, `add_incident_timeline`
 * and `attach_incident_evidence`, and deliberately DOES NOT ship `promote` or
 * `close`. That asymmetry is not an oversight and not a gap to be tidied up: the
 * portal's founding act reserves the two acts of judgement — confirming that a
 * candidate is a real incident at a chosen severity and regime, and declaring it
 * closed — to a person. That an agent cannot close an incident is not a
 * technical limitation; it IS the control. If you are here to "fix the
 * inconsistency" by adding the MCP counterparts, read design §2.1 and §4.3
 * first, and get the owner's sign-off.
 */
async function runPromote(
  ctx: CLIPluginContext,
  id: string,
  options: { severity: string; regime?: string; title?: string; apiUrl?: string; json?: boolean },
  deps: IncidentCommandDeps | undefined,
): Promise<void> {
  const report = makeReporter(ctx, !!options.json);
  const client = await makeClient(ctx, options.apiUrl, deps);
  const severity = normalizeIncidentSeverity(options.severity, report);
  const regime = normalizeRegime(options.regime);

  const result = await client.promoteEvent(id, { severity, regime, title: options.title });
  report.success(
    result.created
      ? `Promoted candidate ${id} → incident ${result.id} (${severity}${regime ? `, ${regime}` : ''}).`
      : `Candidate ${id} was already promoted → incident ${result.id}.`,
  );
  if (options.json) {
    emitJson(deps, { sourceEventId: id, id: result.id, created: result.created, severity, regime: regime ?? null, warnings: report.warnings });
  }
}

/**
 * `close` — record the root cause, open any corrective actions, then walk the
 * incident forward to CLOSED.
 *
 * HUMAN-ONLY for the same reason as `promote` (see above). Declaring an incident
 * closed is a management assertion, not an inference.
 */
async function runClose(
  ctx: CLIPluginContext,
  id: string,
  options: { rootCause: string; action: string[]; actionPriority: string; apiUrl?: string; json?: boolean },
  deps: IncidentCommandDeps | undefined,
): Promise<void> {
  const report = makeReporter(ctx, !!options.json);
  const client = await makeClient(ctx, options.apiUrl, deps);

  const incident = await client.findIncident(id);
  if (!incident) {
    throw new Error(
      `No incident with id '${id}'. If this is still a candidate, promote it first: ` +
        `znvault trust incident promote ${id} --severity <…>`,
    );
  }
  const status = String(incident.status ?? 'OPEN') as IncidentStatus;
  const path = PATH_TO_CLOSED[status];
  if (!path) {
    throw new Error(`Incident ${id} is in an unrecognised status '${status}' — close it from the portal.`);
  }

  // Record the analysis BEFORE the state change: an incident that reaches CLOSED
  // without a root cause on its timeline is exactly the empty record the register
  // is full of today. The timeline is append-only and accepts entries at any
  // status, so ordering here costs nothing and guarantees the note lands.
  await client.appendTimeline(id, `Root cause: ${options.rootCause}`);
  report.info('Root cause appended to the timeline.');

  const actions: { id: string; title: string }[] = [];
  for (const title of options.action) {
    const capa = await client.createCorrectiveAction(id, title, options.actionPriority);
    actions.push({ id: capa.id, title });
    report.info(`Corrective action opened: ${title} (${capa.id})`);
  }

  if (path.length === 0) {
    report.warn(`Incident ${id} was already CLOSED — the root cause and any actions were still recorded.`);
  }
  for (const to of path) {
    await client.transition(id, to);
    report.info(`→ ${to}`);
  }

  report.success(
    path.length === 0
      ? `Incident ${id} left CLOSED; root cause recorded.`
      : `Incident ${id} closed (${[status, ...path].join(' → ')}).`,
  );

  if (options.json) {
    emitJson(deps, {
      id,
      from: status,
      transitions: path,
      rootCause: options.rootCause,
      correctiveActions: actions,
      warnings: report.warnings,
    });
  }
}

// ─────────────────────────────────────────────────────── timeline / evidence

async function runTimeline(
  ctx: CLIPluginContext,
  id: string,
  options: { at?: string; what: string; apiUrl?: string; json?: boolean },
  deps: IncidentCommandDeps | undefined,
): Promise<void> {
  const report = makeReporter(ctx, !!options.json);
  const client = await makeClient(ctx, options.apiUrl, deps);
  const occurredAt = options.at ? normalizeInstant(options.at, '--at') : undefined;

  const entry = await client.appendTimeline(id, options.what, occurredAt);
  report.success(`Timeline entry ${entry.id} added to incident ${id}${occurredAt ? ` at ${occurredAt}` : ''}.`);
  if (options.json) {
    emitJson(deps, { incidentId: id, entryId: entry.id, occurredAt: occurredAt ?? null, note: options.what });
  }
}

async function runEvidence(
  ctx: CLIPluginContext,
  id: string,
  options: { file: string; control: string[]; note?: string; apiUrl?: string; json?: boolean },
  deps: IncidentCommandDeps | undefined,
): Promise<void> {
  const report = makeReporter(ctx, !!options.json);
  const client = await makeClient(ctx, options.apiUrl, deps);
  const readFile = deps?.readFile ?? ((p: string) => readFileAsync(p));

  let bytes: Buffer;
  try {
    bytes = await readFile(options.file);
  } catch (err) {
    throw new Error(`Could not read the evidence file '${options.file}': ${getErrorMessage(err)}`);
  }
  const filename = basename(options.file);
  // Computed locally as well as server-side so the operator can compare the two
  // and see that what the portal stored is byte-identical to what left here.
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const { snapshotId } = await client.uploadEvidence({
    filename,
    bytes,
    contentType: guessContentType(filename),
    controlCodes: options.control,
    note: options.note,
  });
  await client.linkEvidence(id, snapshotId);

  report.success(`Attached ${filename} to incident ${id} as evidence ${snapshotId}.`);
  report.info(`sha256: ${sha256}`);
  if (options.control.length === 0) {
    report.warn('No --control given: the evidence is attached to the incident but maps to no Annex A control.');
  }

  if (options.json) {
    emitJson(deps, {
      incidentId: id,
      snapshotId,
      filename,
      bytes: bytes.length,
      sha256,
      controlCodes: options.control,
      warnings: report.warnings,
    });
  }
}

/** Enough of a content type for the portal to render the common cases. */
function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
    case 'log':
      return 'text/plain';
    case 'json':
      return 'application/json';
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'csv':
      return 'text/csv';
    case 'pcap':
    case 'pcapng':
      return 'application/vnd.tcpdump.pcap';
    default:
      return 'application/octet-stream';
  }
}

// ─────────────────────────────────────────────────────────── registration

/**
 * Wrap an action so every failure exits 1 with a message that says what to do
 * next — the same shape the deploy-side commands use.
 */
function guard(ctx: CLIPluginContext, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      ctx.output.error(getErrorMessage(err));
      process.exit(1);
    }
  };
}

/** `--api-url` + `--json`, on every subcommand (commander does not inherit options). */
function withCommonOptions(cmd: Command): Command {
  return cmd
    .option('--api-url <url>', `Trust portal base URL (default: $TRUST_API or ${DEFAULT_TRUST_API_URL})`)
    .option('--json', 'Output as JSON (suppresses the human-readable lines)');
}

/**
 * Register `znvault trust incident …`.
 *
 * Exported so src/cli/commands.ts can mount it next to deploy/status/rollback/
 * config, and so tests can mount it on a bare `Command` with fakes injected.
 */
export function registerIncidentCommands(incident: Command, ctx: CLIPluginContext, deps?: IncidentCommandDeps): void {
  withCommonOptions(
    incident
      .command('capture')
      .description('Capture a finding as a candidate — or ingest a written post-mortem with --file')
      .option('--summary <text>', 'One line: what happened')
      .option('--type <type>', 'Kind of event, e.g. outage, data-loss, credential-exposure', DEFAULT_EVENT_TYPE)
      .option('--severity <severity>', `Candidate: ${EVENT_SEVERITIES.join('|')}. With --file: ${INCIDENT_SEVERITIES.join('|')}`)
      .option('--control <code>', 'Proposed Annex A control, e.g. A.5.24 (repeatable)', collect, [] as string[])
      .option('--detail <key=value>', 'Extra context, e.g. --detail file=src/pool.ts:184 (repeatable)', collect, [] as string[])
      .option('--file <path>', 'Ingest an already-written post-mortem (uses the idempotent ingest endpoint)')
      .option('--id <key>', 'Explicit idempotency key (default: derived from the repo + summary/path)')
      .option('--status <status>', `Initial status, --file only: ${INCIDENT_STATUSES.join('|')}`)
      .option('--occurred-at <iso>', 'When it happened, ISO-8601 (distinct from when it was captured)'),
  )
    .addHelpText(
      'after',
      `
Examples:
  znvault trust incident capture --summary "etcd filled to 2GB and took down Patroni" \\
    --type outage --severity CRITICAL --control A.8.16 --detail host=etcd-1
  znvault trust incident capture --file docs/POSTMORTEM-2026-07-05-key-rotation.md --severity HIGH

Without --id the key is derived from the git repository plus the summary (or the
file path), so re-running the same capture updates it instead of creating a
duplicate. The derived key is printed — reuse it with --id.
`,
    )
    .action((options: CaptureOptions) => guard(ctx, () => runCapture(ctx, options, deps))());

  withCommonOptions(
    incident
      .command('list')
      .description('List incidents, or candidates awaiting promotion with --pending')
      .option('--status <status>', `Filter incidents: ${INCIDENT_STATUSES.join('|')}`)
      .option('--severity <severity>', 'Filter by severity')
      .option('--pending', 'List captured candidates that no human has promoted yet')
      .option('--limit <n>', 'Max candidates to fetch (--pending only)'),
  ).action((options: ListOptions) => guard(ctx, () => runList(ctx, options, deps))());

  withCommonOptions(
    incident.command('show <id>').description('Show one incident, or one candidate, in full'),
  ).action((id: string, options: { apiUrl?: string; json?: boolean }) => guard(ctx, () => runShow(ctx, id, options, deps))());

  withCommonOptions(
    incident
      .command('promote <id>')
      .description('HUMAN: confirm a candidate as a real incident at a chosen severity')
      .requiredOption('--severity <severity>', `Incident severity: ${INCIDENT_SEVERITIES.join('|')}`)
      .option('--regime <regime>', `Regime: ${REGIMES.join('|')} (default ISO_27001)`)
      .option('--title <title>', 'Override the incident title (default: the candidate summary)'),
  ).action((id: string, options: { severity: string; regime?: string; title?: string; apiUrl?: string; json?: boolean }) =>
    guard(ctx, () => runPromote(ctx, id, options, deps))(),
  );

  withCommonOptions(
    incident
      .command('timeline <id>')
      .description('Append an entry to an incident timeline')
      .option('--at <iso>', 'When it happened, ISO-8601 (default: recorded as of now)')
      .requiredOption('--what <text>', 'What happened at that moment'),
  ).action((id: string, options: { at?: string; what: string; apiUrl?: string; json?: boolean }) =>
    guard(ctx, () => runTimeline(ctx, id, options, deps))(),
  );

  withCommonOptions(
    incident
      .command('evidence <id>')
      .description('Upload a file as immutable evidence and attach it to an incident')
      .requiredOption('--file <path>', 'File to upload (log, capture, screenshot, report…)')
      .option('--control <code>', 'Annex A control this evidences, e.g. A.8.15 (repeatable)', collect, [] as string[])
      .option('--note <text>', 'What this file shows'),
  ).action((id: string, options: { file: string; control: string[]; note?: string; apiUrl?: string; json?: boolean }) =>
    guard(ctx, () => runEvidence(ctx, id, options, deps))(),
  );

  withCommonOptions(
    incident
      .command('close <id>')
      .description('HUMAN: record the root cause, open corrective actions, and close the incident')
      .requiredOption('--root-cause <text>', 'What actually caused it')
      .option('--action <title>', 'Corrective action to open (repeatable)', collect, [] as string[])
      .option('--action-priority <priority>', 'Priority for --action items', DEFAULT_ACTION_PRIORITY),
  )
    .addHelpText(
      'after',
      `
\`promote\` and \`close\` exist here and NOT as MCP tools, on purpose: the portal's
charter reserves both acts of judgement to a person. See the comment above
runPromote in src/cli/incident/commands.ts before "fixing" that asymmetry.
`,
    )
    .action((id: string, options: { rootCause: string; action: string[]; actionPriority: string; apiUrl?: string; json?: boolean }) =>
      guard(ctx, () => runClose(ctx, id, options, deps))(),
    );
}
