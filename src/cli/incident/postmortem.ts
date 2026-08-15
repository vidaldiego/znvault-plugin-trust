// Path: src/cli/incident/postmortem.ts
//
// Reads an already-written post-mortem into the shape `POST
// /api/v1/incidents/ingest` accepts.
//
// This is the bulk path. Roughly forty real post-mortems exist across the
// workspace — cronologies to the millisecond, root causes proven with packet
// captures — and every one of them is currently invisible to the ISMS register
// purely because nobody will retype it into a form. Parsing is therefore
// deliberately FORGIVING: anything it cannot recognise is left out, never
// treated as an error. A partially-parsed post-mortem in the register beats a
// perfectly-parsed one that failed validation and stayed in the repo.
//
// It recognises the two ways these documents are actually written here:
//
//   ## Timeline                 ## Cronología
//   - 09:41:02 first alert      | 09:41:02 | first alert |
//   - 09:43:10 failover began   | 09:43:10 | failover began |
//
// and nothing else. Free prose under the heading is kept verbatim as one entry
// rather than dropped.

/** One parsed cronology line, matching `IngestIncidentDto.timeline[]`. */
export interface PostmortemTimelineEntry {
  note: string;
  /** ISO-8601, only when the line carried a parseable absolute timestamp. */
  occurredAt?: string;
}

export interface ParsedPostmortem {
  /** First markdown H1, else the filename — never empty. */
  title: string;
  timeline: PostmortemTimelineEntry[];
}

/** Headings that introduce a cronology, in both languages this repo uses. */
const TIMELINE_HEADING = /^#{1,6}\s*(timeline|cronolog[ií]a|chronology|secuencia)\b/i;

/** Any other heading of the same or higher level ends the cronology section. */
const ANY_HEADING = /^#{1,6}\s+/;

/** `- ` / `* ` / `1. ` list markers. */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** A markdown table row: `| a | b |`. */
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;

/** A table's `|---|---|` separator, which carries no content. */
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

/**
 * A leading timestamp on a cronology line. Accepts a full ISO instant, a
 * date-only prefix, or a bare wall-clock time (`09:41`, `09:41:02`), optionally
 * wrapped in brackets and optionally followed by a separator.
 */
const LEADING_TIMESTAMP =
  /^\[?(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\]?\s*[-–—:|]?\s*/;

/** First `# Heading` in the document. */
function extractTitle(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].replace(/\s*[#]+\s*$/, '').trim();
  }
  return undefined;
}

/** A timestamp that states its own zone — `…Z` or `…+02:00`. */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Turn a leading timestamp into an ISO instant.
 *
 * A bare wall-clock time (`09:41:02`) is anchored to `dayHint` — the date the
 * document itself is about, taken from its filename or its title — because an
 * unanchored time is worse than none: it would silently land on *today's* date
 * and put an incident from June on an August timeline. With no hint at all,
 * `occurredAt` is left unset, which is honest.
 *
 * A timestamp with no zone is read as UTC, NOT as the machine's local time. That
 * is a deliberate trade: local-time parsing would make the same document ingest
 * differently from a Mac in Europe/Madrid and from the Linux dev VM in UTC, and
 * an ISMS register that is not reproducible is worth much less than one whose
 * clock is offset by a documented, uniform amount. `makeEntry` compensates by
 * leaving an unqualified timestamp in the note text as well, so the original
 * wall-clock reading is never lost.
 */
function toIsoInstant(raw: string, dayHint?: string): string | undefined {
  let value: string;
  if (/^\d{1,2}:\d{2}/.test(raw)) {
    if (!dayHint) return undefined;
    value = `${dayHint}T${padTime(raw)}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    value = `${raw}T00:00:00Z`;
  } else {
    value = HAS_ZONE.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** `9:41` → `09:41:00`, `09:41:02` → `09:41:02`. */
function padTime(raw: string): string {
  const [h = '0', m = '0', s = '0'] = raw.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;
}

/** A `YYYY-MM-DD` found in the filename or the title, used to anchor bare times. */
export function extractDayHint(...sources: (string | undefined)[]): string | undefined {
  for (const source of sources) {
    const match = source ? /(\d{4}-\d{2}-\d{2})/.exec(source) : null;
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Split a table row into its cells, dropping the empty edges. */
function tableCells(row: string): string[] {
  const inner = TABLE_ROW.exec(row)?.[1] ?? '';
  return inner.split('|').map((c) => c.trim());
}

function makeEntry(text: string, dayHint?: string): PostmortemTimelineEntry | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const match = LEADING_TIMESTAMP.exec(trimmed);
  if (!match?.[1]) return { note: trimmed };
  const occurredAt = toIsoInstant(match[1], dayHint);
  if (!occurredAt) return { note: trimmed };
  // Only a timestamp that stated its own zone is removed from the note: it is
  // unambiguous, so `occurredAt` carries it losslessly. An unqualified one was
  // *interpreted* as UTC, so the original reading stays in the text where a
  // human can still see what the document actually said.
  const qualified = HAS_ZONE.test(match[1]);
  const note = qualified ? trimmed.slice(match[0].length).trim() || trimmed : trimmed;
  return { note, occurredAt };
}

/**
 * Parse a post-mortem's markdown.
 *
 * `filename` is used for the title fallback and for the date hint that anchors
 * bare wall-clock times.
 */
export function parsePostmortem(markdown: string, filename: string): ParsedPostmortem {
  const lines = markdown.split(/\r?\n/);
  const title = extractTitle(lines) ?? filename.replace(/\.[^.]+$/, '');
  const dayHint = extractDayHint(filename, title);

  const timeline: PostmortemTimelineEntry[] = [];
  let inSection = false;
  let tableStarted = false;

  for (const line of lines) {
    if (TIMELINE_HEADING.test(line)) {
      inSection = true;
      tableStarted = false;
      continue;
    }
    if (!inSection) continue;
    if (ANY_HEADING.test(line)) break;

    if (TABLE_SEPARATOR.test(line)) {
      tableStarted = true;
      continue;
    }
    if (TABLE_ROW.test(line)) {
      const cells = tableCells(line);
      // The row before the `|---|` separator is the header, not data.
      if (!tableStarted) continue;
      const [first, ...rest] = cells;
      const joined = rest.filter(Boolean).join(' — ');
      const entry = makeEntry(joined ? `${first ?? ''} ${joined}`.trim() : (first ?? ''), dayHint);
      if (entry) timeline.push(entry);
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item?.[1]) {
      const entry = makeEntry(item[1], dayHint);
      if (entry) timeline.push(entry);
      continue;
    }

    // Free prose inside the section: keep it, it is still cronology.
    const entry = makeEntry(line, dayHint);
    if (entry) timeline.push(entry);
  }

  return { title, timeline };
}
