import { describe, it, expect } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { parseXlsx } from './xlsx'

// The workbook every test here shares. Column A is prose (translated), B is an
// enumeration, C holds numbers, D holds a rich-text string, E holds account
// names — the four shapes a single-column heuristic has to tell apart.
const PROSE = [
  'Shopping list for the weekend trip',
  'Remember to water the office plants',
  'The quarterly report needs one more pass',
  'Book the train tickets before Friday',
]
const ENUM = 'Complete'
const RICH_TEXT = 'Mixedformat'
const ACCOUNTS = [
  'casualCarnation03',
  'casualDahlia07',
  'casualFern11',
  'casualIris23',
]

/** Index of each value in the shared string table. */
const SI = {
  prose0: 0,
  enumValue: 1,
  rich: 2,
  prose1: 3,
  account0: 4,
  account1: 5,
  prose2: 6,
  account2: 7,
  prose3: 8,
  account3: 9,
}

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="16" uniqueCount="10">
  <si><t>${PROSE[0]}</t></si>
  <si><t>${ENUM}</t></si>
  <si><r><rPr><i/></rPr><t>Mixed</t></r><r><t>format</t></r></si>
  <si><t>${PROSE[1]}</t></si>
  <si><t>${ACCOUNTS[0]}</t></si>
  <si><t>${ACCOUNTS[1]}</t></si>
  <si><t>${PROSE[2]}</t></si>
  <si><t>${ACCOUNTS[2]}</t></si>
  <si><t>${PROSE[3]}</t></si>
  <si><t>${ACCOUNTS[3]}</t></si>
</sst>
`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
</styleSheet>
`

// Row 2 is hidden and must still be translated. A5 repeats a string that A4
// already uses, so the shared-string table keeps its count while the text
// appears in two cells, and it carries an `s` attribute that the style rewrite
// has to replace rather than add.
const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>${SI.prose0}</v></c><c r="B1" t="s"><v>${SI.enumValue}</v></c><c r="C1"><v>42</v></c><c r="D1" t="s"><v>${SI.rich}</v></c><c r="E1" t="s"><v>${SI.account0}</v></c></row>
    <row r="2" hidden="1"><c r="A2" t="s"><v>${SI.prose1}</v></c><c r="B2" t="s"><v>${SI.enumValue}</v></c><c r="C2"><v>7</v></c><c r="E2" t="s"><v>${SI.account1}</v></c></row>
    <row r="3"><c r="A3" t="s"><v>${SI.prose2}</v></c><c r="B3" t="s"><v>${SI.enumValue}</v></c><c r="E3" t="s"><v>${SI.account2}</v></c></row>
    <row r="4"><c r="A4" t="s"><v>${SI.prose3}</v></c><c r="E4" t="s"><v>${SI.account3}</v></c></row>
    <row r="5"><c r="A5" s="1" t="s"><v>${SI.prose3}</v></c></row>
  </sheetData>
</worksheet>
`

// A second workbook shaped like a real sheet: column A is prose and its cells
// carry different formats (Public Sans 14pt with a border on row 1, centring on
// row 2), column B is an enumeration and column C holds numbers. It is kept
// apart from the workbook above so these formats cannot change the column
// verdicts the other tests depend on.
const STYLED_PROSE = [
  'Quarterly numbers for the board deck',
  'Notes from the customer call on Tuesday',
  'Draft copy for the launch announcement',
  'Follow up on the shipping delay',
]

const STYLED_SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="10" uniqueCount="5">
${STYLED_PROSE.map((text) => `  <si><t>${text}</t></si>`).join('\n')}
  <si><t>${ENUM}</t></si>
</sst>
`

