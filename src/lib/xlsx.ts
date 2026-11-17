// XLSX support for the /files page: translate the workbook's shared strings and
// write each translation into the cell that shows it — below the source when
// `bilingual`, instead of it otherwise. Every cell that points at the same
// shared string gets the same text for free, because the string table is
// already the workbook's deduplication layer.
//
// The XML parts this touches are edited by locating substrings and splicing
// them, never by parsing and re-serialising a DOM: real workbooks carry
// `mc:Ignorable`, `vm:` attributes and self-closing tags that a round trip
// drops or rewrites, and Excel then refuses to open the file. Every part this
// module does not rewrite is copied into the new zip byte for byte.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

export interface ParsedXlsx {
  segments: string[]
  rebuild(translations: (string | undefined)[], bilingual: boolean): Uint8Array
}

const SHARED_STRINGS_PATH = 'xl/sharedStrings.xml'
const STYLES_PATH = 'xl/styles.xml'
const WORKSHEET_PATH_RE = /^xl\/worksheets\/[^/]+\.xml$/

/** Why a shared string is left alone; also the categories the debug line counts. */
type SkipReason =
  | 'rich-text'
  | 'phonetic'
  | 'empty'
  | 'not-simple'
  | 'url-or-email'
  | 'column'
  | 'unreferenced'

interface Splice {
  start: number
  end: number
  text: string
}

interface TextElement {
  /** Offsets of `<t ...>` and of the `</t>` that closes it. */
  openStart: number
  openEnd: number
  closeStart: number
  openTag: string
}

interface SharedStringEntry {
  /** Unescaped plain text; '' when the entry is not a single simple `<t>`. */
  text: string
  skip: SkipReason | null
  t: TextElement | null
}

interface StringCell {
  sheetPath: string
  column: string
  siIndex: number
  /** Offsets of the `<c ...>` open tag, so the style rewrite can splice it. */
  openStart: number
  openEnd: number
  openTag: string
}

function applySplices(text: string, splices: Splice[]): string {
  let out = ''
  let cursor = 0
  for (const splice of [...splices].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, splice.start) + splice.text
    cursor = splice.end
  }
  return out + text.slice(cursor)
}

function xmlUnescape(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (match, entity: string) => {
      switch (entity) {
        case 'amp':
          return '&'
        case 'lt':
          return '<'
        case 'gt':
          return '>'
        case 'quot':
          return '"'
        case 'apos':
          return "'"
        default: {
          const code =
            entity[1] === 'x'
              ? parseInt(entity.slice(2), 16)
              : parseInt(entity.slice(1), 10)
          return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
        }
      }
    },
  )
}

/** `&` first: escaping it last would turn the `&` of `&amp;` into `&amp;amp;`. */
function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const URL_RE = /^https?:\/\//i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isUrlOrEmail(text: string): boolean {
  return URL_RE.test(text) || EMAIL_RE.test(text)
}

/**
 * Every `<si>` of `sharedStrings.xml`, in table order, with the offsets of its
 * single `<t>` element. A `<si>` is only usable when it holds exactly one `<t>`:
 * rich-text runs (`<r>`) and phonetic hints (`<rPh>`) would need per-run
 * translation to keep their formatting, and this handler only ever rewrites a
 * plain text node.
 */
function parseSharedStrings(xml: string): SharedStringEntry[] {
  const entries: SharedStringEntry[] = []
  // Lazy attribute matcher, so a self-closing `<si/>` leaves `/` for group 2
  // instead of swallowing it into the attributes.
  const openRe = /<si(\s[^>]*?)?(\/)?>/g
  let match: RegExpExecArray | null
  while ((match = openRe.exec(xml))) {
    const innerStart = match.index + match[0].length
    if (match[2] === '/') {
      entries.push({ text: '', skip: 'empty', t: null })
      continue
    }
    const innerEnd = xml.indexOf('</si>', innerStart)
    if (innerEnd === -1) break
    entries.push(readSharedString(xml, innerStart, innerEnd))
    openRe.lastIndex = innerEnd + '</si>'.length
  }
  return entries
}

