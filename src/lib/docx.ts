// DOCX support for the /files page: translate the prose of `word/document.xml`
// in place — the translation replaces the source run, or is added below it
// inside the same paragraph when `bilingual`. Word splits a sentence across
// several runs for reasons that carry no meaning (`w:proofErr`, spell-check
// boundaries, a bold word in the middle), so the runs of a paragraph are merged
// into one segment before translation and written back as a single run.
//
// Like the XLSX handler, the XML is edited by locating substrings and splicing
// them, never by parsing and re-serialising a DOM: real documents carry
// `mc:Ignorable`, `w14:paraId` and self-closing tags that a round trip drops or
// rewrites, and Word then refuses to open the file. Every part this module does
// not rewrite is copied into the new zip byte for byte.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { applySplices, xmlEscape, xmlUnescape, type Splice } from './ooxml'

export interface ParsedDocx {
  segments: string[]
  rebuild(translations: (string | undefined)[], bilingual: boolean): Uint8Array
}

const DOCUMENT_PATH = 'word/document.xml'

/** Why a piece of text is left alone; also the categories the debug line counts. */
type SkipReason =
  | 'field-code'
  | 'tracked-delete'
  | 'embedded-object'
  | 'equation'
  | 'empty'
  | 'url-or-email'

/**
 * Markers that make a whole paragraph untouchable. Everything else in a
 * paragraph — `w:rPr`, `w:proofErr`, bookmarks, `w:ins` — is transparent: it
 * neither contributes text nor stops the paragraph from being translated.
 */
const SKIP_MARKERS: [RegExp, SkipReason][] = [
  // Field codes (`PAGE`, `REF`, `TOC`): the visible result is a cached value
  // Word recomputes, so replacing it would just be thrown away.
  [/<w:instrText[\s/>]/, 'field-code'],
  // Tracked deletions: the text is already struck out and must stay that way.
  [/<w:delText[\s/>]/, 'tracked-delete'],
  // Images, shapes, text boxes and embedded objects.
  [/<(?:w:drawing|w:pict|w:object)[\s/>]/, 'embedded-object'],
  // Equations (OMML) are maths, not prose.
  [/<m:oMath[\s/>]/, 'equation'],
]

const URL_RE = /^https?:\/\//i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isUrlOrEmail(text: string): boolean {
  return URL_RE.test(text) || EMAIL_RE.test(text)
}

interface TextElement {
  /** Offsets of `<w:t ...>` and of the `</w:t>` that closes it. */
  openStart: number
  openEnd: number
  closeStart: number
  closeEnd: number
}

interface Chunk {
  /** Unescaped text of every `<w:t>` of the chunk, in document order. */
  text: string
  /** The `<w:t>` elements it was read from; never empty. */
  t: TextElement[]
}

/**
 * The chunks of one paragraph: its text split at each `<w:br/>` / `<w:cr/>`,
 * which is how Word records a line break inside a single paragraph. Only
 * `<w:t>` carries text, `<w:tab/>` is layout (a space in the merged text) and
 * `<w:noBreakHyphen/>` stands for the hyphen it renders; every other element is
 * stepped over.
 */
function paragraphChunks(inner: string, innerStart: number): Chunk[] {
  const chunks: Chunk[] = []
  let current: Chunk = { text: '', t: [] }
  const flush = () => {
    if (current.t.length > 0) chunks.push(current)
    current = { text: '', t: [] }
  }

  // `<w:pPr>` holds the paragraph's properties and is its first child. Its
  // `<w:tab>` elements declare tab stops (`<w:tabs>`) instead of typing a tab
  // character, so the whole block is stepped over before the text is read.
  const pPrOpen = /<w:pPr(?=[\s/>])/.exec(inner)
  const pPrClose = pPrOpen ? inner.indexOf('</w:pPr>', pPrOpen.index) : -1
  const pPrEnd = pPrClose === -1 ? 0 : pPrClose + '</w:pPr>'.length

  // Lazy attribute matcher, so a self-closing `<w:t/>` leaves `/` for group 3
  // instead of swallowing it into the attributes.
  const tokenRe = /<(w:t|w:tab|w:br|w:cr|w:noBreakHyphen|w:softHyphen)(?=[\s/>])([^>]*?)(\/)?>/g
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(inner))) {
    if (match.index < pPrEnd) {
      tokenRe.lastIndex = pPrEnd
      continue
    }
    const name = match[1]
    const openStart = innerStart + match.index
    const openEnd = openStart + match[0].length
    const afterOpen = match.index + match[0].length

    if (name === 'w:br' || name === 'w:cr') {
      flush()
      // The paired form `<w:br></w:br>` is legal; step over it so its content
      // cannot be read as the next chunk's text.
      if (match[3] !== '/') {
        const close = inner.indexOf(`</${name}>`, afterOpen)
        if (close !== -1) tokenRe.lastIndex = close + name.length + 3
      }
      continue
    }

    if (name === 'w:tab') {
      // A tab is layout, not text: keep one space where it stood so the merged
      // sentence does not run its neighbours together.
      current.text += ' '
      continue
    }

    if (name === 'w:noBreakHyphen') {
      // A non-breaking hyphen renders a character of its own, so it belongs in
      // the merged sentence; it holds no `<w:t>` of its own to write back to.
      current.text += '-'
      continue
    }

    if (name === 'w:softHyphen') {
      // A soft hyphen is an invisible break opportunity: it renders nothing.
      continue
    }

    if (match[3] === '/') {
      // `<w:t/>`: an empty element, with no text region inside it.
      current.t.push({ openStart, openEnd, closeStart: openEnd, closeEnd: openEnd })
      continue
    }

    const close = inner.indexOf('</w:t>', afterOpen)
    if (close === -1) break
    const closeStart = innerStart + close
    current.t.push({
      openStart,
      openEnd,
      closeStart,
      closeEnd: closeStart + '</w:t>'.length,
    })
    current.text += xmlUnescape(inner.slice(afterOpen, close))
  }
  flush()
  return chunks
}

