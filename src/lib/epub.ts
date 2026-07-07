import { unzipSync, zipSync, strToU8, strFromU8, type Zippable } from 'fflate'

export interface ParsedEpub {
  segments: string[]
  rebuild(translations: string[], bilingual: boolean): Uint8Array
}

const XHTML_NS = 'http://www.w3.org/1999/xhtml'

const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'del', 'dfn',
  'em', 'font', 'i', 'img', 'ins', 'kbd', 'mark', 'q', 'rp', 'rt', 'ruby',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u',
  'var', 'wbr',
])

const SKIP_TAGS = new Set(['script', 'style', 'template', 'svg', 'math'])

// A run is a maximal sequence of text nodes forming one line of content:
// inline elements are transparent, <br/> and block elements end the run.
type Run = Text[]

function collectRuns(root: Element): Run[] {
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

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function runText(run: Run): string {
  return normalize(run.map((t) => t.data).join(''))
}

function insertBilingual(run: Run, translation: string): void {
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

function replaceRun(run: Run, translation: string): void {
  const target = run.find((t) => t.data.trim()) ?? run[0]
  for (const t of run) {
    if (t !== target) t.data = ''
  }
  target.data = translation
}

function parseXml(
  xml: string,
  type: DOMParserSupportedType = 'application/xml',
): Document | null {
  try {
    const doc = new DOMParser().parseFromString(xml, type)
    if (doc.querySelector('parsererror')) return null
    return doc
  } catch {
    return null
  }
}

// Content files are often not well-formed XML (undeclared entities like
// &nbsp;); fall back to the forgiving HTML parser rather than skip them.
function parseContentDoc(html: string): Document | null {
  return (
    parseXml(html, 'application/xhtml+xml') ?? parseXml(html, 'text/html')
  )
}

function findOpfPath(files: Record<string, Uint8Array>): string {
  const data = files['META-INF/container.xml']
  if (!data) return ''
  const doc = parseXml(strFromU8(data))
  if (!doc) return ''
  return doc.querySelector('rootfile')?.getAttribute('full-path') ?? ''
}

function findContentPaths(
  files: Record<string, Uint8Array>,
  opfPath: string,
): { contentPaths: string[]; ncxPath: string } {
  const data = files[opfPath]
  if (!data) return { contentPaths: [], ncxPath: '' }
  const doc = parseXml(strFromU8(data))
  if (!doc) return { contentPaths: [], ncxPath: '' }

  const opfDir = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
    : ''

  const manifest = new Map<string, string>()
  let ncxPath = ''
  let navPath = ''
  for (const item of doc.querySelectorAll('item')) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    const mt = item.getAttribute('media-type')
    if (!id || !href) continue
    const path = opfDir + decodeURIComponent(href)
    if (mt === 'application/xhtml+xml' || mt === 'text/html') {
      manifest.set(id, path)
      const props = item.getAttribute('properties') ?? ''
      if (props.split(/\s+/).includes('nav')) navPath = path
    } else if (mt === 'application/x-dtbncx+xml') {
      ncxPath = path
    }
  }

  const contentPaths: string[] = []
  for (const ref of doc.querySelectorAll('itemref')) {
    const idref = ref.getAttribute('idref')
    if (idref && manifest.has(idref)) contentPaths.push(manifest.get(idref)!)
  }
  // EPUB3 nav doc may not be in the spine but its TOC labels still matter
  if (navPath && !contentPaths.includes(navPath)) contentPaths.push(navPath)
  return { contentPaths, ncxPath }
}

function getNcxLabels(doc: Document): Element[] {
  return Array.from(
    doc.querySelectorAll('docTitle > text, navLabel > text'),
  ).filter((el) => el.textContent?.trim())
}

interface DocInfo {
  path: string
  kind: 'xhtml' | 'ncx'
  segmentCount: number
}

export function parseEpub(data: Uint8Array): ParsedEpub {
  const files = unzipSync(data)
  const opfPath = findOpfPath(files)
  const { contentPaths, ncxPath } = findContentPaths(files, opfPath)

  const docs: DocInfo[] = []
  const allSegments: string[] = []

  for (const path of contentPaths) {
    if (!files[path]) continue
    const doc = parseContentDoc(strFromU8(files[path]))
    if (!doc) continue
    const body = doc.querySelector('body') ?? doc.documentElement
    const segs = collectRuns(body).map(runText)
    docs.push({ path, kind: 'xhtml', segmentCount: segs.length })
    allSegments.push(...segs)
  }

  if (ncxPath && files[ncxPath]) {
    const doc = parseXml(strFromU8(files[ncxPath]))
    if (doc) {
      const segs = getNcxLabels(doc).map((el) =>
        normalize(el.textContent ?? ''),
      )
      docs.push({ path: ncxPath, kind: 'ncx', segmentCount: segs.length })
      allSegments.push(...segs)
    }
  }

  return {
    segments: allSegments,
    rebuild(translations, bilingual) {
      const newFiles: Zippable = {}
      // EPUB requires mimetype to be the first entry, stored uncompressed
      if (files['mimetype']) {
        newFiles['mimetype'] = [files['mimetype'], { level: 0 }]
      }
      for (const [p, d] of Object.entries(files)) {
        if (p !== 'mimetype') newFiles[p] = d
      }

      const serializer = new XMLSerializer()
      let offset = 0
      for (const info of docs) {
        const xml = strFromU8(files[info.path])
        if (info.kind === 'xhtml') {
          const doc = parseContentDoc(xml)
          if (!doc) {
            offset += info.segmentCount
            continue
          }
          const body = doc.querySelector('body') ?? doc.documentElement
          const runs = collectRuns(body)
          for (let i = 0; i < runs.length; i++) {
            const translation = translations[offset + i]?.trim()
            if (!translation || translation === runText(runs[i])) continue
            if (bilingual) insertBilingual(runs[i], translation)
            else replaceRun(runs[i], translation)
          }
          newFiles[info.path] = strToU8(serializer.serializeToString(doc))
        } else {
          const doc = parseXml(xml)
          if (!doc) {
            offset += info.segmentCount
            continue
          }
          const labels = getNcxLabels(doc)
          for (let i = 0; i < labels.length; i++) {
            const translation = translations[offset + i]?.trim()
            if (translation) labels[i].textContent = translation
          }
          newFiles[info.path] = strToU8(serializer.serializeToString(doc))
        }
        offset += info.segmentCount
      }

      return new Uint8Array(zipSync(newFiles))
    },
  }
}
