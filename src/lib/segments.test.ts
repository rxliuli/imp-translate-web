import { describe, it, expect } from 'vitest'
import { splitSegments, buildSourceRanges } from './segments'

describe('splitSegments', () => {
  it('splits by newline, filters empty lines', () => {
    expect(splitSegments('hello\nworld')).toEqual(['hello', 'world'])
  })

  it('filters whitespace-only lines', () => {
    expect(splitSegments('hello\n\n  \nworld')).toEqual(['hello', 'world'])
  })

  it('returns empty for blank input', () => {
    expect(splitSegments('')).toEqual([])
    expect(splitSegments('\n\n')).toEqual([])
  })

  it('handles single line', () => {
    expect(splitSegments('hello')).toEqual(['hello'])
  })
})

describe('buildSourceRanges', () => {
  it('maps simple lines to correct byte ranges', () => {
    const text = 'hello\nworld'
    const ranges = buildSourceRanges(text)
    expect(ranges).toEqual([
      { start: 0, end: 5, separator: '\n' },
      { start: 6, end: 11, separator: '' },
    ])
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe('hello')
    expect(text.slice(ranges[1].start, ranges[1].end)).toBe('world')
  })

  it('collapses empty lines into previous separator', () => {
    const text = 'hello\n\nworld'
    const ranges = buildSourceRanges(text)
    expect(ranges).toEqual([
      { start: 0, end: 5, separator: '\n\n' },
      { start: 7, end: 12, separator: '' },
    ])
  })

  it('handles multiple consecutive empty lines', () => {
    const text = 'a\n\n\nb'
    const ranges = buildSourceRanges(text)
    expect(ranges).toEqual([
      { start: 0, end: 1, separator: '\n\n\n' },
      { start: 4, end: 5, separator: '' },
    ])
  })

  it('reconstructs original text from ranges', () => {
    const text = '# Title\n\nParagraph one.\n\nParagraph two.'
    const ranges = buildSourceRanges(text)
    let reconstructed = ''
    ranges.forEach((range, i) => {
      reconstructed += text.slice(range.start, range.end)
      if (i < ranges.length - 1) {
        reconstructed += range.separator
      }
    })
    const segments = splitSegments(text)
    expect(ranges.length).toBe(segments.length)
  })

  it('handles trailing newlines', () => {
    const text = 'hello\nworld\n'
    const ranges = buildSourceRanges(text)
    expect(ranges).toEqual([
      { start: 0, end: 5, separator: '\n' },
      { start: 6, end: 11, separator: '\n' },
    ])
  })

  it('returns empty for blank input', () => {
    expect(buildSourceRanges('')).toEqual([])
  })

  it('handles markdown-heavy content', () => {
    const text =
      '# Heading\n\n## Purpose\n\nThis is a paragraph.\n\n- item 1\n- item 2'
    const ranges = buildSourceRanges(text)
    expect(ranges.length).toBe(5)
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe('# Heading')
    expect(text.slice(ranges[1].start, ranges[1].end)).toBe('## Purpose')
    expect(text.slice(ranges[2].start, ranges[2].end)).toBe(
      'This is a paragraph.',
    )
    expect(text.slice(ranges[3].start, ranges[3].end)).toBe('- item 1')
    expect(text.slice(ranges[4].start, ranges[4].end)).toBe('- item 2')
  })

  it('ranges cover the full text when gaps are included', () => {
    const text = 'A\n\nB\n\nC'
    const ranges = buildSourceRanges(text)
    const covered = new Set<number>()
    let cursor = 0
    for (const range of ranges) {
      for (let j = cursor; j < range.start; j++) covered.add(j)
      for (let j = range.start; j < range.end; j++) covered.add(j)
      cursor = range.end
      for (let j = 0; j < range.separator.length; j++) {
        covered.add(cursor + j)
      }
      cursor += range.separator.length
    }
    for (let j = cursor; j < text.length; j++) covered.add(j)
    expect(covered.size).toBe(text.length)
  })
})
