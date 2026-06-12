export interface ParsedSubtitle {
  segments: string[]
  rebuild(translations: string[]): string
}

interface SrtEntry {
  index: string
  time: string
  text: string
}

function parseSrtEntries(content: string): SrtEntry[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!normalized) return []

  const blocks = normalized.split(/\n\n+/)
  const entries: SrtEntry[] = []

  for (const block of blocks) {
    const lines = block.split('\n')
    if (lines.length < 3) continue
    const index = lines[0].trim()
    const time = lines[1].trim()
    if (!time.includes('-->')) continue
    const text = lines.slice(2).join('\n')
    entries.push({ index, time, text })
  }

  return entries
}

export function parseSrt(content: string): ParsedSubtitle {
  const entries = parseSrtEntries(content)
  return {
    segments: entries.map((e) => e.text),
    rebuild(translations) {
      return (
        entries
          .map((e, i) => `${e.index}\n${e.time}\n${translations[i] ?? e.text}`)
          .join('\n\n') + '\n'
      )
    },
  }
}

interface AssDialogue {
  lineIndex: number
  prefix: string
  leadingTags: string
  text: string
}

function extractAssText(rawText: string): { leadingTags: string; text: string } {
  let leadingTags = ''
  let rest = rawText
  while (rest.startsWith('{')) {
    const end = rest.indexOf('}')
    if (end === -1) break
    leadingTags += rest.slice(0, end + 1)
    rest = rest.slice(end + 1)
  }
  const text = rest
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
  return { leadingTags, text }
}

function findTextFieldIndex(formatLine: string): number {
  const fields = formatLine
    .replace(/^Format:\s*/i, '')
    .split(',')
    .map((f) => f.trim().toLowerCase())
  return fields.indexOf('text')
}

function parseAssDialogues(lines: string[]): AssDialogue[] {
  const dialogues: AssDialogue[] = []
  let textFieldIndex = 9

  for (let i = 0; i < lines.length; i++) {
    if (/^Format:\s*/i.test(lines[i])) {
      const idx = findTextFieldIndex(lines[i])
      if (idx >= 0) textFieldIndex = idx
    }
    if (!/^Dialogue:\s*/i.test(lines[i])) continue

    const afterDialogue = lines[i].replace(/^Dialogue:\s*/i, '')
    const parts: string[] = []
    let start = 0
    for (let c = 0; c < textFieldIndex && start < afterDialogue.length; c++) {
      const comma = afterDialogue.indexOf(',', start)
      if (comma === -1) break
      parts.push(afterDialogue.slice(start, comma))
      start = comma + 1
    }
    const rawText = afterDialogue.slice(start)
    const prefix = 'Dialogue: ' + parts.join(',') + ','
    const { leadingTags, text } = extractAssText(rawText)

    if (text.trim()) {
      dialogues.push({ lineIndex: i, prefix, leadingTags, text })
    }
  }

  return dialogues
}

export function parseAss(content: string): ParsedSubtitle {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const dialogues = parseAssDialogues(lines)

  return {
    segments: dialogues.map((d) => d.text),
    rebuild(translations) {
      const result = [...lines]
      dialogues.forEach((d, i) => {
        const translated = (translations[i] ?? d.text).replace(/\n/g, '\\N')
        result[d.lineIndex] = d.prefix + d.leadingTags + translated
      })
      return result.join('\n')
    },
  }
}

export function parseSubtitle(content: string, filename: string): ParsedSubtitle {
  if (filename.toLowerCase().endsWith('.ass') || filename.toLowerCase().endsWith('.ssa')) {
    return parseAss(content)
  }
  return parseSrt(content)
}
