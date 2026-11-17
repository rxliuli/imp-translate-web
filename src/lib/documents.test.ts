import { describe, it, expect } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { getHandler, type ParsedDocument } from './documents'
import { MAX_CHARS_PER_SEGMENT } from './segments'
import {
  accumulateBatchResults,
  BATCH_SIZE,
  MAX_CHARS_PER_REQUEST,
  packBatches,
  type Batch,
} from './useFileTranslation'

// One 25,000-char run: longer than a single request may carry, and longer than
// one translatable piece.
const LONG_RUN = 'word '.repeat(5000)

function docxFile(paragraph: string): File {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${paragraph}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  }
  return new File([new Uint8Array(zipSync(files))], 'long.docx')
}

function epubFile(paragraph: string): File {
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
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">T</dc:title></metadata>
  <manifest><item id="ch0" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch0"/></spine>
</package>`,
    ),
    'ch1.xhtml': strToU8(
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>T</title></head>
<body><p>${paragraph}</p></body>
</html>`,
    ),
  }
  return new File([new Uint8Array(zipSync(files))], 'long.epub')
}

// Handlers that cannot cut a long run at a structural boundary.
const UNSplitInputs: [string, () => File][] = [
  ['html', () => new File([`<p>${LONG_RUN}</p>`], 'long.html')],
  ['markdown', () => new File([LONG_RUN], 'long.md')],
  ['subtitle', () => new File([`1\n00:00:01,000 --> 00:00:04,000\n${LONG_RUN}\n`], 'long.srt')],
  ['epub', () => epubFile(LONG_RUN)],
  ['docx', () => docxFile(LONG_RUN)],
]

const batchChars = (batch: Batch) =>
  batch.texts.reduce((sum, text) => sum + text.length, 0)

/** `rebuild` returns a union; the text handler always returns a string. */
function rebuildText(doc: ParsedDocument, translations: (string | undefined)[]): string {
  const output = doc.rebuild(translations, false)
  if (typeof output !== 'string') throw new Error(`expected text, got ${typeof output}`)
  return output
}

describe('document segments within the request budget', () => {
  for (const [kind, makeFile] of UNSplitInputs) {
    it(`sends ${kind} within both request bounds and keeps one result per segment`, async () => {
      const file = makeFile()
      const doc = await getHandler(file)!.parse(file)
      // The handler hands the queue a segment longer than a whole request.
      expect(doc.segments.some((segment) => segment.length > MAX_CHARS_PER_REQUEST)).toBe(
        true,
      )

      const indices = doc.segments.map((_, i) => i)
      const { batches, piecesPerSegment } = packBatches(doc.segments, indices)
      expect(batches.every((batch) => batch.texts.length <= BATCH_SIZE)).toBe(true)
      expect(batches.every((batch) => batchChars(batch) <= MAX_CHARS_PER_REQUEST)).toBe(
        true,
      )
      expect(
        batches.every((batch) =>
          batch.texts.every((text) => text.length <= MAX_CHARS_PER_SEGMENT),
        ),
      ).toBe(true)

      // Echoing each text back as its translation proves the pieces are rejoined
      // into one result per source segment, in order, with nothing lost.
      const pending = new Map<number, string[]>()
      const translations: (string | undefined)[] = new Array(doc.segments.length)
      for (const batch of batches) {
        accumulateBatchResults(pending, piecesPerSegment, batch, batch.texts).forEach(
          (translation, segment) => {
            translations[segment] = translation
          },
        )
      }
      expect(translations).toEqual(doc.segments)
    })
  }

  it('rebuilds a text document byte-for-byte around long whitespace runs', async () => {
    const text =
      ' '.repeat(5000) + 'hello\n' + 'word' + ' '.repeat(4000) + '\nsecond line'
    const file = new File([text], 'spacey.txt')
    const doc = await getHandler(file)!.parse(file)

    // Nothing translated yet: the rebuild reproduces the source exactly, with
    // no whitespace-only segment in between.
    expect(rebuildText(doc, doc.segments.map(() => undefined))).toBe(text)
    // Every translation lands on its own source text: if the ranges and the
    // segments disagree about a blank piece, one label goes unused and the rest
    // shift onto the wrong source (the text handler indexes translations by
    // range).
    const labelled = rebuildText(doc, doc.segments.map((_, i) => `T${i}`))
    expect(labelled.match(/T\d+/g)).toEqual(doc.segments.map((_, i) => `T${i}`))
  })

  it('splits a text document into pieces instead of one segment', async () => {
    const file = new File([LONG_RUN], 'long.txt')
    const doc = await getHandler(file)!.parse(file)
    expect(doc.segments.length).toBeGreaterThan(1)
    expect(doc.segments.every((segment) => segment.length <= MAX_CHARS_PER_SEGMENT)).toBe(
      true,
    )
    expect(doc.segments.join('')).toBe(LONG_RUN)
  })
})
