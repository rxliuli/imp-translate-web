import { describe, it, expect } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { parseDocx } from './docx'

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
const W14_NS = 'http://schemas.microsoft.com/office/word/2010/wordml'
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

/**
 * A document part shaped like Word's own: the `mc:Ignorable`/`w14` namespaces
 * and the trailing `<w:sectPr>` are what a DOM round trip would drop or move.
 */
function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:m="${M_NS}" xmlns:w14="${W14_NS}" xmlns:mc="${MC_NS}" mc:Ignorable="w14"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>
`

// Copied through untouched by every rebuild; the comparison in the
// "unmodified members" test is what proves the zip round trip is byte safe.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>
`

const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

function buildDocx(body: string): Uint8Array<ArrayBuffer> {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    'word/document.xml': strToU8(documentXml(body)),
    'word/styles.xml': strToU8(STYLES),
    'word/media/image1.png': IMAGE_BYTES,
  }
  return new Uint8Array(zipSync(files))
}

function run(text: string, rPr = ''): string {
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`
}

function para(runs: string, attrs = ''): string {
  return `<w:p${attrs}><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs}</w:p>`
}

function readPart(data: Uint8Array, path: string): string {
  const files = unzipSync(data)
  const part = files[path]
  if (!part) throw new Error(`missing part ${path}`)
  return strFromU8(part)
}

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const error = doc.querySelector('parsererror')
  if (error) throw new Error(`not well-formed XML: ${error.textContent}\n${xml}`)
  return doc
}

/** The text of every `<w:p>` of the rebuilt document, in order. */
function paragraphTexts(data: Uint8Array): string[] {
  return Array.from(
    parseXml(readPart(data, 'word/document.xml')).getElementsByTagName('w:p'),
    (element) => element.textContent ?? '',
  )
}

function rebuild(
  data: Uint8Array,
  translations: (string | undefined)[],
  bilingual: boolean,
): Uint8Array {
  return parseDocx(data).rebuild(translations, bilingual)
}

const SOURCE = 'The project starts on Monday'
const TRANSLATION = '项目周一开始'

describe('parseDocx', () => {
  it('translates a single-run paragraph', () => {
    const data = buildDocx(para(run(SOURCE)))
    const doc = parseDocx(data)
    expect(doc.segments).toEqual([SOURCE])

    const output = doc.rebuild([TRANSLATION], false)
    expect(paragraphTexts(output)).toEqual([TRANSLATION])
    // The paragraph's own markup is kept, only the run's text changed.
    expect(readPart(output, 'word/document.xml')).toContain(
      '<w:pStyle w:val="Normal"/>',
    )
  })

  it('merges a sentence that Word split across runs with spell-check markers', () => {
    const data = buildDocx(
      `<w:p><w:proofErr w:type="spellStart"/><w:r><w:t xml:space="preserve">The quick brown </w:t></w:r><w:proofErr w:type="spellEnd"/><w:r><w:t xml:space="preserve">fox jumps </w:t></w:r><w:r><w:t xml:space="preserve">over the lazy dog</w:t></w:r></w:p>`,
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual(['The quick brown fox jumps over the lazy dog'])

    const output = doc.rebuild(['敏捷的棕色狐狸跳过懒狗'], false)
    expect(paragraphTexts(output)).toEqual(['敏捷的棕色狐狸跳过懒狗'])
    // The spell-check markers are outside every splice and survive as they were.
    const xml = readPart(output, 'word/document.xml')
    expect(xml).toContain('<w:proofErr w:type="spellStart"/>')
    expect(xml).toContain('<w:proofErr w:type="spellEnd"/>')
  })

  it('merges runs whose middle one is bold into one segment', () => {
    const data = buildDocx(
      para(
        `${run('Read the ')}${run('release notes', '<w:rPr><w:b/></w:rPr>')}${run(' before shipping')}`,
      ),
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual(['Read the release notes before shipping'])
    expect(paragraphTexts(doc.rebuild(['发货前请阅读发布说明'], false))).toEqual([
      '发货前请阅读发布说明',
    ])
  })

  it('puts the translation under the source with a line break when bilingual', () => {
    const data = buildDocx(para(run(SOURCE)))
    const output = rebuild(data, [TRANSLATION], true)

    // A newline inside `<w:t>` would not break the line in Word; `<w:br/>` does.
    const xml = readPart(output, 'word/document.xml')
    expect(xml).toContain(
      `<w:t xml:space="preserve">${SOURCE}</w:t><w:br/><w:t xml:space="preserve">${TRANSLATION}</w:t>`,
    )
    expect(paragraphTexts(output)).toEqual([`${SOURCE}${TRANSLATION}`])
  })

  it('keeps every source run of a bilingual paragraph byte for byte', () => {
    // Word splits one line into a run per style: a coloured heading, its body
    // and a grey side note. Writing the merged source back as a single run —
    // what a bilingual paragraph did before — repaints the grey note in the
    // heading's style.
    const styles = [
      '<w:rPr><w:b/><w:color w:val="2E75B6"/><w:sz w:val="26"/></w:rPr>',
      '<w:rPr><w:b/><w:sz w:val="26"/></w:rPr>',
      '<w:rPr><w:color w:val="888888"/><w:sz w:val="22"/></w:rPr>',
    ]
    const texts = ['Day 1 ', 'Arrive in Kuala Lumpur', ' [Kuala Lumpur]']
    const data = buildDocx(para(texts.map((text, index) => run(text, styles[index])).join('')))
    const doc = parseDocx(data)
    expect(doc.segments).toEqual(['Day 1 Arrive in Kuala Lumpur [Kuala Lumpur]'])

    const output = doc.rebuild(['第 1 天 抵达吉隆坡 [吉隆坡]'], true)
    const xml = readPart(output, 'word/document.xml')
    for (const [index, text] of texts.entries()) {
      expect(xml, text).toContain(
        `<w:r>${styles[index]}<w:t xml:space="preserve">${text}</w:t>`,
      )
    }
    // One `<w:t>` per source run plus the translation's: the source is there
    // once, not once per copy of the merged text.
    expect(xml.match(/<w:t /g)).toHaveLength(4)
    // The translation lands after the last `<w:t>`, still inside its run.
    expect(xml).toContain(
      '<w:t xml:space="preserve"> [Kuala Lumpur]</w:t><w:br/>' +
        '<w:t xml:space="preserve">第 1 天 抵达吉隆坡 [吉隆坡]</w:t></w:r>',
    )
    expect(paragraphTexts(output)).toEqual([
      'Day 1 Arrive in Kuala Lumpur [Kuala Lumpur]第 1 天 抵达吉隆坡 [吉隆坡]',
    ])
  })

  it('replaces the source with the translation when not bilingual', () => {
    const data = buildDocx(para(run(SOURCE)))
    const output = rebuild(data, [TRANSLATION], false)
    const xml = readPart(output, 'word/document.xml')
    expect(xml).not.toContain(SOURCE)
    expect(xml).not.toContain('<w:br/>')
    expect(paragraphTexts(output)).toEqual([TRANSLATION])
  })

  it('steps over bookmarks without skipping the paragraph', () => {
    const data = buildDocx(
      `<w:p><w:bookmarkStart w:id="1" w:name="intro"/><w:r><w:t xml:space="preserve">Introduction to the handbook</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>`,
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual(['Introduction to the handbook'])

    const output = doc.rebuild(['手册简介'], true)
    const xml = readPart(output, 'word/document.xml')
    expect(xml).toContain('<w:bookmarkStart w:id="1" w:name="intro"/>')
    expect(xml).toContain('<w:bookmarkEnd w:id="1"/>')
    expect(paragraphTexts(output)).toEqual(['Introduction to the handbook手册简介'])
  })

  it('skips paragraphs that hold a field code', () => {
    const data = buildDocx(
      para(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r>${run('Page number')}`),
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual([])
    expect(readPart(doc.rebuild([], true), 'word/document.xml')).toContain(
      '<w:instrText> PAGE </w:instrText>',
    )
  })

  it('skips paragraphs that hold a tracked deletion', () => {
    const data = buildDocx(
      `<w:p>${run('Kept text')}<w:del w:id="2" w:author="A"><w:r><w:delText>Removed text</w:delText></w:r></w:del></w:p>`,
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual([])
    expect(readPart(doc.rebuild([], false), 'word/document.xml')).toContain(
      '<w:delText>Removed text</w:delText>',
    )
  })

  it('skips paragraphs that hold a drawing', () => {
    const data = buildDocx(
      `<w:p><w:r><w:drawing/></w:r>${run('Caption under a picture')}</w:p>`,
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual([])
    expect(readPart(doc.rebuild([], false), 'word/document.xml')).toContain('<w:drawing/>')
  })

  it('skips paragraphs that hold an equation', () => {
    const data = buildDocx(
      `<w:p><m:oMath><m:r><w:t>E=mc</w:t></m:r></m:oMath>${run('Energy of the body')}</w:p>`,
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual([])
  })

  it('skips only the paragraph that holds a drawing, not the document', () => {
    // In a one-paragraph document a marker that skipped everything would look
    // the same as one that skips the paragraph, so the skip is measured against
    // prose that must still be translated.
    const data = buildDocx(
      '<w:p><w:r><w:drawing/></w:r><w:r><w:t>Caption</w:t></w:r></w:p><w:p><w:r><w:t>Real prose</w:t></w:r></w:p>',
    )
    expect(parseDocx(data).segments).toEqual(['Real prose'])
  })

  it('skips the paragraphs a text box holds, along with the drawing that holds it', () => {
    // The inner `</w:p>` of a text box must not be taken for the outer
    // paragraph's, or the box's remaining paragraphs read as prose.
    const data = buildDocx(
      `<w:p><w:r><w:drawing><w:txbxContent>${para(run('Box line one'))}${para(run('Box line two'))}</w:txbxContent></w:drawing></w:r></w:p>`,
    )
    expect(parseDocx(data).segments).toEqual([])
  })

  it('skips empty, self-closed and whitespace-only paragraphs', () => {
    const data = buildDocx(
      `<w:p/><w:p>${run('   ')}</w:p><w:p><w:r><w:rPr><w:b/></w:rPr></w:r></w:p><w:p><w:r><w:t/></w:r></w:p>`,
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual([])
    // Nothing translatable: the original bytes come straight back.
    expect(doc.rebuild([], true)).toBe(data)
  })

  it('writes a translation into a self-closing `<w:t/>` element', () => {
    const data = buildDocx(para(`<w:r><w:t/></w:r>${run('Filled in later')}`))
    const doc = parseDocx(data)
    expect(doc.segments).toEqual(['Filled in later'])

    const output = doc.rebuild([TRANSLATION], false)
    expect(paragraphTexts(output)).toEqual([TRANSLATION])
    // The empty element was replaced outright rather than left behind.
    const xml = readPart(output, 'word/document.xml')
    expect(xml).not.toContain('<w:t/>')
    expect(xml).toContain(`<w:t xml:space="preserve">${TRANSLATION}</w:t>`)
  })

  it('escapes XML metacharacters and keeps the part well-formed', () => {
    const data = buildDocx(para(run(SOURCE)))
    const output = rebuild(data, ['A & B < C'], false)

    const xml = readPart(output, 'word/document.xml')
    expect(xml).toContain('<w:t xml:space="preserve">A &amp; B &lt; C</w:t>')
    // Reading it back through an XML parser proves the escaping: an unescaped
    // `&` or `<` would abort the parse.
    expect(paragraphTexts(output)).toEqual(['A & B < C'])
  })

  it('preserves the surrounding spaces of a source run and trims the translation', () => {
    // Word keeps the spaces of a sentence inside its runs, so a whole chunk can
    // legitimately start or end with one; without `xml:space="preserve"` Word
    // would drop them when it renders the paragraph.
    const padded = '  Padded sentence  '
    const data = buildDocx(para(run(padded)))
    const doc = parseDocx(data)
    expect(doc.segments).toEqual([padded])

    const output = doc.rebuild([' 补白句子 '], true)
    expect(readPart(output, 'word/document.xml')).toContain(
      `<w:t xml:space="preserve">${padded}</w:t>`,
    )
    // Every handler trims the translation before it is written.
    expect(paragraphTexts(output)).toEqual([`${padded}补白句子`])
  })

  it('splits a paragraph into one segment per line break', () => {
    const data = buildDocx(
      para(
        `<w:r><w:t xml:space="preserve">First line</w:t><w:br/><w:t xml:space="preserve">Second line</w:t></w:r>`,
      ),
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual(['First line', 'Second line'])

    const output = doc.rebuild(['第一行', '第二行'], true)
    expect(paragraphTexts(output)).toEqual(['First line第一行Second line第二行'])
    // The source's own break is kept and one is added per bilingual pair.
    expect(readPart(output, 'word/document.xml').match(/<w:br\/>/g)).toHaveLength(3)
  })

  it('reads a tab stop in the paragraph properties as no text at all', () => {
    const data = buildDocx(
      `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Introduction</w:t></w:r></w:p>` +
        // A tab character in the body still stands for a space.
        `<w:p><w:r><w:t>Before</w:t><w:tab/><w:t>after</w:t></w:r></w:p>`,
    )
    expect(parseDocx(data).segments).toEqual(['Introduction', 'Before after'])
  })

  it('reads a non-breaking hyphen as a hyphen and a soft one as nothing', () => {
    const data = buildDocx(
      `<w:p><w:r><w:t>co</w:t><w:noBreakHyphen/><w:t>op</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>co</w:t><w:softHyphen/><w:t>op</w:t></w:r></w:p>`,
    )
    expect(parseDocx(data).segments).toEqual(['co-op', 'coop'])
  })

  it('keeps segments aligned with their paragraphs', () => {
    const data = buildDocx(
      [para(run('First paragraph')), para(run('Second paragraph')), para(run('Third paragraph'))].join(
        '',
      ),
    )
    const doc = parseDocx(data)
    expect(doc.segments).toEqual(['First paragraph', 'Second paragraph', 'Third paragraph'])

    const output = doc.rebuild(['第一段', '第二段', '第三段'], false)
    expect(paragraphTexts(output)).toEqual(['第一段', '第二段', '第三段'])
  })

  it('keeps the source of a segment that came back undefined', () => {
    const data = buildDocx([para(run('Keep me as I am')), para(run('Translate me'))].join(''))
    const output = rebuild(data, [undefined, '翻译我'], false)
    expect(paragraphTexts(output)).toEqual(['Keep me as I am', '翻译我'])
  })

  it('skips chunks that are a URL or an email address', () => {
    const data = buildDocx(
      [para(run('https://example.com/path')), para(run('someone@example.com')), para(run('Real prose'))].join(
        '',
      ),
    )
    expect(parseDocx(data).segments).toEqual(['Real prose'])
  })

  it('returns the original bytes when there is nothing to write', () => {
    const data = buildDocx(para(run(SOURCE)))
    expect(rebuild(data, [undefined], true)).toBe(data)
    // A translation identical to the source is not a change either.
    expect(rebuild(data, [SOURCE], true)).toBe(data)
  })

  it('rebuilds the same bytes on every call', () => {
    const data = buildDocx(para(run(SOURCE)))
    const doc = parseDocx(data)
    const first = doc.rebuild([TRANSLATION], true)
    const second = doc.rebuild([TRANSLATION], true)
    expect(Array.from(second)).toEqual(Array.from(first))
    // The source bytes were left alone, so a later download starts from them.
    expect(Array.from(doc.rebuild([undefined], true))).toEqual(Array.from(data))
  })

  it('copies unmodified zip members byte for byte', () => {
    const data = buildDocx(para(run(SOURCE)))
    const before = unzipSync(data)
    const after = unzipSync(rebuild(data, [TRANSLATION], true))
    for (const path of ['[Content_Types].xml', 'word/styles.xml', 'word/media/image1.png']) {
      expect(Array.from(after[path]), path).toEqual(Array.from(before[path]))
    }
    expect(Array.from(after['word/document.xml'])).not.toEqual(
      Array.from(before['word/document.xml']),
    )
  })

  it('parses the same bytes into the same segments every time', () => {
    const data = buildDocx([para(run(SOURCE)), para(run('Another line'))].join(''))
    expect(parseDocx(data).segments).toEqual(parseDocx(data).segments)
  })

  it('reports a clear error when the package has no document part', () => {
    const files: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      'word/styles.xml': strToU8(STYLES),
    }
    const data = new Uint8Array(zipSync(files))
    expect(() => parseDocx(data)).toThrow(/word\/document\.xml/)
  })

  it('takes .docx files through the files-page handler', async () => {
    const { getHandler } = await import('./documents')
    const file = new File([buildDocx(para(run(SOURCE)))], 'report.docx')
    const handler = getHandler(file)
    expect(handler?.kind).toBe('docx')
    const doc = await handler!.parse(file)
    expect(doc.segments).toEqual([SOURCE])
    expect(doc.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    const output = doc.rebuild([TRANSLATION], false)
    expect(output).toBeInstanceOf(Uint8Array)
    expect(paragraphTexts(output as Uint8Array)).toEqual([TRANSLATION])
  })
})