// cellXfs mirrors the shapes a real workbook produces: xf 1 is a bordered cell
// in font 4 with no alignment child, xf 2 is centred, xf 3 is an untranslated
// column's format whose bottom alignment and wrapText="0" must survive.
const STYLED_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="5"><font><sz val="11"/><name val="Calibri"/></font><font/><font/><font/><font><sz val="14"/><name val="Public Sans"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="2"><border/><border><left style="thin"/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4"><xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0"/><xf borderId="1" fillId="0" fontId="4" numFmtId="0" xfId="0" applyBorder="1" applyFont="1"/><xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf><xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment readingOrder="0" shrinkToFit="0" vertical="bottom" wrapText="0"/></xf></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
</styleSheet>
`

const STYLED_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="3" t="s"><v>4</v></c><c r="C1" s="2"><v>42</v></c></row>
    <row r="2"><c r="A2" s="2" t="s"><v>1</v></c><c r="B2" s="3" t="s"><v>4</v></c></row>
    <row r="3"><c r="A3" s="1" t="s"><v>2</v></c><c r="B3" s="3" t="s"><v>4</v></c></row>
    <row r="4"><c r="A4" s="1" t="s"><v>3</v></c></row>
  </sheetData>
</worksheet>
`

const STYLED_TRANSLATIONS = ['译文一', '译文二', '译文三', '译文四']

// Copied through untouched by every rebuild; the comparison in the
// "unmodified members" test is what proves the zip round trip is byte safe.
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements/></a:theme>
`

const COMMENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>A</author></authors><commentList><comment ref="A1" authorId="0"><text><r><t>note</t></r></text></comment></commentList></comments>
`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>
`

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></sheets></workbook>
`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>
`

const TRANSLATIONS = ['译文一', '译文二', '译文三', '译文四']

// A workbook shaped like a sheet exported from a tracker: every value of column
// A is prose, and four of them are stored as rich-text runs — a sentence with a
// blue underlined title in the middle, a first run without any `<rPr>`, a
// self-closing `<t/>`, and a last run without `<rPr>` whose text needs escaping.
// Column B is an enumeration. The runs are kept apart from the workbooks above
// so their formatting cannot change the column verdicts those tests depend on.
const RICH_PROSE = [
  'Notes from the weekly sync',
  'Watch The Horribly Slow Murderer before Friday',
  'Ask the vendor for a revised quote',
  'Follow up on the shipping delay',
  'Draft copy for the launch announcement',
  'A & B < C tail',
]

/** Index of each value in the rich fixture's shared string table. */
const RICH_SI = {
  plain0: 0,
  runs: 1,
  plain2: 2,
  firstRunWithoutRPr: 3,
  selfClosing: 4,
  escaped: 5,
  enumValue: 6,
}

// Run properties in the shapes a real sheet writes: body text and a blue
// underlined link (the link Excel writes for a cell that also has a
// `<hyperlink>`), plus two bare ones.
const BODY_RPR = '<rPr><rFont val="Public Sans"/><sz val="14.0"/></rPr>'
const LINK_RPR =
  '<rPr><rFont val="Public Sans"/><color rgb="FF1155CC"/><sz val="14.0"/><u/></rPr>'
const BOLD_RPR = '<rPr><b/></rPr>'
const ITALIC_RPR = '<rPr><i/></rPr>'

const RICH_SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="12" uniqueCount="7">
  <si><t>${RICH_PROSE[0]}</t></si>
  <si><r>${BODY_RPR}<t xml:space="preserve">Watch </t></r><r>${LINK_RPR}<t>The Horribly Slow Murderer</t></r><r>${BODY_RPR}<t xml:space="preserve"> before Friday</t></r></si>
  <si><t>${RICH_PROSE[2]}</t></si>
  <si><r><t xml:space="preserve">Follow up </t></r><r>${BOLD_RPR}<t>on the shipping delay</t></r></si>
  <si><r>${ITALIC_RPR}<t/></r><r>${ITALIC_RPR}<t>${RICH_PROSE[4]}</t></r></si>
  <si><r>${BOLD_RPR}<t>A &amp; B &lt; C</t></r><r><t xml:space="preserve"> tail</t></r></si>
  <si><t>${ENUM}</t></si>
</sst>
`

