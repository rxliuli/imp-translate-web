import { createLazyFileRoute } from '@tanstack/react-router'
import { useState, useRef, useEffect, useCallback } from 'react'
import { Download, Loader2, RotateCw, Upload, X } from 'lucide-react'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { LANGUAGES } from '@/lib/languages'
import { rpc } from '@/lib/rpc'
import { parseHtml, applyTranslations } from '@/lib/html'
import hostScript from './html-host.js?raw'
import {
  EXTENSION_LINK,
  STORAGE_KEY,
  getDefaultTargetLang,
  useExtensionInstalled,
  getOutputFilename,
} from '@/lib/shared'

export const Route = createLazyFileRoute('/html')({
  component: HtmlPage,
})

const BATCH_SIZE = 20

function HtmlPage() {
  const extensionInstalled = useExtensionInstalled()
  const [targetLang, setTargetLang] = useState(getDefaultTargetLang)
  const [bilingual, setBilingual] = useState(true)
  const [fileName, setFileName] = useState('')
  const [sourceText, setSourceText] = useState('')
  const [segments, setSegments] = useState<string[]>([])
  const [translations, setTranslations] = useState<(string | null)[]>([])
  const [errors, setErrors] = useState<boolean[]>([])
  const [translating, setTranslating] = useState(false)
  const [preview, setPreview] = useState<{ srcDoc: string; bodyHtml: string } | null>(
    null,
  )
  const [previewHeight, setPreviewHeight] = useState(600)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const translateIdRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const translateSegments = useCallback(async (segs: string[], to: string) => {
    const id = ++translateIdRef.current
    for (let start = 0; start < segs.length; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, segs.length)
      const batch = segs.slice(start, end)
      try {
        const res = await rpc.sendMessage('translateBatch', {
          texts: batch,
          to,
        })
        if (translateIdRef.current !== id) return
        const updates = res.map((text, j) => ({
          index: start + j,
          text: text ?? batch[j],
        }))
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'translate', updates },
          '*',
        )
        setTranslations((prev) => {
          const next = [...prev]
          for (let j = 0; j < res.length; j++) {
            next[start + j] = res[j] ?? batch[j]
          }
          return next
        })
      } catch {
        if (translateIdRef.current !== id) return
        setErrors((prev) => {
          const next = [...prev]
          for (let j = start; j < end; j++) next[j] = true
          return next
        })
      }
    }
    if (translateIdRef.current === id) setTranslating(false)
  }, [])

  // Listen for the iframe posting its segments back, then translate them.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      const data = e.data as {
        type?: string
        segments?: string[]
        height?: number
      }
      if (data?.type === 'height' && typeof data.height === 'number') {
        setPreviewHeight(data.height)
        return
      }
      if (data?.type !== 'segments' || !data.segments) return
      setSegments(data.segments)
      setTranslations(new Array(data.segments.length).fill(null))
      setErrors(new Array(data.segments.length).fill(false))
      setTranslating(true)
      translateSegments(data.segments, targetLang)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [translateSegments, targetLang])

  async function retryFailed() {
    if (!extensionInstalled) return
    const failedIndices = errors
      .map((e, i) => (e ? i : -1))
      .filter((i) => i !== -1)
    if (failedIndices.length === 0) return

    setErrors((prev) => prev.map(() => false))
    setTranslating(true)
    const id = ++translateIdRef.current

    for (let b = 0; b < failedIndices.length; b += BATCH_SIZE) {
      const batchIndices = failedIndices.slice(b, b + BATCH_SIZE)
      const batchTexts = batchIndices.map((i) => segments[i])
      try {
        const res = await rpc.sendMessage('translateBatch', {
          texts: batchTexts,
          to: targetLang,
        })
        if (translateIdRef.current !== id) return
        const updates = res.map((text, j) => ({
          index: batchIndices[j],
          text: text ?? batchTexts[j],
        }))
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'translate', updates },
          '*',
        )
        setTranslations((prev) => {
          const next = [...prev]
          batchIndices.forEach((i, j) => {
            next[i] = res[j] ?? batchTexts[j]
          })
          return next
        })
      } catch {
        if (translateIdRef.current !== id) return
        setErrors((prev) => {
          const next = [...prev]
          batchIndices.forEach((i) => (next[i] = true))
          return next
        })
      }
    }
    if (translateIdRef.current === id) setTranslating(false)
  }

  async function loadFile(file: File) {
    if (!extensionInstalled) return
    const text = await file.text()
    setFileName(file.name)
    setSourceText(text)
    setSegments([])
    setTranslations([])
    setErrors([])
    setTranslating(false)
    setPreview(buildPreviewLayout(text))
    setPreviewHeight(600)
  }

  function reset() {
    translateIdRef.current++
    setFileName('')
    setSourceText('')
    setSegments([])
    setTranslations([])
    setErrors([])
    setTranslating(false)
    setPreview(null)
  }

  function handleTargetLangChange(value: string) {
    setTargetLang(value)
    localStorage.setItem(STORAGE_KEY, value)
    // Re-translate the already-parsed segments for the new target language.
    if (segments.length > 0) translateSegments(segments, value)
  }

  function handleModeChange(value: string) {
    const next = value === 'bilingual'
    setBilingual(next)
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'mode', mode: next ? 'bilingual' : 'target' },
      '*',
    )
  }

  function handleIframeLoad() {
    if (!preview) return
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'init', html: preview.bodyHtml, mode: bilingual ? 'bilingual' : 'target' },
      '*',
    )
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = Array.from(e.dataTransfer.files).find((f) =>
      /\.html?$/i.test(f.name),
    )
    if (file) loadFile(file)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
  }

  // Re-parse from the source text to produce the clean translated HTML used
  // for copy/download (unaffected by the iframe preview).
  const outputHtml = computeOutputHtml(sourceText, translations, bilingual)
  const hasError = errors.some(Boolean)
  const outputName = fileName
    ? getOutputFilename(fileName, targetLang, bilingual)
    : ''
  const total = translations.length
  const done = translations.filter((t) => t !== null).length
  const errorCount = errors.filter(Boolean).length
  const status = hasError
    ? 'error'
    : translating
      ? 'translating'
      : 'done'
  const progress = total > 0 ? (done / total) * 100 : 100

  function handleDownload() {
    if (outputName) downloadHtmlFile(outputHtml, outputName)
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-3 py-4 md:p-6">
      {!extensionInstalled && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950 dark:text-yellow-200">
          Imp Translate extension is not detected.{' '}
          <a
            href={EXTENSION_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline"
          >
            Install it
          </a>{' '}
          to use the translation feature.
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Auto Detect</span>
        <span className="text-muted-foreground">&rarr;</span>
        <NativeSelect
          value={targetLang}
          onChange={(e) => handleTargetLangChange(e.target.value)}
        >
          {LANGUAGES.map(([code, name]) => (
            <NativeSelectOption key={code} value={code}>
              {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          value={bilingual ? 'bilingual' : 'target'}
          onChange={(e) => handleModeChange(e.target.value)}
        >
          <NativeSelectOption value="bilingual">Bilingual</NativeSelectOption>
          <NativeSelectOption value="target">Target Only</NativeSelectOption>
        </NativeSelect>
      </div>

      {/* Upload */}
      <div
        className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-muted-foreground/25 p-6 transition-colors hover:border-muted-foreground/50"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="size-8 text-muted-foreground" />
        <div className="text-center">
          <p className="text-sm font-medium">
            Drop HTML file here or click to browse
          </p>
          <p className="text-xs text-muted-foreground">Supports .html, .htm</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".html,.htm"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) loadFile(file)
            e.target.value = ''
          }}
        />
      </div>

      {fileName && (
        <div className="flex flex-col gap-2">
          {/* File row */}
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
                <span className="truncate text-sm font-medium">{fileName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  &rarr; {outputName}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-all ${
                      status === 'error'
                        ? 'bg-destructive'
                        : status === 'done'
                          ? 'bg-green-500'
                          : 'bg-primary'
                    }`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {status === 'error' ? (
                    <span className="text-destructive">
                      {errorCount} failed
                    </span>
                  ) : status === 'done' ? (
                    'Done'
                  ) : (
                    `${done}/${total}`
                  )}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {status === 'translating' && (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
              {status === 'error' && (
                <button
                  onClick={retryFailed}
                  className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-foreground"
                  title="Retry failed segments"
                >
                  <RotateCw className="size-4" />
                </button>
              )}
              <button
                onClick={reset}
                className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-foreground"
                title="Remove file"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* Live preview: sandboxed iframe that patches segments in place */}
          <div className="group/target relative flex min-h-[300px] flex-col rounded-lg border border-input bg-muted/30">
            {preview ? (
              <div className="relative overflow-hidden rounded-lg">
                <iframe
                  ref={iframeRef}
                  title="Translated HTML preview"
                  sandbox="allow-scripts"
                  srcDoc={preview.srcDoc}
                  onLoad={handleIframeLoad}
                  className="w-full"
                  style={{
                    height: `${previewHeight}px`,
                    minHeight: '300px',
                  }}
                />
                {translating && (
                  <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur-sm">
                    <Loader2 className="size-3.5 animate-spin" />
                    Translating…
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-base text-muted-foreground">
                Loading…
              </div>
            )}

            {outputHtml && (
              <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/target:opacity-100">
                {hasError && (
                  <span className="rounded-md bg-destructive/90 px-2 py-1 text-xs text-white backdrop-blur-sm">
                    <button
                      onClick={retryFailed}
                      className="flex cursor-pointer items-center gap-1"
                    >
                      <RotateCw className="size-3.5" />
                      Retry
                    </button>
                  </span>
                )}
                <OutputButton
                  onClick={handleDownload}
                  title="Download translated HTML"
                >
                  <Download className="size-4" />
                </OutputButton>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}

// Build the sandboxed host document shown inside the iframe. It renders the
// sanitized source (preview only: scripts/event handlers stripped) and houses a
// small host script that the app talks to via postMessage to patch each
// translated segment in place — so the iframe never reloads and scroll/focus
// are preserved while a large file translates.
function buildPreviewLayout(
  sourceText: string,
): { srcDoc: string; bodyHtml: string } {
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

  const headHtml = isFullDoc ? doc.querySelector('head')?.innerHTML ?? '' : ''
  const bodyHtml = (doc.querySelector('body') ?? doc.documentElement).innerHTML

  const style =
    '<style>:root{color-scheme:light dark} html,body{margin:0} img{max-width:100%}</style>'
  const host =
    '<script>(' + hostScript + ')()' + '</scr' + 'ipt>'
  const srcDoc = `<!doctype html><html><head>${headHtml}${style}${host}</head><body></body></html>`

  return { srcDoc, bodyHtml }
}

function computeOutputHtml(
  sourceText: string,
  translations: (string | null)[],
  bilingual: boolean,
): string {
  if (!sourceText.trim()) return ''
  const parsed = parseHtml(sourceText)
  if (parsed.segments.length === 0) return parsed.serialize()
  const values = parsed.segments.map((s, i) => translations[i] ?? s)
  applyTranslations(parsed.doc, values, bilingual)
  return parsed.serialize()
}

function downloadHtmlFile(html: string, filename: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function OutputButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="cursor-pointer rounded-md bg-background/80 p-1.5 text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground"
    >
      {children}
    </button>
  )
}
