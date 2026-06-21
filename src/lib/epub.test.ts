import { describe, it, expect } from 'vitest'
import { parseEpub } from './epub'
import { zipSync, strToU8 } from 'fflate'

const FIXTURE_EPUB = new URL('../../test/fixtures/test.epub', import.meta.url).pathname

async function loadFixtureEpub(): Promise<Uint8Array> {
  const res = await fetch(FIXTURE_EPUB)
  return new Uint8Array(await res.arrayBuffer())
}

function makeEpub(chapters: Record<string, string>): Uint8Array {
  const manifestItems = Object.keys(chapters)
    .map((name, i) => `<item id="ch${i}" href="${name}" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const spineItems = Object.keys(chapters)
    .map((_, i) => `<itemref idref="ch${i}"/>`)
    .join('\n')

  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    ),
    'content.opf': strToU8(
      `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Test</dc:title></metadata>
  <manifest>${manifestItems}</manifest>
  <spine>${spineItems}</spine>
</package>`,
    ),
  }

  for (const [name, html] of Object.entries(chapters)) {
    files[name] = strToU8(html)
  }

  return new Uint8Array(zipSync(files))
}

function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Test</title></head>
<body>${body}</body>
</html>`
}

describe('parseEpub', () => {
  it('extracts paragraphs and headings', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<h1>Title</h1><p>Hello world</p><p>Second paragraph</p>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Title', 'Hello world', 'Second paragraph'])
  })

  it('extracts text from div containers (Calibre-style)', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml(
        '<div class="c1"><span class="bold">Chapter One</span></div>' +
        '<div class="c2"><span>Some text here.</span></div>',
      ),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Chapter One', 'Some text here.'])
  })

  it('handles nested divs — only extracts leaf text', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml(
        '<div><div>Inner A</div><div>Inner B</div></div>',
      ),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Inner A', 'Inner B'])
  })

  it('skips empty elements', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<p>Real text</p><p>  </p><div></div>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Real text'])
  })

  it('extracts from list items', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<ul><li>Item A</li><li>Item B</li></ul>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Item A', 'Item B'])
  })

  it('handles multiple content files in spine order', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<p>Chapter 1</p>'),
      'ch2.xhtml': xhtml('<p>Chapter 2</p>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Chapter 1', 'Chapter 2'])
  })

  it('rebuilds in target-only mode', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<h1>Title</h1><p>Hello</p>'),
    })
    const result = parseEpub(data)
    const rebuilt = result.rebuild(['标题', '你好'], false)
    const reparsed = parseEpub(rebuilt)
    expect(reparsed.segments).toEqual(['标题', '你好'])
  })

  it('rebuilds in bilingual mode — doubles segment count', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<p>Hello</p><p>World</p>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toHaveLength(2)

    const rebuilt = result.rebuild(['你好', '世界'], true)
    const reparsed = parseEpub(rebuilt)
    expect(reparsed.segments).toHaveLength(4)
    expect(reparsed.segments).toEqual(['Hello', '你好', 'World', '世界'])
  })
})

describe('parseEpub (real EPUB)', () => {
  it('extracts a large number of segments', async () => {
    const data = await loadFixtureEpub()
    const result = parseEpub(data)
    expect(result.segments.length).toBeGreaterThan(100)
  })

  it('round-trips target-only rebuild', async () => {
    const data = await loadFixtureEpub()
    const result = parseEpub(data)
    const translations = result.segments.map((s) => `[T] ${s}`)
    const rebuilt = result.rebuild(translations, false)

    const reparsed = parseEpub(rebuilt)
    expect(reparsed.segments.length).toBe(result.segments.length)
    expect(reparsed.segments[0]).toContain('[T]')
  })

  it('round-trips bilingual rebuild', async () => {
    const data = await loadFixtureEpub()
    const result = parseEpub(data)
    const translations = result.segments.map((s) => `[翻译] ${s}`)
    const rebuilt = result.rebuild(translations, true)

    const reparsed = parseEpub(rebuilt)
    expect(reparsed.segments.length).toBe(result.segments.length * 2)
  })
})