function readSharedString(
  xml: string,
  innerStart: number,
  innerEnd: number,
): SharedStringEntry {
  const inner = xml.slice(innerStart, innerEnd)
  if (/<rPh[\s/>]/.test(inner)) return { text: '', skip: 'phonetic', t: null }
  if (/<\/?r[\s/>]/.test(inner)) return { text: '', skip: 'rich-text', t: null }

  const tRe = /<t(\s[^>]*?)?(\/)?>/g
  const tMatch = tRe.exec(inner)
  if (!tMatch) return { text: '', skip: 'empty', t: null }
  if (tRe.exec(inner)) return { text: '', skip: 'not-simple', t: null }
  if (tMatch[2] === '/') return { text: '', skip: 'empty', t: null }

  const openStart = innerStart + tMatch.index
  const openEnd = openStart + tMatch[0].length
  const closeStart = xml.indexOf('</t>', openEnd)
  if (closeStart === -1) return { text: '', skip: 'not-simple', t: null }
  // Anything besides whitespace around the `<t>` means the `<si>` wraps more
  // than one element, which this handler does not know how to rewrite.
  if (inner.slice(0, tMatch.index).trim()) return { text: '', skip: 'not-simple', t: null }
  if (xml.slice(closeStart + '</t>'.length, innerEnd).trim()) {
    return { text: '', skip: 'not-simple', t: null }
  }

  const text = xmlUnescape(xml.slice(openEnd, closeStart))
  const trimmed = text.trim()
  if (!trimmed) return { text: '', skip: 'empty', t: null }
  if (isUrlOrEmail(trimmed)) return { text: '', skip: 'url-or-email', t: null }

  return {
    text,
    skip: null,
    t: { openStart, openEnd, closeStart, openTag: tMatch[0] },
  }
}

/** Every `<c r="A1" t="s"><v>N</v></c>` of one worksheet, in document order. */
function parseStringCells(xml: string, sheetPath: string): StringCell[] {
  const cells: StringCell[] = []
  const cellRe = /<c(\s[^>]*?)?(\/)?>/g
  let match: RegExpExecArray | null
  while ((match = cellRe.exec(xml))) {
    const attrs = match[1] ?? ''
    if (match[2] === '/') continue
    if (!/(?:^|\s)t="s"/.test(attrs)) continue
    const ref = /(?:^|\s)r="([A-Z]+)\d+"/.exec(attrs)
    if (!ref) continue
    const openEnd = match.index + match[0].length
    const closeStart = xml.indexOf('</c>', openEnd)
    if (closeStart === -1) break
    // Anchored on `<v>`: a cell that also holds `<f>` is a formula result, not
    // a shared string, and must be left alone.
    const value = /^\s*<v>\s*(\d+)\s*<\/v>\s*$/.exec(xml.slice(openEnd, closeStart))
    if (!value) continue
    cells.push({
      sheetPath,
      column: ref[1],
      siIndex: Number(value[1]),
      openStart: match.index,
      openEnd,
      openTag: match[0],
    })
  }
  return cells
}

// A "word" for column inference. CJK text has no spaces, so a whole Chinese
// sentence would otherwise count as one word and its column would look like a
// label column; each CJK character counts as a word instead.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g

function wordCount(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean).length
  return tokens + (text.match(CJK_RE)?.length ?? 0)
}

const ACCOUNT_TOKEN_RE = /[_-]|\d/

/**
 * Whether a column holds prose. Three shapes are rejected because translating
 * them wastes requests and produces nonsense in cells that the workbook uses as
 * keys: enumerations, identifier/account columns, and single-word labels.
 */
