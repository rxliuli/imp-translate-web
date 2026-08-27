import { unzipSync, zipSync, strToU8, strFromU8, type Zippable } from 'fflate'
import { applyTranslations, collectRuns, runText, normalize } from './html'

export interface ParsedEpub {
  segments: string[]
  rebuild(translations: string[], bilingual: boolean): Uint8Array
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
          applyTranslations(doc, translations, bilingual, offset)
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
