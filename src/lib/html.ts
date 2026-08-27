// Shared HTML segmenting & rebuild logic, used by both the EPUB translator
// and the HTML translation route. A "run" is a maximal sequence of text nodes
// forming one line of content: inline elements are transparent, <br/> and
// block elements end the run. This is the same granularity the Imp Translate
// extension uses, so text isn't split mid-sentence by inline tags.

const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/** Inline tags are transparent — their text stays in the same run. */
export const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'del', 'dfn',
  'em', 'font', 'i', 'img', 'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u',
  'var', 'wbr',
])

/** Tags whose contents are never translated. */
export const SKIP_TAGS = new Set(['script', 'style', 'template', 'svg', 'math'])

export type Run = Text[]

/** Collect the maximal text-node runs under an element (not just <body>). */
export function collectRuns(root: Element): Run[] {
  const runs: Run[] = []
  let current: Run = []
  function flush() {
    if (current.some((t) => t.data.trim())) runs.push(current)
    current = []
  }
  function walk(el: Element) {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        current.push(child as Text)
      } else if (child.nodeType === 1) {
        const tag = (child as Element).localName
        if (tag === 'br') {
          flush()
        } else if (SKIP_TAGS.has(tag)) {
          continue
        } else if (INLINE_TAGS.has(tag)) {
          walk(child as Element)
        } else {
          flush()
          walk(child as Element)
          flush()
        }
      }
    }
  }
  walk(root)
  flush()
  return runs
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function runText(run: Run): string {
  return normalize(run.map((t) => t.data).join(''))
}

/** Bilingual mode: keep the source and append the translation inline. */
export function insertBilingual(run: Run, translation: string): void {
  const last = run[run.length - 1]
  const doc = last.ownerDocument!
  const parent = last.parentNode as Element | null
  if (!parent) return
  const ns = parent.namespaceURI ?? XHTML_NS
  const br = doc.createElementNS(ns, 'br')
  const span = doc.createElementNS(ns, 'span')
  span.setAttribute('style', 'color: #888;')
  span.textContent = translation
  parent.insertBefore(br, last.nextSibling)
  parent.insertBefore(span, br.nextSibling)
}

/** Target-only mode: replace the source text in place. */
export function replaceRun(run: Run, translation: string): void {
  const target = run.find((t) => t.data.trim()) ?? run[0]
  for (const t of run) {
    if (t !== target) t.data = ''
  }
  target.data = translation
}

/**
 * Apply translations to every run under <body> (or the root element) of a
 * document, mutating it in place. `offset` lets callers translate docs whose
 * segments come after earlier docs (used by the EPUB rebuild).
 */
export function applyTranslations(
  doc: Document,
  translations: readonly string[],
  bilingual: boolean,
  offset = 0,
): void {
  const body = doc.querySelector('body') ?? doc.documentElement
  const runs = collectRuns(body)
  for (let i = 0; i < runs.length; i++) {
    const translation = translations[offset + i]?.trim()
    if (!translation || translation === runText(runs[i])) continue
    if (bilingual) insertBilingual(runs[i], translation)
    else replaceRun(runs[i], translation)
  }
}

function isFullDocument(html: string): boolean {
  return /<(?:!doctype|html|head|body)\b/i.test(html)
}

export interface ParsedHtml {
  doc: Document
  /** One entry per translatable run, in document order. */
  segments: string[]
  /** Whether the input was a full document (<html>/<head>/<body>/<doctype>). */
  fullDocument: boolean
  /** Serialize back to HTML in the same form as the input. */
  serialize(): string
}

/**
 * Parse a pasted HTML snippet into {@link ParsedHtml}. Accepts both full
 * documents and bare fragments (a fragment is wrapped in <body> by the HTML
 * parser, so runs still come from <body>).
 */
export function parseHtml(html: string): ParsedHtml {
  const fullDocument = isFullDocument(html)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.querySelector('body') ?? doc.documentElement
  const segments = collectRuns(body).map(runText)
  return {
    doc,
    segments,
    fullDocument,
    serialize() {
      if (fullDocument) {
        const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : ''
        return doctype + doc.documentElement.outerHTML
      }
      return doc.body.innerHTML
    },
  }
}
