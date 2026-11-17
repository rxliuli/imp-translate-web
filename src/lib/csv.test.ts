import { describe, it, expect } from 'vitest'
import Papa from 'papaparse'
import { parseCsv } from './csv'

// The prose every fixture below draws on: two columns of it, both long enough
// and wordy enough that the column inference keeps them, and free of digits,
// underscores and dashes so the identifier rule can never claim them.
const TOPICS = [
  'Shopping list for the weekend trip',
  'Remember to water the office plants',
  'The quarterly report needs one more pass',
  'Book the train tickets before Friday',
]
const SUMMARIES = [
  'Two days of errands before the rain starts',
  'The office is closed until Monday morning',
  'Numbers are in and the deck needs a reread',
  'Cheaper fares are gone after Thursday night',
]
// A column of numbers in the shapes an exporter writes: a float that must not
// lose its trailing zero, a zero-padded code, a 19-digit id past the precision
// of a double, and a plain integer.
const AMOUNTS = ['11000.0', '0123', '1234567890123456789', '42']

const HEADER = 'topic,summary,amount'

const BASIC_CSV =
  [HEADER, ...TOPICS.map((topic, i) => `${topic},${SUMMARIES[i]},${AMOUNTS[i]}`)].join(
    '\n',
  ) + '\n'

// The first row is a row like any other: its cells take part in the column
// inference and, where the column is translatable, become segments too.
const BASIC_SEGMENTS = ['topic', 'summary', ...TOPICS.flatMap((topic, i) => [topic, SUMMARIES[i]])]

// A column of RFC 2822 stamps and a column of 19-digit ids, each with as many
// rows as an export has: twenty values is enough that one header cell above
// them stays inside the 5% the identifier rule tolerates.
const RFC_STAMPS = Array.from(
  { length: 20 },
  (_, i) =>
    `Wed, ${String(20 - i).padStart(2, '0')} May 2026 ${String(i).padStart(2, '0')}:08:25 +0000`,
)
const PIN_IDS = Array.from(
  { length: 20 },
  (_, i) => `10989487465999230${String(i).padStart(2, '0')}`,
)
// The date and clock shapes the date rule knows, four distinct values each, and
// a prose column to sit beside them.
const ISO_DATES = ['2026-05-27', '2026-05-26', '2026-05-25', '2026-05-24']
const CLOCK_TIMES = ['03:08', '19:59', '11:02', '08:30']
const SLASH_DATES = ['2026/05/27', '27/05/2026', '2026/05/26', '26/05/2026']
const TOPIC_COLUMN = Array.from({ length: 20 }, (_, i) => TOPICS[i % TOPICS.length])

// A GBK export of
//   标题,内容
//   内容一号,内容二号  … through 内容七号,内容八号
// that is, what Excel on a Chinese Windows writes. Hardcoded because no browser
// encoder produces GB18030.
const GBK_CSV = new Uint8Array([
  0xb1, 0xea, 0xcc, 0xe2, 0x2c, 0xc4, 0xda, 0xc8, 0xdd, 0x0a, 0xc4, 0xda, 0xc8, 0xdd,
  0xd2, 0xbb, 0xba, 0xc5, 0x2c, 0xc4, 0xda, 0xc8, 0xdd, 0xb6, 0xfe, 0xba, 0xc5, 0x0a,
  0xc4, 0xda, 0xc8, 0xdd, 0xc8, 0xfd, 0xba, 0xc5, 0x2c, 0xc4, 0xda, 0xc8, 0xdd, 0xcb,
  0xc4, 0xba, 0xc5, 0x0a, 0xc4, 0xda, 0xc8, 0xdd, 0xce, 0xe5, 0xba, 0xc5, 0x2c, 0xc4,
  0xda, 0xc8, 0xdd, 0xc1, 0xf9, 0xba, 0xc5, 0x0a, 0xc4, 0xda, 0xc8, 0xdd, 0xc6, 0xdf,
  0xba, 0xc5, 0x2c, 0xc4, 0xda, 0xc8, 0xdd, 0xb0, 0xcb, 0xba, 0xc5, 0x0a,
])

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text)
}

/** The rebuilt bytes as text, BOM stripped. */
function readText(data: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(data)
  return text.startsWith('\uFEFF') ? text.slice(1) : text
}

