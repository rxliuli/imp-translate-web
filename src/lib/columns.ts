// Column-level inference shared by the spreadsheet handlers (xlsx and csv):
// which columns hold prose worth translating, and which are skipped as
// enumerations, identifier columns, date columns or single-word labels. The
// rules look at the strings a column holds and nothing else, so they do not
// depend on the document shape that produced them — a worksheet's shared string
// table and a delimited file's cells are judged the same way.

// A "word" for column inference. CJK text has no spaces, so a whole Chinese
// sentence would otherwise count as one word and its column would look like a
// label column; each CJK character counts as a word instead.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g

function wordCount(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean).length
  return tokens + (text.match(CJK_RE)?.length ?? 0)
}

const ACCOUNT_TOKEN_RE = /[_-]|\d/

/**
 * The share of a column's values that has to look like an account token for the
 * identifier rule to claim the column. Not every value: the header cell sits in
 * the same column and is a plain word (`createdAt`, `id`), so requiring every
 * value to hold a digit or a separator made the rule miss the columns it was
 * written for.
 */
const TOKEN_SHARE = 0.95

// A whole cell that holds nothing but a date or a clock time: an ISO date or
// timestamp (`2026-05-27`, `2026-05-27T03:08:25Z`), an RFC 2822 stamp
// (`Wed, 27 May 2026 03:08:25 +0000`), a bare clock (`03:08`, `03:08:25`) and
// the slash-separated forms a spreadsheet writes (`2026/05/27`, `27/05/2026`).
// Both ends are anchored, so a sentence that merely mentions a year or a clock
// time is not a date.
const DATE_RE =
  /^(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}|\d{4}\/\d{2}\/\d{2}|\d{2}\/\d{2}\/\d{4}|\d{2}:\d{2}(?::\d{2})?)$/

/** The share of a column's values that has to look like a date to skip it. */
const DATE_SHARE = 0.9

/** Why a column is skipped; also the categories the handlers' debug lines count. */
export type ColumnSkipReason = 'enumeration' | 'identifier' | 'label' | 'datetime'

export interface ColumnDecision {
  /** Whether the column holds prose worth sending for translation. */
  translatable: boolean
  /** Why the column is skipped; null when `translatable`. */
  reason: ColumnSkipReason | null
}

const PROSE: ColumnDecision = { translatable: true, reason: null }

const SKIP: Record<ColumnSkipReason, ColumnDecision> = {
  enumeration: { translatable: false, reason: 'enumeration' },
  identifier: { translatable: false, reason: 'identifier' },
  label: { translatable: false, reason: 'label' },
  datetime: { translatable: false, reason: 'datetime' },
}

/**
 * Classify one column from the strings its non-empty cells hold, one entry per
 * cell — a value used by three cells appears three times, because the
 * uniqueness ratio below is per cell rather than per distinct value. Four
 * shapes are skipped: translating them wastes requests and produces nonsense in
 * cells the document uses as keys.
 */
export function classifyColumn(values: readonly string[]): ColumnDecision {
  const distinct = new Set(values)
  // Enumeration: a handful of repeated values (Complete/Unread/N/TBA).
  if (distinct.size <= 3) return SKIP.enumeration
  // Account names and IDs: short, almost all unique, and shaped like a token.
  // A loop rather than `Math.max(...)`: a real export can hold a hundred
  // thousand rows, which is more arguments than a spread call accepts.
  let longest = 0
  for (const value of values) {
    if (value.length > longest) longest = value.length
  }
  const tokens = values.filter((value) => ACCOUNT_TOKEN_RE.test(value)).length
  if (
    longest <= 32 &&
    distinct.size / values.length > 0.95 &&
    tokens / values.length >= TOKEN_SHARE
  ) {
    return SKIP.identifier
  }
  // Dates and clock times: a column of timestamps is data even though one
  // stamped value is several words long. A few other values are tolerated, so a
  // column of stamps with one stray note in it is still data.
  const dated = values.filter((value) => DATE_RE.test(value.trim())).length
  if (dated / values.length >= DATE_SHARE) return SKIP.datetime
  // Single-word labels (names, tags).
  const averageWords =
    values.reduce((sum, value) => sum + wordCount(value), 0) / values.length
  if (averageWords < 2) return SKIP.label
  return PROSE
}
