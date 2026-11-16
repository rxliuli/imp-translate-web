// Pure bookkeeping for a translation run: which sources still need a request,
// and where a response/error lands. Kept free of React so the in-flight
// suppression rules can be exercised directly in tests.

import type { Segment } from './shared'

/**
 * In-flight requests are keyed by run id plus source text. The run id changes
 * when a new run starts (target language changed), and the source text — not
 * the list index — identifies the segment because the list is rebuilt from the
 * textarea on every debounce pass.
 */
export function inFlightKey(runId: number, source: string): string {
  return `${runId}\u0000${source}`
}

export interface TranslationPlan {
  /** Segment list to render for this pass. */
  segments: Segment[]
  /** Indices into `sources` that still need a request. */
  toSend: number[]
}

/**
 * Rebuild the segment list for `sources`, keeping already translated,
 * in-flight and failed segments, and decide what to send. Only sources that
 * have never been sent in this run are sent: a `pending` segment whose request
 * is still in flight is not re-sent, and an `error` segment waits for an
 * explicit retry instead of being re-sent on every keystroke.
 */
export function planTranslation(
  sources: string[],
  previous: readonly Segment[],
  inFlight: ReadonlySet<string>,
  runId: number,
): TranslationPlan {
  const segments = sources.map((source, index) => {
    const prev = previous[index]
    if (prev && prev.source === source) return prev
    return { source, translated: '', status: 'pending' as const }
  })
  const toSend = segments
    .map((segment, index) => ({ segment, index }))
    .filter(
      ({ segment }) =>
        segment.status === 'pending' &&
        !inFlight.has(inFlightKey(runId, segment.source)),
    )
    .map(({ index }) => index)
  return { segments, toSend }
}

/**
 * Apply a response to the first still-pending segment with this source text.
 * Duplicate source lines are resolved one response at a time, and responses
 * for segments that are no longer pending (retried, removed) are ignored.
 */
export function applySegmentResult(
  segments: Segment[],
  source: string,
  patch: Pick<Segment, 'status'> & Partial<Segment>,
): Segment[] {
  const index = segments.findIndex(
    (segment) => segment.source === source && segment.status === 'pending',
  )
  if (index === -1) return segments
  return segments.map((segment, i) =>
    i === index ? { ...segment, ...patch } : segment,
  )
}

/** Human-readable message for an RPC rejection (413s arrive as a string). */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Translation failed'
}
