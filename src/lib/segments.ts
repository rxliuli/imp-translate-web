export interface SourceRange {
  start: number
  end: number
  separator: string
}

export function splitSegments(text: string): string[] {
  return text.split('\n').filter((s) => s.trim())
}

export function buildSourceRanges(text: string): SourceRange[] {
  const ranges: SourceRange[] = []
  const regex = /\n/g
  let lastEnd = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    const segText = text.slice(lastEnd, match.index)
    if (segText.trim()) {
      ranges.push({
        start: lastEnd,
        end: match.index,
        separator: match[0],
      })
    } else {
      if (ranges.length > 0) {
        ranges[ranges.length - 1].separator += match[0]
      }
    }
    lastEnd = match.index + match[0].length
  }
  if (lastEnd < text.length && text.slice(lastEnd).trim()) {
    ranges.push({ start: lastEnd, end: text.length, separator: '' })
  }
  return ranges
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