function columnTranslatable(values: string[]): boolean {
  const distinct = new Set(values)
  // Enumeration: a handful of repeated values (Complete/Unread/N/TBA).
  if (distinct.size <= 3) return false
  // Account names and IDs: short, almost all unique, and shaped like a token.
  const longest = Math.max(...values.map((value) => value.length))
  if (
    longest <= 32 &&
    distinct.size / values.length > 0.95 &&
    values.every((value) => ACCOUNT_TOKEN_RE.test(value))
  ) {
    return false
  }
  // Single-word labels (names, tags).
  const averageWords =
    values.reduce((sum, value) => sum + wordCount(value), 0) / values.length
  if (averageWords < 2) return false
  return true
}

function decisionKey(sheetPath: string, column: string): string {
  return `${sheetPath}!${column}`
}

function decideColumns(
  cells: StringCell[],
  entries: SharedStringEntry[],
): Map<string, boolean> {
  const values = new Map<string, string[]>()
  for (const cell of cells) {
    const entry = entries[cell.siIndex]
    if (!entry?.text) continue
    const key = decisionKey(cell.sheetPath, cell.column)
    const list = values.get(key)
    if (list) list.push(entry.text)
    else values.set(key, [entry.text])
  }
  const decisions = new Map<string, boolean>()
  for (const [key, list] of values) decisions.set(key, columnTranslatable(list))
  return decisions
}

/** One `console.debug` line so a real workbook's column verdicts can be checked. */
function report(
  decisions: Map<string, boolean>,
  entries: SharedStringEntry[],
  translatableCount: number,
): void {
  const columns = new Map<string, string[]>()
  for (const [key, translate] of [...decisions].sort()) {
    const separator = key.lastIndexOf('!')
    const sheet = key.slice(0, separator)
    const parts = columns.get(sheet)
    const label = `${key.slice(separator + 1)}=${translate ? 'translate' : 'skip'}`
    if (parts) parts.push(label)
    else columns.set(sheet, [label])
  }
  const skipped: Record<string, number> = {}
  for (const entry of entries) {
    if (!entry.skip) continue
    skipped[entry.skip] = (skipped[entry.skip] ?? 0) + 1
  }
  console.debug(
    `[xlsx] columns ${[...columns].map(([sheet, parts]) => `${sheet}: ${parts.join(' ')}`).join('; ')}`,
    `| translatable ${translatableCount}/${entries.length} si`,
    `| skipped ${JSON.stringify(skipped)}`,
  )
}

function withPreserve(openTag: string, preserve: boolean): string {
  const attrs = openTag.slice(2, -1)
  if (!preserve || attrs.includes('xml:space=')) return openTag
  return `<t xml:space="preserve"${attrs}>`
}

function withCellStyle(openTag: string, styleIndex: number): string {
  const close = openTag.endsWith('/>') ? '/>' : '>'
  const attrs = openTag.slice(2, openTag.length - close.length)
  const next = /(^|\s)s="/.test(attrs)
    ? attrs.replace(/(^|\s)s="[^"]*"/, `$1s="${styleIndex}"`)
    : ` s="${styleIndex}"${attrs}`
  return `<c${next}${close}`
}

interface CellXf {
  /** Attribute text of the `<xf ...>` open tag, leading space included. */
  attrs: string
  /** Markup between `<xf>` and `</xf>`; '' when the tag closed itself. */
  body: string
}

/** Every `<xf>` of `<cellXfs>`, in index order, as the text a copy starts from. */
function parseCellXfs(body: string): CellXf[] {
  const xfs: CellXf[] = []
  const openRe = /<xf(\s[^>]*?)?(\/)?>/g
  let match: RegExpExecArray | null
  while ((match = openRe.exec(body))) {
    if (match[2] === '/') {
      xfs.push({ attrs: match[1] ?? '', body: '' })
      continue
    }
    const innerStart = match.index + match[0].length
    const innerEnd = body.indexOf('</xf>', innerStart)
    if (innerEnd === -1) break
    xfs.push({ attrs: match[1] ?? '', body: body.slice(innerStart, innerEnd) })
    openRe.lastIndex = innerEnd + '</xf>'.length
  }
  return xfs
}

