// Live, sandboxed HTML preview used by the /files route for .html/.htm
// uploads. Ported from the old html.lazy.tsx route: an iframe renders a
// sanitized copy of the source document and a small host script (see
// html-host.js) patches each translated segment in place via postMessage, so
// the iframe never reloads while translations stream in.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { parseHtml } from '@/lib/html'
import hostScript from './html-host.js?raw'

interface PreviewLayout {
  srcDoc: string
  bodyHtml: string
}

function buildPreviewLayout(sourceText: string): PreviewLayout {
  const doc = parseHtml(sourceText).doc
  const isFullDoc = /<html[\s>]/i.test(sourceText)

  // Strip scripts and event handlers for the preview only.
  doc.querySelectorAll('script').forEach((n) => n.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      if (
        (attr.name === 'href' || attr.name === 'src') &&
        attr.value.trim().toLowerCase().startsWith('javascript:')
      ) {
        el.removeAttribute(attr.name)
      }
    }
  })

  const headHtml = isFullDoc ? (doc.querySelector('head')?.innerHTML ?? '') : ''
  const bodyHtml = (doc.querySelector('body') ?? doc.documentElement).innerHTML

  const style =
    '<style>:root{color-scheme:light dark} html,body{margin:0} img{max-width:100%}</style>'
  const host = '<script>(' + hostScript + ')()' + '</scr' + 'ipt>'
  const srcDoc = `<!doctype html><html><head>${headHtml}${style}${host}</head><body></body></html>`

  return { srcDoc, bodyHtml }
}

interface HtmlPreviewProps {
  file: File
  translations: (string | undefined)[]
  bilingual: boolean
  translating: boolean
}

export function HtmlPreview({ file, translations, bilingual, translating }: HtmlPreviewProps) {
  // Keep the loaded layout tagged with the file it belongs to, so switching
  // `file` clears the preview by derivation (no synchronous setState in the
  // effect below) until the new file's layout has been built.
  const [preview, setPreview] = useState<{ file: File; layout: PreviewLayout } | null>(null)
  const [previewHeight, setPreviewHeight] = useState(600)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const loadedRef = useRef(false)
  // Indices already posted to the current iframe instance, so re-renders
  // with a growing `translations` array only send what's new instead of
  // resending every accumulated translation each time.
  const sentRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    let cancelled = false
    loadedRef.current = false
    sentRef.current = new Set()
    file.text().then((text) => {
      if (cancelled) return
      setPreview({ file, layout: buildPreviewLayout(text) })
      setPreviewHeight(600)
    })
    return () => {
      cancelled = true
    }
  }, [file])

  const layout = preview?.file === file ? preview.layout : null

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      const data = e.data as { type?: string; height?: number }
      if (data?.type === 'height' && typeof data.height === 'number') {
        setPreviewHeight(data.height)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const postTranslations = useCallback(() => {
    const updates: { index: number; text: string }[] = []
    translations.forEach((text, index) => {
      if (text === undefined || sentRef.current.has(index)) return
      sentRef.current.add(index)
      updates.push({ index, text })
    })
    if (updates.length === 0) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'translate', updates }, '*')
  }, [translations])

  // Push new translations into the already-loaded iframe as they arrive.
  useEffect(() => {
    if (!loadedRef.current) return
    postTranslations()
  }, [postTranslations])

  // Re-apply bilingual/target-only mode in place, without reloading.
  useEffect(() => {
    if (!loadedRef.current) return
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'mode', mode: bilingual ? 'bilingual' : 'target' },
      '*',
    )
  }, [bilingual])

  function handleIframeLoad() {
    if (!layout) return
    loadedRef.current = true
    // Fresh iframe instance (file change or preview reopened): nothing has
    // been sent to it yet, so the full current translation set goes out.
    sentRef.current = new Set()
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'init', html: layout.bodyHtml, mode: bilingual ? 'bilingual' : 'target' },
      '*',
    )
    postTranslations()
  }

  return (
    <div className="relative min-h-[300px] overflow-hidden rounded-lg border border-input bg-muted/30">
      {layout ? (
        <div className="relative overflow-hidden rounded-lg">
          <iframe
            ref={iframeRef}
            title="Translated HTML preview"
            sandbox="allow-scripts"
            srcDoc={layout.srcDoc}
            onLoad={handleIframeLoad}
            className="w-full"
            style={{ height: `${previewHeight}px`, minHeight: '300px' }}
          />
          {translating && (
            <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur-sm">
              <Loader2 className="size-3.5 animate-spin" />
              Translating…
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-[300px] items-center justify-center text-base text-muted-foreground">
          Loading…
        </div>
      )}
    </div>
  )
}