/**
 * The offset of the `</w:p>` closing the paragraph opened at `openStart`.
 * Paragraphs nest — a text box sits inside the `w:drawing` of an outer
 * paragraph and holds paragraphs of its own — so the first `</w:p>` after an
 * open tag may close an inner one. Counting depth pairs the right tag;
 * `undefined` means the part ends before the paragraph does.
 */
function findParagraphEnd(xml: string, openStart: number): number | undefined {
  const tagRe = /<\/?w:p(?=[\s/>])([^>]*?)(\/)?>/g
  tagRe.lastIndex = openStart
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(xml))) {
    if (match[0][1] === '/') {
      depth -= 1
      if (depth === 0) return match.index
    } else if (match[2] !== '/') {
      // `<w:p/>` is an empty paragraph: it pairs with nothing.
      depth += 1
    }
  }
  return undefined
}

/** Every translatable chunk of `word/document.xml`, in document order. */
function collectChunks(xml: string): {
  chunks: Chunk[]
  skipped: Record<string, number>
} {
  const chunks: Chunk[] = []
  const skipped: Record<string, number> = {}
  const skip = (reason: SkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  const paragraphRe = /<w:p(?=[\s/>])([^>]*?)(\/)?>/g
  let match: RegExpExecArray | null
  while ((match = paragraphRe.exec(xml))) {
    // `<w:p/>`: an empty paragraph, and nothing to translate in it.
    if (match[2] === '/') continue
    const innerStart = match.index + match[0].length
    const innerEnd = findParagraphEnd(xml, match.index)
    if (innerEnd === undefined) break
    // Past the paragraph's own closing tag: every paragraph it contains — a
    // text box's, and the `mc:Fallback` copy of those — was just decided along
    // with it and must not be read as a paragraph of its own.
    paragraphRe.lastIndex = innerEnd + '</w:p>'.length

    const inner = xml.slice(innerStart, innerEnd)
    const marker = SKIP_MARKERS.find(([pattern]) => pattern.test(inner))
    if (marker) {
      skip(marker[1])
      continue
    }

    for (const chunk of paragraphChunks(inner, innerStart)) {
      const trimmed = chunk.text.trim()
      if (!trimmed) {
        skip('empty')
        continue
      }
      if (isUrlOrEmail(trimmed)) {
        skip('url-or-email')
        continue
      }
      chunks.push(chunk)
    }
  }
  return { chunks, skipped }
}

/** One `console.debug` line so a real document's verdicts can be checked. */
function report(segmentCount: number, skipped: Record<string, number>): void {
  console.debug(
    `[docx] translatable ${segmentCount} chunks`,
    `| skipped ${JSON.stringify(skipped)}`,
  )
}

/**
 * A `<w:t>` holding `text`. `xml:space="preserve"` is always set: Word trims a
 * leading or trailing space without it, and both a translation and the source
 * it sits under (which keeps the spaces Word stored inside its own runs) can
 * carry one.
 */
function textElement(text: string): string {
  return `<w:t xml:space="preserve">${xmlEscape(text)}</w:t>`
}

export function parseDocx(data: Uint8Array): ParsedDocx {
  const files = unzipSync(data)
  const part = files[DOCUMENT_PATH]
  if (!part) {
    throw new Error(`missing ${DOCUMENT_PATH}: this is not a Word document`)
  }
  const xml = strFromU8(part)
  const { chunks, skipped } = collectChunks(xml)
  report(chunks.length, skipped)

  return {
    segments: chunks.map((chunk) => chunk.text),
    rebuild(translations, bilingual) {
      const splices: Splice[] = []
      chunks.forEach((chunk, position) => {
        const translation = translations[position]?.trim()
        if (!translation || translation === chunk.text.trim()) return

        // Bilingual: not one source `<w:t>` is touched, so every run keeps the
        // formatting Word gave it (a coloured heading and its grey sub-line are
        // separate runs of the same paragraph) and the source cannot be left
        // behind twice. A newline inside `<w:t>` does not break the line in
        // Word, `<w:br/>` does; a new paragraph would inherit the list
        // numbering of this one, so the translation goes into the chunk's last
        // run instead.
        if (bilingual) {
          const last = chunk.t[chunk.t.length - 1]
          splices.push({
            start: last.closeEnd,
            end: last.closeEnd,
            text: `<w:br/>${textElement(translation)}`,
          })
          return
        }

        // Target only: the translation replaces the source, which is spread
        // over the chunk's runs, so it lands in the first `<w:t>`.
        const [first, ...rest] = chunk.t
        splices.push({
          start: first.openStart,
          end: first.closeEnd,
          text: textElement(translation),
        })
        // The chunk's remaining runs keep their elements (and their
        // formatting) but lose their text: removing the elements would leave
        // the surrounding `<w:r>` with children Word does not expect.
        for (const element of rest) {
          if (element.closeStart === element.openEnd) continue
          splices.push({ start: element.openEnd, end: element.closeStart, text: '' })
        }
      })
      // Nothing to write: hand back the original bytes so an untouched document
      // cannot drift (and so a not-yet-translated file still opens).
      if (splices.length === 0) return data

      const output: Record<string, Uint8Array> = { ...files }
      output[DOCUMENT_PATH] = strToU8(applySplices(xml, splices))
      return new Uint8Array(zipSync(output))
    },
  }
}
