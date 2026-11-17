// CSV support for the /files page: translate the text cells of a delimited file
// and write each translation into the cell it came from — below the source when
// `bilingual`, instead of it otherwise.
//
// Unlike the xlsx and docx handlers there is no markup to splice: a delimited
// file has no structure beyond its bytes, so the whole grid is parsed and
// serialised back with Papa. That is also why the output is not promised byte
// for byte — re-serialising normalises the quoting style (a `"abc"` that needed
// no quotes loses them), which is semantically identical but a different file.
//
// The encoding needs more care than the other handlers do. CSV exports arrive
// as UTF-8, as UTF-16 with a BOM, and as GBK from Excel on a Chinese Windows,
// and none of them say which; the output is always UTF-8 (the only encoding a
// browser can write), with a BOM whenever the file did not arrive as plain
// UTF-8, so Excel opens it without mojibake.

import Papa from 'papaparse'
import { classifyColumn, type ColumnDecision, type ColumnSkipReason } from './columns'

export interface ParsedCsv {
  segments: string[]
  rebuild(translations: (string | undefined)[], bilingual: boolean): Uint8Array
}

/** One cell offered for translation and where it sits in the grid. */
interface CsvCell {
  /** Row and column index into the parsed grid. */
  row: number
  column: number
  /** The cell's text exactly as the file held it, untrimmed. */
  text: string
}

/** Why a cell of a translatable column is left alone. */
type CellSkipReason = 'empty' | 'url-or-email'

const URL_RE = /^https?:\/\//i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isUrlOrEmail(text: string): boolean {
  return URL_RE.test(text) || EMAIL_RE.test(text)
}

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = new Uint8Array([0xff, 0xfe])
const UTF16BE_BOM = new Uint8Array([0xfe, 0xff])

interface DecodedCsv {
  text: string
  /** Whether the rebuilt file is written with a UTF-8 BOM. */
  outputBom: boolean
}

function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false
  return prefix.every((byte, index) => data[index] === byte)
}

/**
 * A browser `TextDecoder` strips a byte order mark when it decodes, but the
 * character can also arrive as text, and papaparse would then read it as the
 * first column's first character — so the first cell of the header row would
 * come back as `\uFEFFname` and stop matching its own column.
 */
function stripBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text
}

/** UTF-8 decoding that rejects invalid bytes instead of replacing them. */
function decodeUtf8Strict(data: Uint8Array): string {
  return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(data))
}

/**
 * The file's text plus whether the rebuilt one needs a UTF-8 BOM. A BOM in the
 * source names its encoding; without one the bytes are tried as strict UTF-8
 * first, and a file that is not valid UTF-8 is taken to be GBK, which GB18030
 * is a superset of. Neither of those two decodes to UTF-8 on the way out, so
 * both get a BOM.
 */
function decodeCsv(data: Uint8Array): DecodedCsv {
  if (hasPrefix(data, UTF8_BOM)) {
    return { text: stripBom(new TextDecoder('utf-8').decode(data)), outputBom: true }
  }
  if (hasPrefix(data, UTF16LE_BOM)) {
    return { text: stripBom(new TextDecoder('utf-16le').decode(data)), outputBom: true }
  }
  if (hasPrefix(data, UTF16BE_BOM)) {
    return { text: stripBom(new TextDecoder('utf-16be').decode(data)), outputBom: true }
  }
  try {
    return { text: decodeUtf8Strict(data), outputBom: false }
  } catch {
    return { text: stripBom(new TextDecoder('gb18030').decode(data)), outputBom: true }
  }
}

/** UTF-8 bytes of `text`, behind a BOM when `bom`. */
function encodeCsv(text: string, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text)
  if (!bom) return body
  const output = new Uint8Array(UTF8_BOM.length + body.length)
  output.set(UTF8_BOM)
  output.set(body, UTF8_BOM.length)
  return output
}

/**
 * papaparse reports a trailing newline as one more row holding a single empty
 * field, and it is not a row of the file. That phantom row also breaks the
 * delimiter guess: in a two-column file it pulls the average field count under
 * the 1.99 a delimiter has to reach to be picked, so a `;`-separated export
 * would be read as one column. The newline is stripped before parsing and put
 * back after serialising instead.
 */