/** Replace `name="..."` where it already sits, or append it, never both. */
function setAttribute(attrs: string, name: string, value: string): string {
  const pattern = new RegExp(`(^|\\s)${name}="[^"]*"`)
  return pattern.test(attrs)
    ? attrs.replace(pattern, `$1${name}="${value}"`)
    : `${attrs} ${name}="${value}"`
}

/**
 * The xf's `<alignment>` with wrapping forced on: `vertical="top"` keeps the
 * source above the translation, and the attributes already there (centring,
 * reading direction) are kept as they were.
 */
function withWrapAlignment(xf: CellXf): string {
  const alignmentRe = /<alignment(\s[^>]*?)?(\/)?>(?:<\/alignment>)?/
  const match = alignmentRe.exec(xf.body)
  if (!match) {
    const alignment = '<alignment vertical="top" wrapText="1"/>'
    // `<xf>` children are ordered alignment, protection, extLst; appending after
    // a `<protection>` would put them out of order and Excel rejects the file.
    const later = /<(protection|extLst)[\s/>]/.exec(xf.body)
    return later
      ? `${xf.body.slice(0, later.index)}${alignment}${xf.body.slice(later.index)}`
      : `${xf.body}${alignment}`
  }
  const attrs = setAttribute(setAttribute(match[1] ?? '', 'vertical', 'top'), 'wrapText', '1')
  return `${xf.body.slice(0, match.index)}<alignment${attrs}/>${xf.body.slice(match.index + match[0].length)}`
}

/**
 * A copy of one `<xf>` with wrapping turned on. Every id of the source is kept,
 * so a translated cell keeps its font, border, fill and number format instead
 * of falling back to whatever the sheet's first format happens to be.
 */
function deriveWrapXf(xf: CellXf): string {
  return `<xf${setAttribute(xf.attrs, 'applyAlignment', '1')}>${withWrapAlignment(xf)}</xf>`
}

/**
 * Append one wrapped-text `<xf>` per distinct source style, in the order the
 * cells are met, and map each source index to its copy. Reusing one copy per
 * source keeps `<cellXfs>` from growing by a row count, and the copy is what
 * makes a bilingual cell wrap without losing the style it already had.
 */
function addWrapStyles(
  xml: string,
  sources: number[],
): { xml: string; styles: Map<number, number> } | null {
  const openMatch = /<cellXfs(\s[^>]*?)?>/.exec(xml)
  if (!openMatch) return null
  const openEnd = openMatch.index + openMatch[0].length
  const closeStart = xml.indexOf('</cellXfs>', openEnd)
  if (closeStart === -1) return null

  const xfs = parseCellXfs(xml.slice(openEnd, closeStart))
  const styles = new Map<number, number>()
  const appended: string[] = []
  for (const source of sources) {
    if (styles.has(source)) continue
    const base = xfs[source]
    // An `s` outside the array cannot be derived from; leaving the cell alone is
    // better than pointing it at a format that is not its own.
    if (!base) continue
    styles.set(source, xfs.length + appended.length)
    appended.push(deriveWrapXf(base))
  }
  if (appended.length === 0) return null

  const attrs = openMatch[1] ?? ''
  const declared = /\bcount="(\d+)"/.exec(attrs)
  const count = `count="${(declared ? Number(declared[1]) : xfs.length) + appended.length}"`
  const nextAttrs = declared
    ? attrs.replace(/\bcount="\d+"/, count)
    : `${attrs} ${count}`

  return {
    styles,
    xml: applySplices(xml, [
      { start: openMatch.index, end: openEnd, text: `<cellXfs${nextAttrs}>` },
      { start: closeStart, end: closeStart, text: appended.join('') },
    ]),
  }
}

