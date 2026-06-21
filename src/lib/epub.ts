import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'

export interface ParsedEpub {
  segments: string[]
  rebuild(translations: string[], bilingual: boolean): Uint8Array
}

const TEXT_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'div', 'blockquote',
  'li', 'td', 'th', 'dt', 'dd', 'figcaption',
])

function hasNestedTextTag(node: Element): boolean {
  for (const child of Array.from(node.children)) {
    if (TEXT_TAGS.has(child.localName) && child.textContent?.trim()) return true
    if (hasNestedTextTag(child)) return true
  }
  return false
}

function getTranslatableElements(body: Element): Element[] {
  const elements: Element[] = []
  function walk(node: Element) {
    if (TEXT_TAGS.has(node.localName) && node.textContent?.trim()) {
      if (!hasNestedTextTag(node)) {
        elements.push(node)
        return
      }
    }
    for (const child of Array.from(node.children)) walk(child)
  }
  walk(body)
  return elements
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
): string[] {
  const data = files[opfPath]
  if (!data) return []
  const doc = parseXml(strFromU8(data))
  if (!doc) return []

  const opfDir = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
    : ''

  const manifest = new Map<string, string>()
  for (const item of doc.querySelectorAll('item')) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    const mt = item.getAttribute('media-type')
    if (
      id &&
      href &&
      (mt === 'application/xhtml+xml' || mt === 'text/html')
    ) {
      manifest.set(id, opfDir + decodeURIComponent(href))
    }
  }

  const paths: string[] = []
  for (const ref of doc.querySelectorAll('itemref')) {
    const idref = ref.getAttribute('idref')
    if (idref && manifest.has(idref)) paths.push(manifest.get(idref)!)
  }
  return paths
}

export function parseEpub(data: Uint8Array): ParsedEpub {
  const files = unzipSync(data)
  const opfPath = findOpfPath(files)
  const contentPaths = findContentPaths(files, opfPath)

  const contentInfo: { path: string; segmentCount: number }[] = []
  const allSegments: string[] = []

  for (const path of contentPaths) {
    if (!files[path]) continue
    const html = strFromU8(files[path])
    const doc = parseXml(html, 'application/xhtml+xml')
    if (!doc) continue
    const body = doc.querySelector('body') ?? doc.documentElement
    const elements = getTranslatableElements(body)
    const segs = elements.map((el) => el.textContent?.trim() ?? '')
    contentInfo.push({ path, segmentCount: segs.length })
    allSegments.push(...segs)
  }

  return {
    segments: allSegments,
    rebuild(translations, bilingual) {
      const newFiles: Record<string, Uint8Array> = {}

      for (const [p, d] of Object.entries(files)) {
        newFiles[p] = d
      }

      let offset = 0
      for (const info of contentInfo) {
        const html = strFromU8(files[info.path])
        const doc = parseXml(html, 'application/xhtml+xml')
        if (!doc) {
          offset += info.segmentCount
          continue
        }
        const body = doc.querySelector('body') ?? doc.documentElement
        const elements = getTranslatableElements(body)

        for (let i = elements.length - 1; i >= 0; i--) {
          const el = elements[i]
          const translation = translations[offset + i]
          if (!translation) continue

          if (bilingual) {
            const ns = el.namespaceURI ?? 'http://www.w3.org/1999/xhtml'
            const clone = doc.createElementNS(ns, el.localName)
            clone.textContent = translation
            clone.setAttribute(
              'style',
              'color: #888; border-left: 2px solid #ddd; padding-left: 8px; margin-top: 2px;',
            )
            el.parentNode?.insertBefore(clone, el.nextSibling)
          } else {
            el.textContent = translation
          }
        }

        newFiles[info.path] = strToU8(
          new XMLSerializer().serializeToString(doc),
        )
        offset += info.segmentCount
      }

      return new Uint8Array(zipSync(newFiles))
    },
  }
}
