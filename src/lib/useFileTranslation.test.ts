import { describe, it, expect } from 'vitest'
import {
  BATCH_SIZE,
  MAX_CHARS_PER_REQUEST,
  accumulateBatchResults,
  packBatches,
  type Batch,
} from './useFileTranslation'
import { MAX_CHARS_PER_SEGMENT } from './segments'

const batchChars = (batch: Batch) =>
  batch.texts.reduce((sum, text) => sum + text.length, 0)

/** Source segment indices carried by `batches`, in order, with repeats. */
const sentSegments = (batches: Batch[]) => batches.flatMap((batch) => batch.segments)

/** Source segment indices in order, each one once. */
const segmentOrder = (batches: Batch[]) =>
  sentSegments(batches).filter((segment, i, all) => segment !== all[i - 1])

const everyRequestBounded = (batches: Batch[]) =>
  batches.every(
    (batch) =>
      batch.texts.length <= BATCH_SIZE && batchChars(batch) <= MAX_CHARS_PER_REQUEST,
  )

/** Texts sent for one source segment, in order. */
const piecesOf = (batches: Batch[], segment: number) =>
  batches.flatMap((batch) =>
    batch.texts.filter((_, i) => batch.segments[i] === segment),
  )

const indices = (count: number) => Array.from({ length: count }, (_, i) => i)

describe('packBatches', () => {
  it('never exceeds the character budget with large segments', () => {
    const segments = Array.from({ length: 12 }, () => 'x'.repeat(7000))
    const { batches } = packBatches(segments, indices(segments.length))
    expect(everyRequestBounded(batches)).toBe(true)
    expect(segmentOrder(batches)).toEqual(indices(segments.length))
    segments.forEach((segment, index) => {
      expect(piecesOf(batches, index).join('')).toBe(segment)
    })
  })

  it('never exceeds BATCH_SIZE items with short segments', () => {
    const segments = Array.from({ length: 45 }, (_, index) => `line ${index}`)
    const { batches } = packBatches(segments, indices(segments.length))
    expect(batches.every((batch) => batch.texts.length <= BATCH_SIZE)).toBe(true)
    expect(batches.map((batch) => batch.texts.length)).toEqual([20, 20, 5])
    expect(segmentOrder(batches)).toEqual(indices(segments.length))
  })

  it('applies both bounds to mixed lengths and preserves order', () => {
    const segments = [
      'a'.repeat(9000),
      'short',
      'b'.repeat(9000),
      'c'.repeat(9000),
      'd'.repeat(19999),
    ]
    const { batches } = packBatches(segments, indices(segments.length))
    expect(everyRequestBounded(batches)).toBe(true)
    expect(batches.map(batchChars)).toEqual([18005, 17000, 11999])
    expect(segmentOrder(batches)).toEqual(indices(segments.length))
    segments.forEach((segment, index) => {
      expect(piecesOf(batches, index).join('')).toBe(segment)
    })
  })

  it('preserves the order of a retry subset', () => {
    const segments = ['one', 'two', 'three', 'four']
    const { batches } = packBatches(segments, [3, 0, 2])
    expect(batches.map((batch) => batch.segments)).toEqual([[3, 0, 2]])
  })

  it('returns no batches for no indices', () => {
    expect(packBatches(['one'], []).batches).toEqual([])
  })

  it('splits a segment longer than a request so no request goes over budget', () => {
    const segments = ['y'.repeat(25000), 'small']
    const { batches, piecesPerSegment } = packBatches(segments, [0, 1])

    expect(everyRequestBounded(batches)).toBe(true)
    expect(batches.map(batchChars)).toEqual([MAX_CHARS_PER_REQUEST, 5005])
    expect(batches.map((batch) => batch.texts.length)).toEqual([5, 3])

    // The pieces are still one segment's worth of text, in order.
    const pieces = piecesOf(batches, 0)
    expect(pieces.length).toBe(piecesPerSegment.get(0))
    expect(pieces.every((piece) => piece.length <= MAX_CHARS_PER_SEGMENT)).toBe(true)
    expect(pieces.join('')).toBe(segments[0])
  })
})

describe('accumulateBatchResults', () => {
  it('rejoins the pieces of one segment across batches, in order', () => {
    const segments = ['y'.repeat(25000), 'small', 'z'.repeat(9000)]
    const { batches, piecesPerSegment } = packBatches(
      segments,
      indices(segments.length),
    )
    const pending = new Map<number, string[]>()
    const translations = new Map<number, string>()
    const settledPerBatch: number[][] = []

    for (const batch of batches) {
      // Identity translation: the extension echoes back the text it was given.
      const settled = accumulateBatchResults(pending, piecesPerSegment, batch, batch.texts)
      settledPerBatch.push([...settled.keys()])
      settled.forEach((translation, segment) => translations.set(segment, translation))
    }

    // The 25,000-char segment spans two batches, so it is published only once
    // its last piece arrives instead of as a truncated translation.
    expect(settledPerBatch[0]).toEqual([])
    expect(settledPerBatch.at(-1)).toEqual([0, 1, 2])
    expect([...translations.keys()]).toEqual([0, 1, 2])
    segments.forEach((segment, index) => {
      expect(translations.get(index)).toBe(segment)
    })
    expect(pending.size).toBe(0)
  })

  it('does not settle a segment whose last piece is still in flight', () => {
    const { batches, piecesPerSegment } = packBatches(['w'.repeat(25000)], [0])
    const settled = accumulateBatchResults(
      new Map<number, string[]>(),
      piecesPerSegment,
      batches[0],
      batches[0].texts,
    )
    expect(settled.size).toBe(0)
  })
})