function splitTrailingNewline(text: string): { body: string; trailingNewline: boolean } {
  return /\r?\n$/.test(text)
    ? { body: text.replace(/\r?\n$/, ''), trailingNewline: true }
    : { body: text, trailingNewline: false }
}

/**
 * The label a column is reported under. For a sheet export the first row is the
 * header, which reads far better than a column number in the debug line; the
 * row is data like any other, so this only names the column.
 */
function columnLabel(rows: readonly string[][], column: number): string {
  const first = rows[0]?.[column]?.trim()
  return first ? first : `#${column + 1}`
}

/** One `console.debug` line so a real export's column verdicts can be checked. */
function report(
  rows: readonly string[][],
  decisions: readonly ColumnDecision[],
  translatableCells: number,
  skippedCells: Record<CellSkipReason, number>,
): void {
  const labels = decisions.map(
    (decision, column) =>
      `${columnLabel(rows, column)}=${decision.translatable ? 'translate' : 'skip'}`,
  )
  const skippedColumns: Partial<Record<ColumnSkipReason, number>> = {}
  for (const decision of decisions) {
    if (!decision.reason) continue
    skippedColumns[decision.reason] = (skippedColumns[decision.reason] ?? 0) + 1
  }
  console.debug(
    `[csv] columns ${labels.join(' ')}`,
    `| translatable ${translatableCells} cells`,
    `| columns skipped ${JSON.stringify(skippedColumns)}`,
    `| cells skipped ${JSON.stringify(skippedCells)}`,
  )
}

export function parseCsv(data: Uint8Array): ParsedCsv {
  const { text, outputBom } = decodeCsv(data)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const { body, trailingNewline } = splitTrailingNewline(text)
  const result = Papa.parse<string[]>(body, {
    header: false,
    // Every line the file holds is a row, an empty one included, and
    // `dynamicTyping` would turn `11000.0`, `0123` and a 19-digit id into
    // numbers — the exporter's values have to survive as written.
    skipEmptyLines: false,
    dynamicTyping: false,
  })
  const delimiter = result.meta.delimiter
  const rows = result.data

  // The header row takes part in the inference like any other row: it is where
  // a column's one or two long values live.
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const decisions: ColumnDecision[] = []
  for (let column = 0; column < width; column++) {
    const values: string[] = []
    for (const row of rows) {
      const value = row[column]
      // A blank cell says nothing about the column, and counting it would pull
      // the uniqueness ratio the identifier rule uses towards zero.
      if (value !== undefined && value.trim()) values.push(value)
    }
    decisions.push(classifyColumn(values))
  }

  const cells: CsvCell[] = []
  const skippedCells: Record<CellSkipReason, number> = { empty: 0, 'url-or-email': 0 }
  rows.forEach((row, rowIndex) => {
    row.forEach((value, column) => {
      if (!decisions[column].translatable) return
      const trimmed = value.trim()
      if (!trimmed) {
        skippedCells.empty += 1
        return
      }
      if (isUrlOrEmail(trimmed)) {
        skippedCells['url-or-email'] += 1
        return
      }
      cells.push({ row: rowIndex, column, text: value })
    })
  })
  report(rows, decisions, cells.length, skippedCells)

  return {
    segments: cells.map((cell) => cell.text),
    rebuild(translations, bilingual) {
      const grid = rows.map((row) => [...row])
      let changed = false
      cells.forEach((cell, position) => {
        const translation = translations[position]?.trim()
        if (!translation || translation === cell.text.trim()) return
        grid[cell.row][cell.column] = bilingual
          ? `${cell.text}\n${translation}`
          : translation
        changed = true
      })
      // Nothing to write: hand back the original bytes so an untouched file
      // cannot drift (and so a not-yet-translated file still opens).
      if (!changed) return data

      // Papa quotes a field holding the delimiter, a quote or a newline, which
      // is what keeps a bilingual cell's two lines inside one cell.
      const serialised = Papa.unparse(grid, { delimiter, newline })
      return encodeCsv(serialised + (trailingNewline ? newline : ''), outputBom)
    },
  }
}
