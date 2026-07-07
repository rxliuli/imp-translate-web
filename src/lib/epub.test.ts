import { describe, it, expect } from 'vitest'
import { parseEpub } from './epub'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

const FIXTURE_EPUB = new URL('../../test/fixtures/test.epub', import.meta.url).pathname

async function loadFixtureEpub(): Promise<Uint8Array> {
  const res = await fetch(FIXTURE_EPUB)
  return new Uint8Array(await res.arrayBuffer())
}

function makeEpub(
  chapters: Record<string, string>,
  ncx?: string,
): Uint8Array {
  const manifestItems = Object.keys(chapters)
    .map((name, i) => `<item id="ch${i}" href="${name}" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const ncxItem = ncx
    ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    : ''
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
  <manifest>${manifestItems}${ncxItem}</manifest>
  <spine>${spineItems}</spine>
</package>`,
    ),
  }

  if (ncx) files['toc.ncx'] = strToU8(ncx)

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

  it('preserves links in target-only mode', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml(
        '<div><span><a href="ch2.xhtml">Chapter Two</a></span></div>' +
        '<p>Plain text</p>',
      ),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Chapter Two', 'Plain text'])

    const rebuilt = result.rebuild(['第二章', '纯文本'], false)

    const files = unzipSync(rebuilt)
    const html = strFromU8(files['ch1.xhtml'])
    expect(html).toContain('href="ch2.xhtml"')
    expect(html).toContain('第二章')

    const reparsed = parseEpub(rebuilt)
    expect(reparsed.segments).toEqual(['第二章', '纯文本'])
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

describe('parseEpub regressions (I, Panacea)', () => {
  // SpaceBattles/FicHub books put entire chapters as direct text of a div,
  // with nested <div>=///=</div> scene separators. The old walker skipped
  // the container when it had a nested text tag, dropping all the prose.
  it('extracts direct text from containers that also have nested block elements', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml(
        '<div class="bbWrapper">First line of prose.<br/>\n<br/>\n' +
          '<div>=///=</div><br/>\nSecond line of prose.</div>',
      ),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual([
      'First line of prose.',
      '=///=',
      'Second line of prose.',
    ])
  })

  it('splits br-separated lines into separate segments', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<p>Line one<br/>Line two</p>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Line one', 'Line two'])
  })

  it('keeps inline formatting within one segment', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<p>Hello <b>bold</b> world</p>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Hello bold world'])
  })

  it('splits lines inside inline elements that contain br', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<p><i>1) First rule.<br/>2) Second rule.</i></p>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['1) First rule.', '2) Second rule.'])
  })

  it('bilingual rebuild keeps each translation next to its source line and preserves links', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml(
        '<div>Part Two: <a href="ch2.xhtml">Getting Along</a><br/>' +
          'Part Three: <a href="ch3.xhtml">Taking the Bull</a></div>',
      ),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual([
      'Part Two: Getting Along',
      'Part Three: Taking the Bull',
    ])

    const rebuilt = result.rebuild(['第二部：和睦相处', '第三部：迎难而上'], true)
    const html = strFromU8(unzipSync(rebuilt)['ch1.xhtml'])
    expect(html).toContain('href="ch2.xhtml"')
    expect(html).toContain('href="ch3.xhtml"')

    const reparsed = parseEpub(rebuilt)
    expect(reparsed.segments).toEqual([
      'Part Two: Getting Along',
      '第二部：和睦相处',
      'Part Three: Taking the Bull',
      '第三部：迎难而上',
    ])
  })

  it('bilingual rebuild skips translations identical to the source', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<div>Real text<br/><div>=///=</div></div>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['Real text', '=///='])

    const rebuilt = result.rebuild(['真实文本', '=///='], true)
    const reparsed = parseEpub(rebuilt)
    expect(reparsed.segments).toEqual(['Real text', '真实文本', '=///='])
  })

  it('translates NCX navigation labels', () => {
    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <docTitle><text>My Book</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
    <navPoint id="n2" playOrder="2">
      <navLabel><text>Chapter Two</text></navLabel>
      <content src="ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`
    const data = makeEpub(
      {
        'ch1.xhtml': xhtml('<p>Hello</p>'),
        'ch2.xhtml': xhtml('<p>World</p>'),
      },
      ncx,
    )
    const result = parseEpub(data)
    expect(result.segments).toEqual([
      'Hello',
      'World',
      'My Book',
      'Chapter One',
      'Chapter Two',
    ])

    const rebuilt = result.rebuild(
      ['你好', '世界', '我的书', '第一章', '第二章'],
      true,
    )
    const ncxOut = strFromU8(unzipSync(rebuilt)['toc.ncx'])
    expect(ncxOut).toContain('第一章')
    expect(ncxOut).toContain('第二章')
    expect(ncxOut).toContain('我的书')
  })

  it('falls back to HTML parsing for files that are not well-formed XML', () => {
    const data = makeEpub({
      'ch1.xhtml': xhtml('<p>A&nbsp;B</p>'),
    })
    const result = parseEpub(data)
    expect(result.segments).toEqual(['A B'])
  })

  it('stores mimetype uncompressed as the first zip entry', () => {
    const data = makeEpub({ 'ch1.xhtml': xhtml('<p>Hello</p>') })
    const rebuilt = parseEpub(data).rebuild(['你好'], true)

    // zip local file header: name at offset 30, compression method at offset 8
    const name = new TextDecoder().decode(rebuilt.slice(30, 38))
    expect(name).toBe('mimetype')
    const method = rebuilt[8] | (rebuilt[9] << 8)
    expect(method).toBe(0)
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

    // NCX labels are replaced in place (not doubled), content segments double
    const ncxDoc = new DOMParser().parseFromString(
      strFromU8(unzipSync(data)['toc.ncx']),
      'application/xml',
    )
    const ncxCount = Array.from(
      ncxDoc.querySelectorAll('navLabel > text, docTitle > text'),
    ).filter((el) => el.textContent?.trim()).length

    const reparsed = parseEpub(rebuilt)
    expect(reparsed.segments.length).toBe(
      (result.segments.length - ncxCount) * 2 + ncxCount,
    )
  })
})