/** A cell's style index; a missing `s` means the default cell format, 0. */
function cellStyleIndex(openTag: string): number {
  const match = /(?:^|\s)s="(\d+)"/.exec(openTag)
  return match ? Number(match[1]) : 0
}

export function parseXlsx(data: Uint8Array): ParsedXlsx {
  const files = unzipSync(data)
  const sheetPaths = Object.keys(files).filter((p) => WORKSHEET_PATH_RE.test(p)).sort()
  const sheetXmls = new Map(
    sheetPaths.map((path) => [path, strFromU8(files[path])] as const),
  )
  const sstXml = files[SHARED_STRINGS_PATH]
    ? strFromU8(files[SHARED_STRINGS_PATH])
    : ''

  const entries = sstXml ? parseSharedStrings(sstXml) : []
  const cells = sheetPaths.flatMap((path) => parseStringCells(sheetXmls.get(path)!, path))
  const decisions = decideColumns(cells, entries)

  // A shared string is offered for translation only when every column that
  // points at it holds prose: one account-name column sharing an enum value
  // must not drag that value into the request.
  const references = new Map<number, string[]>()
  for (const cell of cells) {
    const key = decisionKey(cell.sheetPath, cell.column)
    const list = references.get(cell.siIndex)
    if (list) list.push(key)
    else references.set(cell.siIndex, [key])
  }
  const translatable: number[] = []
  entries.forEach((entry, index) => {
    if (entry.skip) return
    const columns = references.get(index)
    if (!columns || columns.length === 0) {
      entry.skip = 'unreferenced'
      return
    }
    if (columns.some((key) => !decisions.get(key))) {
      entry.skip = 'column'
      return
    }
    translatable.push(index)
  })

  report(decisions, entries, translatable.length)

  return {
    segments: translatable.map((index) => entries[index].text),
    rebuild(translations, bilingual) {
      const changed = new Map<number, string>()
      translatable.forEach((siIndex, position) => {
        const entry = entries[siIndex]
        const translation = translations[position]?.trim()
        if (!translation || translation === entry.text.trim()) return
        changed.set(siIndex, bilingual ? `${entry.text}\n${translation}` : translation)
      })
      // Nothing to write: hand back the original bytes so an untouched
      // workbook cannot drift (and so a not-yet-translated file still opens).
      if (changed.size === 0) return data

      const sstSplices: Splice[] = []
      for (const [siIndex, text] of changed) {
        const t = entries[siIndex].t
        if (!t) continue
        sstSplices.push({
          start: t.openStart,
          end: t.closeStart + '</t>'.length,
          text: `${withPreserve(t.openTag, /\n|^\s|\s$/.test(text))}${xmlEscape(text)}</t>`,
        })
      }

      const output: Record<string, Uint8Array> = { ...files }
      output[SHARED_STRINGS_PATH] = strToU8(applySplices(sstXml, sstSplices))

      const translated = cells.filter((cell) => changed.has(cell.siIndex))
      const style = files[STYLES_PATH]
        ? addWrapStyles(
            strFromU8(files[STYLES_PATH]),
            translated.map((cell) => cellStyleIndex(cell.openTag)),
          )
        : null
      if (style) {
        output[STYLES_PATH] = strToU8(style.xml)
        const cellSplices = new Map<string, Splice[]>()
        for (const cell of translated) {
          const styleIndex = style.styles.get(cellStyleIndex(cell.openTag))
          if (styleIndex === undefined) continue
          const list = cellSplices.get(cell.sheetPath) ?? []
          list.push({
            start: cell.openStart,
            end: cell.openEnd,
            text: withCellStyle(cell.openTag, styleIndex),
          })
          cellSplices.set(cell.sheetPath, list)
        }
        for (const [path, splices] of cellSplices) {
          output[path] = strToU8(applySplices(sheetXmls.get(path)!, splices))
        }
      }

      return new Uint8Array(zipSync(output))
    },
  }
}
