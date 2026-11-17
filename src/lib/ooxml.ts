// Helpers shared by the OOXML handlers (xlsx, docx). Both edit a part of the
// package by locating substrings and splicing them, never by parsing and
// re-serialising a DOM: real files carry `mc:Ignorable`, `w14:paraId` and
// self-closing tags that a round trip drops or rewrites, and Word/Excel then
// refuses to open the file.

export interface Splice {
  /** Offsets into the original string; splices must not overlap. */
  start: number
  end: number
  text: string
}

/**
 * Apply every splice to `text` in one pass: the splices are sorted by position
 * and walked front to back, copying the text between them as it goes, so their
 * offsets all stay offsets into the original string.
 */
export function applySplices(text: string, splices: Splice[]): string {
  let out = ''
  let cursor = 0
  for (const splice of [...splices].sort((a, b) => a.start - b.start)) {
    if (splice.start < cursor) throw new Error(`overlapping splice at ${splice.start}`)
    out += text.slice(cursor, splice.start) + splice.text
    cursor = splice.end
  }
  return out + text.slice(cursor)
}

export function xmlUnescape(text: string): string {
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
export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The same open tag with `xml:space="preserve"` added when the text it will
 * hold has a leading/trailing space or a newline that the XML reader would
 * otherwise trim. An attribute already in the tag is left as it is.
 */
export function withPreserve(openTag: string, preserve: boolean): string {
  const attrs = openTag.slice(2, -1)
  if (!preserve || attrs.includes('xml:space=')) return openTag
  return `<t xml:space="preserve"${attrs}>`
}