/** The rebuilt bytes as the grid a CSV reader would see. */
function readGrid(data: Uint8Array, delimiter = ','): string[][] {
  const rows = Papa.parse<string[]>(readText(data), {
    delimiter,
    header: false,
    skipEmptyLines: false,
    dynamicTyping: false,
  }).data
  const last = rows[rows.length - 1]
  return last && last.length === 1 && last[0] === '' ? rows.slice(0, -1) : rows
}

function hasUtf8Bom(data: Uint8Array): boolean {
  return data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
}

/** A translation for every segment from `keepSource` on; the rest stay as they are. */
function translateFrom(segments: string[], keepSource = 0): (string | undefined)[] {
  return segments.map((_, i) => (i < keepSource ? undefined : `译文${i}`))
}

describe('parseCsv', () => {
  it('offers the cells of the prose columns and leaves the numeric one alone', () => {
    const doc = parseCsv(bytes(BASIC_CSV))
    expect(doc.segments).toEqual(BASIC_SEGMENTS)
  })

  it('writes the translation below the source inside one quoted cell when bilingual', () => {
    const doc = parseCsv(bytes(BASIC_CSV))
    const output = doc.rebuild(translateFrom(doc.segments, 2), true)
    const text = readText(output)

    // The newline a bilingual cell holds would end the row unless the field is
    // quoted, which is why Papa's serialiser writes it.
    expect(text).toContain(`"${TOPICS[0]}\n译文2"`)
    expect(readGrid(output)[1]).toEqual([`${TOPICS[0]}\n译文2`, `${SUMMARIES[0]}\n译文3`, AMOUNTS[0]])
    // The header row was left as it was, so the columns keep their names.
    expect(readGrid(output)[0]).toEqual(['topic', 'summary', 'amount'])
    expect(hasUtf8Bom(output)).toBe(false)
  })

  it('writes only the translation when not bilingual', () => {
    const doc = parseCsv(bytes(BASIC_CSV))
    const output = doc.rebuild(doc.segments.map((_, i) => `译文${i}`), false)
    const grid = readGrid(output)
    expect(grid[0][0]).toBe('译文0')
    expect(grid[1]).toEqual(['译文2', '译文3', AMOUNTS[0]])
  })

  it('keeps the shape of every number it did not translate', () => {
    const doc = parseCsv(bytes(BASIC_CSV))
    const output = doc.rebuild(doc.segments.map((_, i) => `译文${i}`), false)
    const text = readText(output)

    // `dynamicTyping` would turn these into 11000, 123 and 1.2345678901234567e18.
    expect(text).toContain('11000.0')
    expect(text).toContain('0123')
    expect(text).toContain('1234567890123456789')
    expect(readGrid(output).slice(1).map((row) => row[2])).toEqual(AMOUNTS)
  })

  it('keeps a comma, an escaped quote and a newline inside the cells that hold them', () => {
    // Grid: one prose column of plain titles, one of cells a CSV has to quote.
    const csv = [
      'title,note',
      'Weekend trip packing plan,"Pack the tent, the stove and the maps"',
      'Friday call with the vendor,"She said ""ship it"" on Friday"',
      'Reading list for the flight,"First chapter',
      'then the appendix"',
      'Weather forecast for the coast,"Rain until Thursday, then clear skies"',
    ].join('\n') + '\n'
    const doc = parseCsv(bytes(csv))
    // Row-major, so every even index is a title and every odd one a note.
    expect(doc.segments.filter((_, i) => i % 2 === 0)).toEqual([
      'title',
      'Weekend trip packing plan',
      'Friday call with the vendor',
      'Reading list for the flight',
      'Weather forecast for the coast',
    ])

    // The notes come back undefined, so they are re-serialised unchanged: the
    // comma and the escaped quotes stay inside their cell instead of splitting
    // it, and the two physical lines stay one row.
    const output = doc.rebuild(
      doc.segments.map((_, i) => (i % 2 === 0 ? `译文${i}` : undefined)),
      false,
    )
    expect(readGrid(output)).toEqual([
      ['译文0', 'note'],
      ['译文2', 'Pack the tent, the stove and the maps'],
      ['译文4', 'She said "ship it" on Friday'],
      ['译文6', 'First chapter\nthen the appendix'],
      ['译文8', 'Rain until Thursday, then clear skies'],
    ])
  })

  it('keeps a semicolon-delimited file semicolon-delimited', () => {
    const csv =
      ['topic;summary', ...TOPICS.map((topic, i) => `${topic};${SUMMARIES[i]}`)].join('\n') +
      '\n'
    const doc = parseCsv(bytes(csv))
    const output = doc.rebuild(translateFrom(doc.segments, 2), false)

    expect(readGrid(output, ';')).toEqual([
      ['topic', 'summary'],
      ['译文2', '译文3'],
      ['译文4', '译文5'],
      ['译文6', '译文7'],
      ['译文8', '译文9'],
    ])
    // A comma delimiter would have collapsed each row into one column.
    expect(readGrid(output, ',')[0]).toEqual(['topic;summary'])
  })

  it('keeps a tab-delimited file tab-delimited', () => {
    const csv =
      ['topic\tsummary', ...TOPICS.map((topic, i) => `${topic}\t${SUMMARIES[i]}`)].join(
        '\n',
      ) + '\n'
    const doc = parseCsv(bytes(csv))
    const output = doc.rebuild(translateFrom(doc.segments, 2), true)

    const rows = readGrid(output, '\t')
    expect(rows[0]).toEqual(['topic', 'summary'])
    expect(rows[1]).toEqual([`${TOPICS[0]}\n译文2`, `${SUMMARIES[0]}\n译文3`])
  })

  it('keeps the CRLF line endings and the trailing newline of the source', () => {
    const csv =
      ['topic,summary', ...TOPICS.map((topic, i) => `${topic},${SUMMARIES[i]}`)].join(
        '\r\n',
      ) + '\r\n'
    const doc = parseCsv(bytes(csv))
    const text = readText(doc.rebuild(translateFrom(doc.segments, 2), false))

    expect(text).not.toMatch(/[^\r]\n/)
    expect(text.endsWith('\r\n')).toBe(true)
    // Five rows plus the empty tail after the last newline.
    expect(text.split('\r\n')).toHaveLength(6)
  })

  it('keeps the LF line endings and the trailing newline of the source', () => {
    const csv =
      ['topic,summary', ...TOPICS.map((topic, i) => `${topic},${SUMMARIES[i]}`)].join(
        '\n',
      ) + '\n'
    const doc = parseCsv(bytes(csv))
    const text = readText(doc.rebuild(translateFrom(doc.segments, 2), false))

    expect(text).not.toContain('\r')
    expect(text.endsWith('\n')).toBe(true)
    // Five rows plus the empty tail after the last newline.
    expect(text.split('\n')).toHaveLength(6)
  })

  it('does not add a trailing newline a file did not have', () => {
    const csv = ['topic,summary', ...TOPICS.map((topic, i) => `${topic},${SUMMARIES[i]}`)].join(
      '\n',
    )
    const doc = parseCsv(bytes(csv))
    const text = readText(doc.rebuild(translateFrom(doc.segments, 2), false))

    expect(text.endsWith('\n')).toBe(false)
    expect(text.split('\n')).toHaveLength(5)
  })

  it('writes a UTF-8 BOM when the source had one', () => {
    const doc = parseCsv(bytes(`\uFEFF${BASIC_CSV}`))
    // The BOM is not part of the first header cell.
    expect(doc.segments[0]).toBe('topic')

    const output = doc.rebuild(translateFrom(doc.segments, 2), false)
    expect(hasUtf8Bom(output)).toBe(true)
    expect(readText(output).startsWith('topic,summary')).toBe(true)
  })

  it('converts a GBK source to UTF-8 with a BOM', () => {
    const doc = parseCsv(GBK_CSV)
    expect(doc.segments).toEqual([
      '标题',
      '内容',
      '内容一号',
      '内容二号',
      '内容三号',
      '内容四号',
      '内容五号',
      '内容六号',
      '内容七号',
      '内容八号',
    ])

    const output = doc.rebuild(doc.segments.map((_, i) => `译文${i}`), false)
    // UTF-8 is the only encoding a browser can write, and the BOM is what tells
    // Excel so — without it a Chinese Excel would read the bytes as GBK again.
    expect(hasUtf8Bom(output)).toBe(true)
    expect(readText(output)).toBe(
      ['译文0,译文1', '译文2,译文3', '译文4,译文5', '译文6,译文7', '译文8,译文9'].join(
        '\n',
      ) + '\n',
    )
    // The rebuilt bytes are UTF-8, not a copy of the GBK source.
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(output)).not.toThrow()
    expect(Array.from(output)).not.toEqual(Array.from(GBK_CSV))
  })

  it('skips enumeration, identifier and single-word label columns', () => {
    const csv = [
      'user_id,name,status,topic',
      `user_123,Alice,Done,${TOPICS[0]}`,
      `user_456,Bob,Open,${TOPICS[1]}`,
      `user_789,Carol,Done,${TOPICS[2]}`,
      `user_012,Dave,Open,${TOPICS[3]}`,
    ].join('\n') + '\n'
    const doc = parseCsv(bytes(csv))
    // Three shapes are skipped: the ids (`user_123`), the single-word labels
    // (Alice, Carol) and the two-value enumeration (Done/Open). Only the prose
    // column is offered.
    expect(doc.segments).toEqual(['topic', ...TOPICS])

    const output = doc.rebuild(translateFrom(doc.segments, 1), false)
    expect(readGrid(output)).toEqual([
      ['user_id', 'name', 'status', 'topic'],
      ['user_123', 'Alice', 'Done', '译文1'],
      ['user_456', 'Bob', 'Open', '译文2'],
      ['user_789', 'Carol', 'Done', '译文3'],
      ['user_012', 'Dave', 'Open', '译文4'],
    ])
  })

  it('skips a column of timestamps whose header is a plain word', () => {
    // The `createdAt` column of a Pinterest export, which used to be sent for
    // translation: every value is an RFC 2822 stamp, but the one header above
    // them holds no digit, so requiring *every* value to be token-shaped let
    // the column fall through to the prose rules.
    const doc = parseCsv(
      bytes(['createdAt', ...RFC_STAMPS.map((stamp) => `"${stamp}"`)].join('\n') + '\n'),
    )
    expect(doc.segments).toEqual([])
  })

  it('skips a column of ids whose header is a plain word', () => {
    const doc = parseCsv(bytes(['id', ...PIN_IDS].join('\n') + '\n'))
    expect(doc.segments).toEqual([])
  })

  it('skips a column of ids that has no header row', () => {
    // The tolerance is not what makes an id column skipped: twenty token-shaped
    // values on their own already are.
    const doc = parseCsv(bytes(PIN_IDS.join('\n') + '\n'))
    expect(doc.segments).toEqual([])
  })

  it('keeps a prose column that holds a value like N/A', () => {
    const notes = [...TOPICS, 'N/A']
    const doc = parseCsv(bytes(['note', ...notes].join('\n') + '\n'))
    // One value that is not token-shaped does not make a prose column data:
    // the identifier rule asks for nearly all of them, not for one to be odd.
    expect(doc.segments).toEqual(['note', ...notes])
  })

  it('skips date and clock columns in every shape it knows', () => {
    const columns: [name: string, values: string[]][] = [
      ['stamp', RFC_STAMPS.slice(0, 4)],
      ['iso', ISO_DATES],
      ['time', CLOCK_TIMES],
      ['slash', SLASH_DATES],
      ['topic', TOPICS],
    ]
    const csv =
      [
        columns.map(([name]) => name).join(','),
        ...TOPIC_COLUMN.map((_, row) =>
          columns.map(([, values]) => `"${values[row % values.length]}"`).join(','),
        ),
      ].join('\n') + '\n'
    const doc = parseCsv(bytes(csv))
    // Only the prose column is offered. Each date column repeats its values, so
    // the identifier rule's "almost all unique" test keeps it away, and an RFC
    // 2822 stamp is six words long so the label rule stays away too: it is the
    // date rule that skips them.
    expect(doc.segments).toEqual(['topic', ...TOPIC_COLUMN])
  })

  it('skips a mostly-dated column even when one value is prose', () => {
    const stamps = RFC_STAMPS.slice(0, 19)
    const csv =
      [
        'createdAt,topic',
        ...stamps.map((stamp, i) => `"${stamp}",${TOPIC_COLUMN[i]}`),
        `"Ask the printer for a new quote",${TOPIC_COLUMN[19]}`,
      ].join('\n') + '\n'
    const doc = parseCsv(bytes(csv))
    // Nineteen of the column's twenty values are stamps, so the column is data:
    // the one prose value in it is given up rather than the dates being sent.
    expect(doc.segments).not.toContain('Ask the printer for a new quote')
    expect(doc.segments).toContain(TOPIC_COLUMN[0])
  })

  it('keeps prose that only mentions a year or a clock time', () => {
    const notes = [
      'Published in 2026 on a rainy day',
      'Day 12 - arrive before 18:00, dinner at the hotel with the group',
      'Remember to water the office plants',
      'The quarterly report needs one more pass',
      'Book the train tickets before Friday',
    ]
    const doc = parseCsv(bytes(['note', ...notes.map((note) => `"${note}"`)].join('\n') + '\n'))
    expect(doc.segments).toEqual(['note', ...notes])
  })

  it('skips cells that are blank or hold only a URL or an email', () => {
    const csv = [
      'topic,link',
      `${TOPICS[0]},https://example.com/a`,
      `${TOPICS[1]},someone@example.com`,
      `${TOPICS[2]},`,
      `${TOPICS[3]},Write to the vendor about the invoice`,
    ].join('\n') + '\n'
    const doc = parseCsv(bytes(csv))
    // The link column holds one real sentence, so it is prose; the URL, the
    // email and the blank cell inside it are still skipped cell by cell.
    expect(doc.segments).toEqual([
      'topic',
      'link',
      ...TOPICS,
      'Write to the vendor about the invoice',
    ])

    const output = doc.rebuild(translateFrom(doc.segments, 2), false)
    expect(readGrid(output)).toEqual([
      ['topic', 'link'],
      ['译文2', 'https://example.com/a'],
      ['译文3', 'someone@example.com'],
      ['译文4', ''],
      ['译文5', '译文6'],
    ])
  })

  it('returns the original bytes when nothing was translated', () => {
    const data = bytes(BASIC_CSV)
    const doc = parseCsv(data)
    expect(doc.rebuild(doc.segments.map(() => undefined), true)).toBe(data)
    // An empty file has nothing to write either, and must not throw.
    const empty = bytes('')
    expect(parseCsv(empty).rebuild([], true)).toBe(empty)
  })

  it('rebuilds the same bytes on every call', () => {
    const doc = parseCsv(bytes(BASIC_CSV))
    const translations = translateFrom(doc.segments, 2)
    const first = doc.rebuild(translations, true)
    expect(Array.from(doc.rebuild(translations, true))).toEqual(Array.from(first))
  })

  it('keeps a field holding a carriage return and one holding a BOM character', () => {
    const notes = [
      'A note with a\r carriage return in it',
      'A note with a \uFEFF byte mark inside it',
      'First line\nsecond line of one note',
      'A plain note for comparison here',
    ]
    const csv =
      'note\n' +
      notes
        .map((note) => `"${note.replace(/"/g, '""')}"`)
        .join('\n') +
      '\n'
    const doc = parseCsv(bytes(csv))
    expect(doc.segments).toEqual(['note', ...notes])

    // Only the last cell is translated, so the two awkward cells are
    // serialised back and have to survive the round trip.
    const output = doc.rebuild(
      doc.segments.map((_, i) => (i === 4 ? '译文4' : undefined)),
      false,
    )
    expect(readGrid(output).map((row) => row[0])).toEqual([
      'note',
      notes[0],
      notes[1],
      notes[2],
      '译文4',
    ])
  })

  it('handles a header-only file and a single-column file', () => {
    const headerOnly = parseCsv(bytes('topic,summary\n'))
    expect(headerOnly.segments).toEqual([])

    const single = parseCsv(bytes(TOPICS.join('\n')))
    expect(single.segments).toEqual(TOPICS)
    const output = single.rebuild(translateFrom(TOPICS), false)
    expect(readGrid(output)).toEqual([['译文0'], ['译文1'], ['译文2'], ['译文3']])
  })

  it('takes .csv files through the files-page handler', async () => {
    const { getHandler } = await import('./documents')
    const file = new File([bytes(BASIC_CSV)], 'export.csv')
    const handler = getHandler(file)
    expect(handler?.kind).toBe('csv')
    const doc = await handler!.parse(file)
    expect(doc.segments).toEqual(BASIC_SEGMENTS)
    expect(doc.mimeType).toBe('text/csv')
    const output = doc.rebuild(translateFrom(doc.segments, 2), false)
    expect(output).toBeInstanceOf(Uint8Array)
    expect(readGrid(output as Uint8Array)[1][0]).toBe('译文2')
  })
})
