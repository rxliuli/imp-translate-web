import { describe, it, expect } from 'vitest'
import type { Segment } from './shared'
import {
  applySegmentResult,
  inFlightKey,
  planTranslation,
  toErrorMessage,
} from './translationRun'

function pending(source: string): Segment {
  return { source, translated: '', status: 'pending' }
}

function done(source: string, translated: string): Segment {
  return { source, translated, status: 'done' }
}

describe('planTranslation', () => {
  it('sends every source on the first pass and returns them as pending', () => {
    const plan = planTranslation(['one', 'two'], [], new Set(), 1)
    expect(plan.segments).toEqual([pending('one'), pending('two')])
    expect(plan.toSend).toEqual([0, 1])
  })

  it('does not re-send a segment whose request is still in flight', () => {
    const first = planTranslation(['one', 'two'], [], new Set(), 1)
    const inFlight = new Set([inFlightKey(1, 'one'), inFlightKey(1, 'two')])
    const second = planTranslation(
      ['one', 'two'],
      first.segments,
      inFlight,
      1,
    )
    expect(second.toSend).toEqual([])
    expect(second.segments).toEqual(first.segments)
  })

  it('sends only the segments that have never been sent in this run', () => {
    const segments = [pending('one'), pending('two')]
    const inFlight = new Set([inFlightKey(1, 'one'), inFlightKey(1, 'two')])
    const plan = planTranslation(['one', 'two', 'three'], segments, inFlight, 1)
    expect(plan.toSend).toEqual([2])
    expect(plan.segments.map((segment) => segment.source)).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('keeps translated segments and does not send them again', () => {
    const segments = [done('one', 'ONE'), pending('two')]
    const plan = planTranslation(['one', 'two'], segments, new Set(), 1)
    expect(plan.segments).toEqual([done('one', 'ONE'), pending('two')])
    expect(plan.toSend).toEqual([1])
  })

  it('keeps failed segments out of the automatic send (explicit retry only)', () => {
    const segments: Segment[] = [
      { source: 'one', translated: '', status: 'error', error: '413' },
    ]
    const plan = planTranslation(['one'], segments, new Set(), 1)
    expect(plan.segments).toEqual(segments)
    expect(plan.toSend).toEqual([])
  })

  it('ignores in-flight entries from a previous run', () => {
    const inFlight = new Set([inFlightKey(0, 'one')])
    const plan = planTranslation(['one'], [pending('one')], inFlight, 1)
    expect(plan.toSend).toEqual([0])
  })

  it('rebuilds the list when the source text at an index changes', () => {
    const segments = [done('one', 'ONE')]
    const plan = planTranslation(['one!', 'two'], segments, new Set(), 1)
    expect(plan.segments[0]).toEqual(pending('one!'))
    expect(plan.toSend).toEqual([0, 1])
  })
})

describe('applySegmentResult', () => {
  it('marks the first pending segment with the source as done', () => {
    const segments = [pending('one'), pending('one')]
    const next = applySegmentResult(segments, 'one', {
      translated: 'ONE',
      status: 'done',
    })
    expect(next[0]).toEqual(done('one', 'ONE'))
    expect(next[1]).toEqual(pending('one'))
  })

  it('records the failure reason on a pending segment', () => {
    const next = applySegmentResult([pending('one')], 'one', {
      status: 'error',
      error: 'Request failed with status 413',
    })
    expect(next[0]).toEqual({
      source: 'one',
      translated: '',
      status: 'error',
      error: 'Request failed with status 413',
    })
  })

  it('ignores responses for segments that are no longer pending', () => {
    const segments = [done('one', 'ONE')]
    expect(
      applySegmentResult(segments, 'one', { translated: 'stale', status: 'done' }),
    ).toBe(segments)
    expect(
      applySegmentResult(segments, 'gone', { translated: 'x', status: 'done' }),
    ).toBe(segments)
  })
})

describe('toErrorMessage', () => {
  it('keeps the extension message', () => {
    expect(toErrorMessage(new Error('413: text too long'))).toBe(
      '413: text too long',
    )
    expect(toErrorMessage('413: text too long')).toBe('413: text too long')
  })

  it('falls back for unknown rejections', () => {
    expect(toErrorMessage(undefined)).toBe('Translation failed')
    expect(toErrorMessage(new Error(''))).toBe('Translation failed')
  })
})
