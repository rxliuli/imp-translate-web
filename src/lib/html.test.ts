import { describe, it, expect } from 'vitest'
import { parseHtml, applyTranslations } from './html'

describe('parseHtml segments', () => {
  it('extracts paragraphs and headings', () => {
    const parsed = parseHtml(
      '<h1>Title</h1><p>Hello world</p><p>Second paragraph</p>',
    )
    expect(parsed.segments).toEqual(['Title', 'Hello world', 'Second paragraph'])
  })

  it('extracts text from div containers', () => {
    const parsed = parseHtml(
      '<div class="c1"><span class="bold">Chapter One</span></div>' +
        '<div class="c2"><span>Some text here.</span></div>',
    )
    expect(parsed.segments).toEqual(['Chapter One', 'Some text here.'])
  })

  it('keeps inline formatting within one segment', () => {
    const parsed = parseHtml('<p>Hello <b>bold</b> world</p>')
    expect(parsed.segments).toEqual(['Hello bold world'])
  })

  it('splits lines inside inline elements that contain br', () => {
    const parsed = parseHtml('<p><i>1) First rule.<br/>2) Second rule.</i></p>')
    expect(parsed.segments).toEqual(['1) First rule.', '2) Second rule.'])
  })

  it('splits br-separated lines into separate segments', () => {
    const parsed = parseHtml('<p>Line one<br/>Line two</p>')
    expect(parsed.segments).toEqual(['Line one', 'Line two'])
  })

  it('skips script/style/svg/math contents', () => {
    const parsed = parseHtml(
      '<p>Visible</p>' +
        '<script>const x = 1</script>' +
        '<style>a{color:red}</style>' +
        '<svg><text>Not in svg</text></svg>' +
        '<math><mi>Not in math</mi></math>' +
        '<p>After</p>',
    )
    expect(parsed.segments).toEqual(['Visible', 'After'])
  })

  it('extracts from list items', () => {
    const parsed = parseHtml('<ul><li>Item A</li><li>Item B</li></ul>')
    expect(parsed.segments).toEqual(['Item A', 'Item B'])
  })

  it('handles nested divs — only extracts leaf text', () => {
    const parsed = parseHtml('<div><div>Inner A</div><div>Inner B</div></div>')
    expect(parsed.segments).toEqual(['Inner A', 'Inner B'])
  })

  it('skips empty elements', () => {
    const parsed = parseHtml('<p>Real text</p><p>  </p><div></div>')
    expect(parsed.segments).toEqual(['Real text'])
  })

  it('normalizes whitespace and trims', () => {
    const parsed = parseHtml('<p>Hello   world </p>')
    expect(parsed.segments).toEqual(['Hello world'])
  })

  it('handles a full document', () => {
    const parsed = parseHtml('<!doctype html><html><body><p>Hi</p></body></html>')
    expect(parsed.segments).toEqual(['Hi'])
  })

  it('returns no segments for empty input', () => {
    expect(parseHtml('').segments).toEqual([])
    expect(parseHtml('   ').segments).toEqual([])
  })
})

describe('parseHtml serialize', () => {
  it('returns the inner fragment for a fragment input', () => {
    const parsed = parseHtml('<div><p>Hello</p></div>')
    expect(parsed.serialize()).toBe('<div><p>Hello</p></div>')
  })

  it('returns a full document for a full document input', () => {
    const parsed = parseHtml(
      '<!doctype html><html><head></head><body><p>Hi</p></body></html>',
    )
    const out = parsed.serialize()
    expect(out).toMatch(/^<!DOCTYPE html>/i)
    expect(out).toContain('<p>Hi</p>')
    expect(parsed.fullDocument).toBe(true)
  })

  it('marks fragment input as not a full document', () => {
    expect(parseHtml('<p>Hi</p>').fullDocument).toBe(false)
  })
})

describe('applyTranslations', () => {
  it('target-only replaces text in place', () => {
    const parsed = parseHtml('<p>Hello</p><p>World</p>')
    applyTranslations(parsed.doc, ['你好', '世界'], false)
    expect(parsed.serialize()).toBe('<p>你好</p><p>世界</p>')
  })

  it('bilingual keeps source and appends translation', () => {
    const parsed = parseHtml('<p>Hello</p><p>World</p>')
    applyTranslations(parsed.doc, ['你好', '世界'], true)
    const out = parsed.serialize()
    expect(out).toContain('Hello')
    expect(out).toContain('你好')
    expect(out).toContain('World')
    expect(out).toContain('世界')
  })

  it('preserves attributes and links in target-only mode', () => {
    const parsed = parseHtml('<p><a href="http://x">Link</a></p>')
    applyTranslations(parsed.doc, ['链接'], false)
    const out = parsed.serialize()
    expect(out).toContain('href="http://x"')
    expect(out).toContain('链接')
  })

  it('keeps bilingual translation next to its source line and preserves links', () => {
    const parsed = parseHtml(
      '<div>Part Two: <a href="ch2.xhtml">Getting Along</a><br/>' +
        'Part Three: <a href="ch3.xhtml">Taking the Bull</a></div>',
    )
    applyTranslations(parsed.doc, ['第二部：和睦相处', '第三部：迎难而上'], true)
    const out = parsed.serialize()
    expect(out).toContain('href="ch2.xhtml"')
    expect(out).toContain('href="ch3.xhtml"')
    expect(out).toContain('第二部：和睦相处')
    expect(out).toContain('第三部：迎难而上')
  })

  it('skips translations identical to the source', () => {
    const parsed = parseHtml('<p>Hello</p>')
    applyTranslations(parsed.doc, ['Hello'], true)
    expect(parsed.serialize()).toBe('<p>Hello</p>')
  })

  it('respects a non-zero offset (segments from cumulative docs)', () => {
    const parsed = parseHtml('<p>Hello</p><p>World</p>')
    // This is the 2nd doc: overall translations include the 1st doc's entry
    applyTranslations(parsed.doc, ['First doc', '你好', '世界'], false, 1)
    expect(parsed.serialize()).toBe('<p>你好</p><p>世界</p>')
  })
})