const RICH_SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>${RICH_SI.plain0}</v></c><c r="B1" t="s"><v>${RICH_SI.enumValue}</v></c></row>
    <row r="2"><c r="A2" s="1" t="s"><v>${RICH_SI.runs}</v></c><c r="B2" t="s"><v>${RICH_SI.enumValue}</v></c></row>
    <row r="3"><c r="A3" t="s"><v>${RICH_SI.plain2}</v></c><c r="B3" t="s"><v>${RICH_SI.enumValue}</v></c></row>
    <row r="4"><c r="A4" t="s"><v>${RICH_SI.firstRunWithoutRPr}</v></c></row>
    <row r="5"><c r="A5" t="s"><v>${RICH_SI.selfClosing}</v></c></row>
    <row r="6"><c r="A6" t="s"><v>${RICH_SI.escaped}</v></c></row>
  </sheetData>
</worksheet>
`

const RICH_TRANSLATIONS = ['译文一', '译文二', '译文三', '译文四', '译文五', '译文六']

function buildWorkbook(): Uint8Array<ArrayBuffer> {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/sharedStrings.xml': strToU8(SHARED_STRINGS),
    'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(SHEET),
    'xl/theme/theme1.xml': strToU8(THEME),
    'xl/comments1.xml': strToU8(COMMENTS),
  }
  return new Uint8Array(zipSync(files))
}

function buildStyledWorkbook(): Uint8Array<ArrayBuffer> {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/sharedStrings.xml': strToU8(STYLED_SHARED_STRINGS),
    'xl/styles.xml': strToU8(STYLED_STYLES),
    'xl/worksheets/sheet1.xml': strToU8(STYLED_SHEET),
  }
  return new Uint8Array(zipSync(files))
}

function buildRichWorkbook(): Uint8Array<ArrayBuffer> {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(WORKBOOK_RELS),
    'xl/sharedStrings.xml': strToU8(RICH_SHARED_STRINGS),
    'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(RICH_SHEET),
  }
  return new Uint8Array(zipSync(files))
}

function readPart(data: Uint8Array, path: string): string {
  const files = unzipSync(data)
  const part = files[path]
  if (!part) throw new Error(`missing part ${path}`)
  return strFromU8(part)
}

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const error = doc.querySelector('parsererror')
  if (error) throw new Error(`not well-formed XML: ${error.textContent}\n${xml}`)
  return doc
}

/** Decoded text of every `<si>`, in table order. */
function sharedStringTexts(data: Uint8Array): string[] {
  return Array.from(
    parseXml(readPart(data, 'xl/sharedStrings.xml')).getElementsByTagName('si'),
  ).map((si) => si.textContent ?? '')
}

/** Serialised `<si>` elements, for a "not a single character moved" check. */
function sharedStringElements(data: Uint8Array): string[] {
  const serializer = new XMLSerializer()
  return Array.from(
    parseXml(readPart(data, 'xl/sharedStrings.xml')).getElementsByTagName('si'),
  ).map((si) => serializer.serializeToString(si))
}

/** The raw `<si>` at `index` of a shared string table, tags included. */
function sharedStringXml(xml: string, index: number): string {
  const si = (xml.match(/<si>[\s\S]*?<\/si>/g) ?? [])[index]
  if (si === undefined) throw new Error(`no <si> at ${index}`)
  return si
}

/** The `<r>` elements of a `<si>`, in document order, verbatim. */
function runElements(si: string): string[] {
  return si.match(/<r>[\s\S]*?<\/r>/g) ?? []
}

/** The `<rPr>…</rPr>` of a run (the run string starts with `<r>`), or ''. */
function runProperties(run: string): string {
  return /<rPr>[\s\S]*?<\/rPr>/.exec(run)?.[0] ?? ''
}

/** The `<si>` at `index` of a rebuilt workbook's shared string table. */
function rebuiltSharedString(data: Uint8Array, index: number): string {
  return sharedStringXml(readPart(data, 'xl/sharedStrings.xml'), index)
}

function rebuild(
  data: Uint8Array,
  translations: (string | undefined)[],
  bilingual: boolean,
): Uint8Array {
  return parseXlsx(data).rebuild(translations, bilingual)
}

/** The `<xf>` children of `<cellXfs>`, in index order. */
function cellXfs(data: Uint8Array): Element[] {
  const list = parseXml(readPart(data, 'xl/styles.xml')).getElementsByTagName('cellXfs')[0]
  return Array.from(list.getElementsByTagName('xf'))
}

/** The `s` attribute of every cell of sheet 1, keyed by reference. */
function cellStyles(data: Uint8Array): Map<string, string | null> {
  const sheet = parseXml(readPart(data, 'xl/worksheets/sheet1.xml'))
  return new Map(
    Array.from(sheet.getElementsByTagName('c'), (cell) => [
      cell.getAttribute('r') ?? '',
      cell.getAttribute('s'),
    ]),
  )
}

/** The single `<alignment>` of an `<xf>`, asserting there is exactly one. */
function alignmentOf(xf: Element): Element {
  const alignments = xf.getElementsByTagName('alignment')
  expect(alignments.length).toBe(1)
  return alignments[0]
}

/** The `<xf>` a translated cell points at, resolved through its `s` attribute. */
function styleOfCell(data: Uint8Array, ref: string): Element {
  const style = cellStyles(data).get(ref)
  expect(style, ref).not.toBeNull()
  return cellXfs(data)[Number(style)]
}

describe('parseXlsx', () => {
  it('translates shared-string cells in document order and ignores numeric cells', () => {
    const doc = parseXlsx(buildWorkbook())
    expect(doc.segments).toEqual(PROSE)

    const output = doc.rebuild(PROSE.map((_, i) => TRANSLATIONS[i]), false)
    // The number cells carry no `t="s"`, so nothing in the rebuild touches them.
    expect(readPart(output, 'xl/worksheets/sheet1.xml')).toContain(
      '<c r="C1"><v>42</v></c>',
    )
  })

  it('skips columns whose values are an enumeration', () => {
    const doc = parseXlsx(buildWorkbook())
    expect(doc.segments).not.toContain(ENUM)
    // The enum string is shared by three cells and survives untouched.
    const output = doc.rebuild(TRANSLATIONS, true)
    expect(sharedStringTexts(output)[SI.enumValue]).toBe(ENUM)
  })

  it('leaves a rich-text string in an untranslated column alone', () => {
    const doc = parseXlsx(buildWorkbook())
    expect(doc.segments).not.toContain(RICH_TEXT)
    const output = doc.rebuild(TRANSLATIONS, true)
    expect(sharedStringElements(output)[SI.rich]).toBe(
      sharedStringElements(buildWorkbook())[SI.rich],
    )
  })

  it('skips account-name columns', () => {
    const doc = parseXlsx(buildWorkbook())
    for (const account of ACCOUNTS) expect(doc.segments).not.toContain(account)
  })

  it('writes the source, a newline and the translation when bilingual', () => {
    const output = rebuild(buildWorkbook(), TRANSLATIONS, true)
    const texts = sharedStringTexts(output)
    expect(texts[SI.prose0]).toBe(`${PROSE[0]}\n${TRANSLATIONS[0]}`)
    // A newline would collapse inside a cell without this attribute.
    expect(readPart(output, 'xl/sharedStrings.xml')).toContain(
      '<t xml:space="preserve">',
    )
  })

  it('writes only the translation when not bilingual', () => {
    const output = rebuild(buildWorkbook(), TRANSLATIONS, false)
    expect(sharedStringTexts(output)[SI.prose0]).toBe(TRANSLATIONS[0])
  })

  it('escapes XML metacharacters and keeps every part well-formed', () => {
    const tricky = ['A & B < C', 'quote " and apostrophe \' <ok/>', 'x > y & z', 'last']
    const output = rebuild(buildWorkbook(), tricky, false)

    // Reading it back through an XML parser proves `&` and `<` were escaped:
    // unescaped ones would abort the parse.
    expect(sharedStringTexts(output)[SI.prose0]).toBe('A & B < C')
    expect(sharedStringTexts(output)[SI.prose1]).toBe('quote " and apostrophe \' <ok/>')
    expect(sharedStringTexts(output)[SI.prose2]).toBe('x > y & z')

    const raw = readPart(output, 'xl/sharedStrings.xml')
    expect(raw).toContain('A &amp; B &lt; C')
    // styles and the worksheet are rewritten too, so all three must parse.
    parseXml(raw)
    parseXml(readPart(output, 'xl/styles.xml'))
    parseXml(readPart(output, 'xl/worksheets/sheet1.xml'))
  })

  it('copies unmodified zip members byte for byte', () => {
    const before = unzipSync(buildWorkbook())
    const after = unzipSync(rebuild(buildWorkbook(), TRANSLATIONS, true))
    for (const path of [
      '[Content_Types].xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/theme/theme1.xml',
      'xl/comments1.xml',
    ]) {
      expect(Array.from(after[path]), path).toEqual(Array.from(before[path]))
    }
  })

  it('leaves shared strings it did not translate untouched', () => {
    const before = sharedStringElements(buildWorkbook())
    const after = sharedStringElements(rebuild(buildWorkbook(), TRANSLATIONS, true))
    for (const index of [
      SI.enumValue,
      SI.rich,
      SI.account0,
      SI.account1,
      SI.account2,
      SI.account3,
    ]) {
      expect(after[index]).toBe(before[index])
    }
    expect(after[SI.prose0]).not.toBe(before[SI.prose0])
  })

  it('keeps the source text when a segment came back undefined', () => {
    const before = sharedStringElements(buildWorkbook())
    const output = rebuild(
      buildWorkbook(),
      [TRANSLATIONS[0], undefined, TRANSLATIONS[2], TRANSLATIONS[3]],
      true,
    )
    const after = sharedStringElements(output)
    expect(after[SI.prose1]).toBe(before[SI.prose1])
    // The neighbours still translate, so the table did not silently stop.
    expect(after[SI.prose0]).not.toBe(before[SI.prose0])
  })

  it('derives a wrapped cell format per source style and applies it only to translated cells', () => {
    const output = rebuild(buildWorkbook(), TRANSLATIONS, false)

    const styles = readPart(output, 'xl/styles.xml')
    // One copy for the unstyled cells (source xf 0) and one for A5 (source xf 1).
    expect(styles).toContain('<cellXfs count="4">')
    // The cellStyleXfs array is a different list and keeps its own count.
    expect(styles).toContain('<cellStyleXfs count="1">')
    expect(styles).toContain('<dxfs count="0"/>')

    const styleByCell = cellStyles(output)
    const styleOf = (ref: string) => styleByCell.get(ref) ?? null
    expect(styleOf('A1')).toBe('2')
    // An existing `s` is replaced, not duplicated, and points at the copy of
    // the format the cell already had rather than at the first one.
    expect(styleOf('A5')).toBe('3')
    expect(styleOf('B1')).toBeNull()
    expect(styleOf('C1')).toBeNull()
    expect(styleOf('E1')).toBeNull()
  })

  it('keeps a translated cell’s font, border and centring while enabling wrap', () => {
    const output = rebuild(buildStyledWorkbook(), STYLED_TRANSLATIONS, false)

    const bordered = styleOfCell(output, 'A1')
    expect(bordered.getAttribute('fontId')).toBe('4')
    expect(bordered.getAttribute('borderId')).toBe('1')
    expect(bordered.getAttribute('applyFont')).toBe('1')
    expect(bordered.getAttribute('applyBorder')).toBe('1')
    expect(bordered.getAttribute('applyAlignment')).toBe('1')
    expect(alignmentOf(bordered).getAttribute('wrapText')).toBe('1')
    expect(alignmentOf(bordered).getAttribute('vertical')).toBe('top')

    // The centred source has an alignment child; it keeps `horizontal` and only
    // gains the two wrapping attributes.
    const centered = styleOfCell(output, 'A2')
    expect(alignmentOf(centered).getAttribute('horizontal')).toBe('center')
    expect(alignmentOf(centered).getAttribute('wrapText')).toBe('1')
    expect(alignmentOf(centered).getAttribute('vertical')).toBe('top')
  })

  it('gives translated cells with different source formats different copies', () => {
    const output = rebuild(buildStyledWorkbook(), STYLED_TRANSLATIONS, false)
    const styles = cellStyles(output)
    expect(styles.get('A1')).not.toBe(styles.get('A2'))
    expect(styleOfCell(output, 'A1').getAttribute('fontId')).toBe('4')
    expect(styleOfCell(output, 'A2').getAttribute('fontId')).toBe('0')
    expect(styleOfCell(output, 'A2').getAttribute('borderId')).toBe('0')
  })

  it('derives one copy for translated cells that shared a format', () => {
    const output = rebuild(buildStyledWorkbook(), STYLED_TRANSLATIONS, false)
    const styles = cellStyles(output)
    // A1, A3 and A4 all came from xf 1.
    expect(styles.get('A3')).toBe(styles.get('A1'))
    expect(styles.get('A4')).toBe(styles.get('A1'))
    // Two copies total: one per distinct source style.
    expect(cellXfs(output).length).toBe(6)
  })

  it('leaves the style of untranslated cells alone', () => {
    const before = cellStyles(buildStyledWorkbook())
    const output = rebuild(buildStyledWorkbook(), STYLED_TRANSLATIONS, false)
    const after = cellStyles(output)

    // B is an enumeration column, C holds numbers: both keep their own format.
    expect(after.get('B1')).toBe('3')
    expect(after.get('B2')).toBe('3')
    expect(after.get('C1')).toBe('2')
    expect(after.get('A1')).not.toBe(before.get('A1'))
    // The untranslated format's alignment is not the one that got rewritten.
    const untouched = cellXfs(output)[3]
    expect(alignmentOf(untouched).getAttribute('wrapText')).toBe('0')
    expect(alignmentOf(untouched).getAttribute('vertical')).toBe('bottom')
  })

  it('increments the cellXfs count by the number of derived formats', () => {
    const output = rebuild(buildStyledWorkbook(), STYLED_TRANSLATIONS, false)
    const styles = readPart(output, 'xl/styles.xml')

    expect(cellXfs(buildStyledWorkbook()).length).toBe(4)
    expect(styles).toContain('<cellXfs count="6">')
    expect(cellXfs(output).length).toBe(6)
    // Only `<cellXfs>` grows.
    expect(styles).toContain('<cellStyleXfs count="1">')
    expect(styles).toContain('<cellStyles count="1">')
    expect(styles).toContain('<dxfs count="0"/>')
    expect(styles).toContain('<fonts count="5">')
    expect(styles).toContain('<borders count="2">')

    // The derived formats, in first-encounter order: the bordered font-4 style,
    // then the centred style.
    expect(styles).toContain(
      '<xf borderId="1" fillId="0" fontId="4" numFmtId="0" xfId="0" applyBorder="1" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
    )
    expect(styles).toContain(
      '<xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>',
    )
    parseXml(styles)
  })

  it('returns the original bytes when there is nothing to write', () => {
    const data = buildWorkbook()
    expect(rebuild(data, PROSE.map(() => undefined), true)).toBe(data)
  })

  it('takes .xlsx files through the files-page handler', async () => {
    const { getHandler } = await import('./documents')
    const file = new File([buildWorkbook()], 'sheet.xlsx')
    const handler = getHandler(file)
    expect(handler?.kind).toBe('spreadsheet')
    const doc = await handler!.parse(file)
    expect(doc.segments).toEqual(PROSE)
    expect(doc.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    const output = doc.rebuild(TRANSLATIONS, false)
    expect(output).toBeInstanceOf(Uint8Array)
    expect(sharedStringTexts(output as Uint8Array)[SI.prose0]).toBe(TRANSLATIONS[0])
  })
})

describe('parseXlsx with rich-text runs', () => {
  it('translates shared strings that hold rich-text runs', () => {
    const doc = parseXlsx(buildRichWorkbook())
    // The runs of one `<si>` are merged in document order, and the merged text
    // is what the column heuristic and the request see.
    expect(doc.segments).toEqual(RICH_PROSE)
  })

  it('appends one run for the translation and keeps every source run when bilingual', () => {
    const source = sharedStringXml(RICH_SHARED_STRINGS, RICH_SI.runs)
    const after = rebuiltSharedString(
      rebuild(buildRichWorkbook(), RICH_TRANSLATIONS, true),
      RICH_SI.runs,
    )

    const before = runElements(source)
    const written = runElements(after)
    expect(written).toHaveLength(before.length + 1)
    // Not a character of the source runs moved, so the link's blue underline
    // and the body font are exactly what Excel wrote.
    expect(written.slice(0, -1)).toEqual(before)
    expect(before[1]).toContain('rgb="FF1155CC"')

    // The new run is the last child of the `<si>`, copies the last run's
    // properties (the body style, not the link) and holds the translation
    // below the source.
    expect(written[written.length - 1]).toBe(
      `<r>${runProperties(before[before.length - 1])}<t xml:space="preserve">\n${RICH_TRANSLATIONS[1]}</t></r>`,
    )
  })

  it('writes the translation into the first run and empties the rest when not bilingual', () => {
    const after = rebuiltSharedString(
      rebuild(buildRichWorkbook(), RICH_TRANSLATIONS, false),
      RICH_SI.runs,
    )
    expect(after).toBe(
      `<si><r>${BODY_RPR}<t xml:space="preserve">${RICH_TRANSLATIONS[1]}</t></r>` +
        `<r>${LINK_RPR}<t></t></r>` +
        `<r>${BODY_RPR}<t xml:space="preserve"></t></r></si>`,
    )
    // The empties keep their elements and their formatting: a run stripped of
    // its children is not something Excel expects.
    expect(runElements(after)).toHaveLength(3)
    expect(after.match(/<rPr>/g)).toHaveLength(3)
  })

  it('writes into a first run that carries no rPr', () => {
    const after = rebuiltSharedString(
      rebuild(buildRichWorkbook(), RICH_TRANSLATIONS, false),
      RICH_SI.firstRunWithoutRPr,
    )
    expect(after).toBe(
      `<si><r><t xml:space="preserve">${RICH_TRANSLATIONS[3]}</t></r>` +
        `<r>${BOLD_RPR}<t></t></r></si>`,
    )
  })

  it('writes into a self-closing <t/>', () => {
    const after = rebuiltSharedString(
      rebuild(buildRichWorkbook(), RICH_TRANSLATIONS, false),
      RICH_SI.selfClosing,
    )
    expect(after).toBe(
      `<si><r>${ITALIC_RPR}<t xml:space="preserve">${RICH_TRANSLATIONS[4]}</t></r>` +
        `<r>${ITALIC_RPR}<t></t></r></si>`,
    )
  })

  it('omits the copied rPr when the last run has none and escapes the translation', () => {
    const translations = [...RICH_TRANSLATIONS.slice(0, 5), 'A & B < C 的译文']
    const after = rebuiltSharedString(
      rebuild(buildRichWorkbook(), translations, true),
      RICH_SI.escaped,
    )
    const written = runElements(after)
    expect(runProperties(written[written.length - 1])).toBe('')
    expect(after).toContain('\nA &amp; B &lt; C 的译文</t></r></si>')
    // The source runs keep the `&amp;` and `&lt;` they were written with.
    expect(written.slice(0, -1)).toEqual(
      runElements(sharedStringXml(RICH_SHARED_STRINGS, RICH_SI.escaped)),
    )
  })

  it('derives a wrap style for the cell that shows a rich-text string', () => {
    const output = rebuild(buildRichWorkbook(), RICH_TRANSLATIONS, false)
    expect(readPart(output, 'xl/styles.xml')).toContain('<cellXfs count="4">')

    // A2 holds the rich string and already had a format: its `s` is replaced
    // with a wrapped copy of that format, not with the sheet's first one.
    expect(cellStyles(output).get('A2')).toBe('3')
    const derived = styleOfCell(output, 'A2')
    expect(derived.getAttribute('numFmtId')).toBe('164')
    expect(derived.getAttribute('applyAlignment')).toBe('1')
    expect(alignmentOf(derived).getAttribute('wrapText')).toBe('1')
    expect(alignmentOf(derived).getAttribute('vertical')).toBe('top')

    // The enumeration column keeps its own format.
    expect(cellStyles(output).get('B1')).toBeNull()
  })

  it('rebuilds the same bytes on every call', () => {
    const data = buildRichWorkbook()
    const doc = parseXlsx(data)
    const first = doc.rebuild(RICH_TRANSLATIONS, true)
    expect(Array.from(doc.rebuild(RICH_TRANSLATIONS, true))).toEqual(Array.from(first))
    // The source bytes were left alone, so a later download starts from them.
    expect(doc.rebuild([], true)).toBe(data)
  })
})
