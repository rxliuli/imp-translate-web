// Shared translation state for the /translate and /markdown editors: one
// request per source segment, in-flight suppression across debounce passes,
// per-segment failures and explicit retry.

import { useEffect, useRef, useState } from 'react'
import { rpc } from './rpc'
import type { Segment } from './shared'
import {
  applySegmentResult,
  inFlightKey,
  planTranslation,
  toErrorMessage,
} from './translationRun'

export function useTranslationRun() {
  const [segments, setSegments] = useState<Segment[]>([])
  // Mirrors `segments` for the debounce/retry callbacks, which run after the
  // render that scheduled them and would otherwise close over stale state.
  const segmentsRef = useRef<Segment[]>([])
  useEffect(() => {
    segmentsRef.current = segments
  }, [segments])

  // Bumped when a new run starts (target language changed) so responses from
  // the previous run cannot overwrite the new run's segments.
  const runIdRef = useRef(0)
  const inFlightRef = useRef(new Set<string>())

  function commit(next: Segment[]) {
    segmentsRef.current = next
    setSegments(next)
  }

  // Keep the ref in step with a response immediately, so a debounce pass that
  // fires before the next render still sees the segment as settled.
  function settle(
    source: string,
    patch: Pick<Segment, 'status'> & Partial<Segment>,
  ) {
    setSegments((prev) => {
      const next = applySegmentResult(prev, source, patch)
      segmentsRef.current = next
      return next
    })
  }

  function send(runId: number, source: string, to: string) {
    const key = inFlightKey(runId, source)
    inFlightRef.current.add(key)
    rpc
      .sendMessage('translate', { texts: [source], to })
      .then((results) => {
        if (runIdRef.current !== runId) return
        inFlightRef.current.delete(key)
        settle(source, { translated: results[0] ?? '', status: 'done' })
      })
      .catch((error: unknown) => {
        if (runIdRef.current !== runId) return
        inFlightRef.current.delete(key)
        settle(source, { status: 'error', error: toErrorMessage(error) })
      })
  }

  /**
   * Translate `sources`, reusing segments that are already translated or in
   * flight. `newRun` discards the previous run (target language changed).
   */
  function translate(sources: string[], to: string, newRun = false) {
    if (sources.length === 0) {
      inFlightRef.current.clear()
      commit([])
      return
    }
    if (newRun) {
      runIdRef.current += 1
      inFlightRef.current.clear()
    }
    const runId = runIdRef.current
    const plan = planTranslation(
      sources,
      segmentsRef.current,
      inFlightRef.current,
      runId,
    )
    commit(plan.segments)
    plan.toSend.forEach((index) => send(runId, sources[index], to))
  }

  /** Re-send every failed segment; called from the explicit retry action. */
  function retryFailed(to: string) {
    const runId = runIdRef.current
    const failed = segmentsRef.current
      .map((segment, index) => ({ segment, index }))
      .filter(
        ({ segment }) =>
          segment.status === 'error' &&
          !inFlightRef.current.has(inFlightKey(runId, segment.source)),
      )
    if (failed.length === 0) return

    const failedIndices = new Set(failed.map(({ index }) => index))
    commit(
      segmentsRef.current.map((segment, index) =>
        failedIndices.has(index)
          ? { ...segment, status: 'pending' as const, error: undefined }
          : segment,
      ),
    )
    failed.forEach(({ segment }) => send(runId, segment.source, to))
  }

  return { segments, translate, retryFailed }
}
