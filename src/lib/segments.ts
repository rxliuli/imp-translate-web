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
