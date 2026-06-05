import { describe, it, expect } from 'vitest'
import { splitSegments, buildSourceRanges, splitMarkdownBlocks } from './segments'

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

describe('splitMarkdownBlocks', () => {
  it('returns empty for blank input', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
    expect(splitMarkdownBlocks('  \n  ')).toEqual([])
  })

  it('splits paragraphs by blank lines', () => {
    const blocks = splitMarkdownBlocks('Hello world.\n\nSecond paragraph.')
    expect(blocks).toEqual([
      { text: 'Hello world.', translatable: true },
      { text: '', translatable: false },
      { text: 'Second paragraph.', translatable: true },
    ])
  })

  it('keeps multi-line paragraphs together', () => {
    const blocks = splitMarkdownBlocks('Line one\nLine two\n\nNext.')
    expect(blocks).toEqual([
      { text: 'Line one\nLine two', translatable: true },
      { text: '', translatable: false },
      { text: 'Next.', translatable: true },
    ])
  })

  it('keeps fenced code blocks as non-translatable', () => {
    const text = 'Before.\n\n```python\ndef foo():\n    pass\n```\n\nAfter.'
    const blocks = splitMarkdownBlocks(text)
    expect(blocks).toEqual([
      { text: 'Before.', translatable: true },
      { text: '', translatable: false },
      { text: '```python\ndef foo():\n    pass\n```', translatable: false },
      { text: '', translatable: false },
      { text: 'After.', translatable: true },
    ])
  })

  it('handles code blocks with blank lines inside', () => {
    const text = '```\nline1\n\nline2\n```'
    const blocks = splitMarkdownBlocks(text)
    expect(blocks).toEqual([
      { text: '```\nline1\n\nline2\n```', translatable: false },
    ])
  })

  it('handles unclosed code blocks', () => {
    const text = '```\ncode without closing'
    const blocks = splitMarkdownBlocks(text)
    expect(blocks).toEqual([
      { text: '```\ncode without closing', translatable: false },
    ])
  })

  it('reconstructs original text by joining with newline', () => {
    const text = '# Title\n\nParagraph one.\n\n```js\nconst x = 1\n```\n\nEnd.'
    const blocks = splitMarkdownBlocks(text)
    expect(blocks.map((b) => b.text).join('\n')).toBe(text)
  })

  it('handles headings as translatable', () => {
    const blocks = splitMarkdownBlocks('# Heading\n\n## Sub')
    expect(blocks).toEqual([
      { text: '# Heading', translatable: true },
      { text: '', translatable: false },
      { text: '## Sub', translatable: true },
    ])
  })

  it('handles multiple consecutive blank lines', () => {
    const blocks = splitMarkdownBlocks('A\n\n\n\nB')
    expect(blocks).toEqual([
      { text: 'A', translatable: true },
      { text: '\n\n', translatable: false },
      { text: 'B', translatable: true },
    ])
  })

  it('splits unordered list items individually (dash)', () => {
    const text = '- item 1\n- item 2\n- item 3'
    const blocks = splitMarkdownBlocks(text)
    expect(blocks).toEqual([
      { text: '- item 1', translatable: true },
      { text: '- item 2', translatable: true },
      { text: '- item 3', translatable: true },
    ])
  })

  it('splits unordered list items individually (asterisk and plus)', () => {
    const blocks = splitMarkdownBlocks('* foo\n+ bar')
    expect(blocks).toEqual([
      { text: '* foo', translatable: true },
      { text: '+ bar', translatable: true },
    ])
  })

  it('splits ordered list items individually', () => {
    const blocks = splitMarkdownBlocks('1. first\n2. second\n3. third')
    expect(blocks).toEqual([
      { text: '1. first', translatable: true },
      { text: '2. second', translatable: true },
      { text: '3. third', translatable: true },
    ])
  })

  it('splits indented list items individually', () => {
    const blocks = splitMarkdownBlocks('- top\n  - nested\n  - nested2\n- top2')
    expect(blocks).toEqual([
      { text: '- top', translatable: true },
      { text: '  - nested', translatable: true },
      { text: '  - nested2', translatable: true },
      { text: '- top2', translatable: true },
    ])
  })

  it('handles list after paragraph with blank line', () => {
    const text = 'Intro text.\n\n- item 1\n- item 2'
    const blocks = splitMarkdownBlocks(text)
    expect(blocks).toEqual([
      { text: 'Intro text.', translatable: true },
      { text: '', translatable: false },
      { text: '- item 1', translatable: true },
      { text: '- item 2', translatable: true },
    ])
  })

  it('reconstructs lists correctly', () => {
    const text = '## Goals\n\n- item 1\n- item 2\n\nEnd.'
    const blocks = splitMarkdownBlocks(text)
    expect(blocks.map((b) => b.text).join('\n')).toBe(text)
  })

  it('handles ordered list with closing paren', () => {
    const blocks = splitMarkdownBlocks('1) first\n2) second')
    expect(blocks).toEqual([
      { text: '1) first', translatable: true },
      { text: '2) second', translatable: true },
    ])
  })
})
