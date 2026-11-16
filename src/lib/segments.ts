export interface SourceRange {
  start: number
  end: number
  separator: string
}

// The server (imp-credits) rejects a request when its `texts` total more than
// 20,000 chars and chunks upstream calls at 4,000 chars, so a single segment
// may not exceed that chunk budget.
export const MAX_CHARS_PER_SEGMENT = 4000

// Sentence terminators, Latin and CJK, used to pick the nicest cut point.
const SENTENCE_END_RE = /[.!?。！？…]/

/**
 * Split text into contiguous pieces of at most `MAX_CHARS_PER_SEGMENT` chars.
 * Cuts prefer a sentence end, then a whitespace boundary, and only fall back to
 * a hard cut when a single word is longer than the budget. Pieces are exact
 * slices, so `pieces.join('') === text`.
 */
export function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHARS_PER_SEGMENT) return [text]

  const pieces: string[] = []
  let start = 0
  while (text.length - start > MAX_CHARS_PER_SEGMENT) {
    const cut = findCut(text, start, start + MAX_CHARS_PER_SEGMENT)
    pieces.push(text.slice(start, cut))
    start = cut
  }
  pieces.push(text.slice(start))
  return pieces
}

/** Index just past the last preferred break in `(start, limit]`. */
function findCut(text: string, start: number, limit: number): number {
  for (let i = limit; i > start; i--) {
    if (SENTENCE_END_RE.test(text[i - 1])) return i
  }
  for (let i = limit; i > start; i--) {
    if (/\s/.test(text[i - 1])) return i
  }
  return limit
}

/** One translatable piece of the source text and where it sits in it. */
interface Piece {
  text: string
  start: number
  end: number
}

/**
 * Every translatable piece of `text`, in document order. Blank lines are
 * dropped, and so is a piece `splitLongText` produces when a long whitespace run
 * straddles a cut: translating whitespace is pointless, and keeping it would
 * make `splitSegments` and `buildSourceRanges` disagree on how many segments the
 * text has (the text handler indexes translations by segment, so one extra
 * segment shifts every later translation).
 */
function scanPieces(text: string): Piece[] {
  const pieces: Piece[] = []
  let lineStart = 0
  for (;;) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    if (line.trim()) {
      let offset = lineStart
      for (const piece of splitLongText(line)) {
        const end = offset + piece.length
        if (piece.trim()) pieces.push({ text: piece, start: offset, end })
        offset = end
      }
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  return pieces
}

export function splitSegments(text: string): string[] {
  return scanPieces(text).map((piece) => piece.text)
}

export function buildSourceRanges(text: string): SourceRange[] {
  const pieces = scanPieces(text)
  return pieces.map((piece, i) => ({
    // A range's separator holds the whitespace *after* it, so the whitespace
    // before the first piece has nowhere to go and the first range starts at 0
    // to span it. `splitSegments` still sends only the piece's own text.
    start: i === 0 ? 0 : piece.start,
    end: piece.end,
    // Everything between two pieces was dropped as whitespace (blank lines and
    // whitespace-only pieces), so slicing that gap keeps the ranges byte-exact
    // no matter how long the run is.
    separator: text.slice(
      piece.end,
      i === pieces.length - 1 ? text.length : pieces[i + 1].start,
    ),
  }))
}

export interface MarkdownBlock {
  text: string
  translatable: boolean
}

const LIST_ITEM_RE = /^(\s*[-*+]|\s*\d+[.)]) /

function isListItem(line: string): boolean {
  return LIST_ITEM_RE.test(line)
}

export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  if (!text.trim()) return []

  const lines = text.split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0

  while (i < lines.length) {
    if (lines[i].trimStart().startsWith('```')) {
      const codeLines = [lines[i]]
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) {
        codeLines.push(lines[i])
        i++
      }
      blocks.push({ text: codeLines.join('\n'), translatable: false })
    } else if (lines[i].trim() === '') {
      const blankLines = []
      while (i < lines.length && lines[i].trim() === '') {
        blankLines.push(lines[i])
        i++
      }
      blocks.push({ text: blankLines.join('\n'), translatable: false })
    } else if (isListItem(lines[i])) {
      blocks.push({ text: lines[i], translatable: true })
      i++
    } else {
      const paraLines = []
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !lines[i].trimStart().startsWith('```') &&
        !isListItem(lines[i])
      ) {
        paraLines.push(lines[i])
        i++
      }
      blocks.push({ text: paraLines.join('\n'), translatable: true })
    }
  }

  return blocks
}
