// Unifies EPUB/HTML/Markdown/Text file handling behind one small interface so
// the /files route (and its upload/queue/progress/download code) doesn't need
// to know the specifics of any one format.

import { strToU8 } from 'fflate'
import { parseEpub } from './epub'
import { parseHtml, applyTranslations } from './html'
import { parseSubtitle } from './subtitle'
import { splitMarkdownBlocks, splitSegments, buildSourceRanges } from './segments'

export interface ParsedDocument {
  /** One entry per translatable segment, in document order. */
  segments: string[]
  /**
   * Rebuild the document with the given translations applied. `translations`
   * has one entry per segment; `undefined` means "not translated yet / use
   * the source text".
   */
  rebuild(
    translations: (string | undefined)[],
    bilingual: boolean,
  ): Blob | Uint8Array | string
  mimeType: string
}

export type DocumentKind = 'epub' | 'html' | 'markdown' | 'text' | 'subtitle'

export interface DocumentHandler {
  kind: DocumentKind
  extensions: string[]
  parse(file: File): Promise<ParsedDocument>
}

/**
 * Bilingual layout shared by the markdown and text handlers: the source
 * segment, a blank line, then the translation. Falls back to the source
 * alone when there is no (meaningfully different) translation yet.
 */
function layoutSegment(
  source: string,
  translation: string | undefined,
  bilingual: boolean,
): string {
  const trimmed = translation?.trim()
  if (!trimmed || trimmed === source.trim()) return source
  if (!bilingual) return translation!
  return `${source}\n\n${translation}`
}

const epubHandler: DocumentHandler = {
  kind: 'epub',
  extensions: ['.epub'],
  async parse(file) {
    const data = new Uint8Array(await file.arrayBuffer())
    const parsed = parseEpub(data)
    return {
      segments: parsed.segments,
      mimeType: 'application/epub+zip',
      rebuild(translations, bilingual) {
        const filled = translations.map((t, i) => t ?? parsed.segments[i])
        return parsed.rebuild(filled, bilingual)
      },
    }
  },
}

const htmlHandler: DocumentHandler = {
  kind: 'html',
  extensions: ['.html', '.htm'],
  async parse(file) {
    const text = await file.text()
    const initial = parseHtml(text)
    return {
      segments: initial.segments,
      mimeType: 'text/html;charset=utf-8',
      rebuild(translations, bilingual) {
        // Re-parse from source each time: applyTranslations mutates the doc
        // in place, so reusing the same Document across calls (e.g. a retry
        // followed by a download) would double up bilingual insertions.
        const parsed = parseHtml(text)
        if (parsed.segments.length === 0) return parsed.serialize()
        const values = parsed.segments.map((s, i) => translations[i] ?? s)
        applyTranslations(parsed.doc, values, bilingual)
        return parsed.serialize()
      },
    }
  },
}

const markdownHandler: DocumentHandler = {
  kind: 'markdown',
  extensions: ['.md', '.markdown'],
  async parse(file) {
    const text = await file.text()
    const blocks = splitMarkdownBlocks(text)
    const segments = blocks.filter((b) => b.translatable).map((b) => b.text)
    return {
      segments,
      mimeType: 'text/markdown;charset=utf-8',
      rebuild(translations, bilingual) {
        let i = 0
        return blocks
          .map((block) => {
            if (!block.translatable) return block.text
            const translation = translations[i]
            i++
            return layoutSegment(block.text, translation, bilingual)
          })
          .join('\n')
      },
    }
  },
}

/**
 * Bilingual layout for subtitle cues: source line(s) then the translation,
 * joined with a single newline so the pair stays inside one cue — a blank
 * line (as `layoutSegment` above uses) would read as a new SRT entry, and
 * `parseAss`'s rebuild collapses `\n` to `\N` for us, so this also works for
 * ASS/SSA dialogue lines.
 */
function layoutSubtitleSegment(
  source: string,
  translation: string | undefined,
  bilingual: boolean,
): string {
  const trimmed = translation?.trim()
  if (!trimmed || trimmed === source.trim()) return source
  if (!bilingual) return translation!
  return `${source}\n${translation}`
}

const subtitleHandler: DocumentHandler = {
  kind: 'subtitle',
  extensions: ['.srt', '.ass', '.ssa'],
  async parse(file) {
    const text = await file.text()
    const parsed = parseSubtitle(text, file.name)
    return {
      segments: parsed.segments,
      mimeType: 'text/plain;charset=utf-8',
      rebuild(translations, bilingual) {
        const values = parsed.segments.map((s, i) =>
          layoutSubtitleSegment(s, translations[i], bilingual),
        )
        return parsed.rebuild(values)
      },
    }
  },
}

const textHandler: DocumentHandler = {
  kind: 'text',
  extensions: ['.txt'],
  async parse(file) {
    const text = await file.text()
    const segments = splitSegments(text)
    return {
      segments,
      mimeType: 'text/plain;charset=utf-8',
      rebuild(translations, bilingual) {
        const ranges = buildSourceRanges(text)
        return ranges
          .map((range, i) => {
            const source = text.slice(range.start, range.end)
            return layoutSegment(source, translations[i], bilingual) + range.separator
          })
          .join('')
      },
    }
  },
}

const HANDLERS: DocumentHandler[] = [
  epubHandler,
  htmlHandler,
  markdownHandler,
  subtitleHandler,
  textHandler,
]

export function getHandler(file: File): DocumentHandler | undefined {
  const dot = file.name.lastIndexOf('.')
  if (dot === -1) return undefined
  const ext = file.name.slice(dot).toLowerCase()
  return HANDLERS.find((h) => h.extensions.includes(ext))
}

/** Convert a `ParsedDocument.rebuild()` result into bytes, for zip bundling. */
export function toBytes(data: Blob | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return strToU8(data)
  if (data instanceof Uint8Array) return data
  throw new Error('Blob output is not supported for zip bundling')
}

/** Convert a `ParsedDocument.rebuild()` result into a downloadable Blob. */
export function toBlob(data: Blob | Uint8Array | string, mimeType: string): Blob {
  if (data instanceof Blob) return data
  return new Blob([data as BlobPart], { type: mimeType })
}
