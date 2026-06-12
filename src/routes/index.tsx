import { createFileRoute } from '@tanstack/react-router'
import { useState, useRef } from 'react'
import { Loader2, RotateCw } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { LANGUAGES } from '@/lib/languages'
import { rpc } from '@/lib/rpc'
import { splitSegments, buildSourceRanges } from '@/lib/segments'
import {
  EXTENSION_LINK,
  STORAGE_KEY,
  getDefaultTargetLang,
  useExtensionInstalled,
  CopyButton,
  type Segment,
} from '@/lib/shared'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const extensionInstalled = useExtensionInstalled()
  const [targetLang, setTargetLang] = useState(getDefaultTargetLang)
  const [sourceText, setSourceText] = useState('')
  const [segments, setSegments] = useState<Segment[]>([])
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)
  const translateIdRef = useRef(0)

  function translateSegments(text: string, to: string) {
    if (!extensionInstalled) return
    const sources = splitSegments(text)
    if (sources.length === 0) {
      setSegments([])
      return
    }

    const id = ++translateIdRef.current

    setSegments((prev) =>
      sources.map((source) => {
        const existing = prev.find(
          (s) => s.source === source && s.status === 'done',
        )
        if (existing) return existing
        return { source, translated: '', status: 'pending' as const }
      }),
    )

    sources.forEach((source, i) => {
      rpc
        .sendMessage('translate', { texts: [source], to })
        .then((results) => {
          if (translateIdRef.current !== id) return
          setSegments((prev) =>
            prev.map((seg, j) =>
              j === i && seg.source === source
                ? { ...seg, translated: results[0] ?? '', status: 'done' }
                : seg,
            ),
          )
        })
        .catch(() => {
          if (translateIdRef.current !== id) return
          setSegments((prev) =>
            prev.map((seg, j) =>
              j === i && seg.source === source
                ? { ...seg, status: 'error' }
                : seg,
            ),
          )
        })
    })
  }

  function retryAllFailed() {
    const failedIndices = segments
      .map((s, i) => (s.status === 'error' ? i : -1))
      .filter((i) => i !== -1)
    if (failedIndices.length === 0) return

    setSegments((prev) =>
      prev.map((s) =>
        s.status === 'error' ? { ...s, status: 'pending' as const } : s,
      ),
    )

    failedIndices.forEach((i) => {
      const seg = segments[i]
      rpc
        .sendMessage('translate', { texts: [seg.source], to: targetLang })
        .then((results) => {
          setSegments((prev) =>
            prev.map((s, j) =>
              j === i && s.source === seg.source
                ? { ...s, translated: results[0] ?? '', status: 'done' }
                : s,
            ),
          )
        })
        .catch(() => {
          setSegments((prev) =>
            prev.map((s, j) =>
              j === i && s.source === seg.source
                ? { ...s, status: 'error' }
                : s,
            ),
          )
        })
    })
  }

  function handleSourceChange(value: string) {
    setSourceText(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!value.trim()) {
      setSegments([])
      return
    }
    debounceRef.current = setTimeout(() => {
      translateSegments(value, targetLang)
    }, 500)
  }

  function handleTargetLangChange(value: string) {
    setTargetLang(value)
    localStorage.setItem(STORAGE_KEY, value)
    if (sourceText.trim()) {
      translateSegments(sourceText, value)
    }
  }

  const sourceRanges = buildSourceRanges(sourceText)

  function renderSourceOverlay() {
    if (!sourceText) return null
    if (segments.length === 0 || sourceRanges.length === 0) return sourceText
    const parts: React.ReactNode[] = []
    let cursor = 0
    sourceRanges.forEach((range, i) => {
      if (cursor < range.start) {
        parts.push(
          <span key={`gap-${i}`}>{sourceText.slice(cursor, range.start)}</span>,
        )
      }
      parts.push(
        <span
          key={`seg-${i}`}
          className={`rounded transition-colors ${hoveredIndex === i ? 'bg-[#d3e3fd] dark:bg-[#2a3a50]' : ''}`}
        >
          {sourceText.slice(range.start, range.end)}
        </span>,
      )
      cursor = range.end
    })
    if (cursor < sourceText.length) {
      parts.push(<span key="tail">{sourceText.slice(cursor)}</span>)
    }
    return parts
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
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {/* Source: textarea + highlight overlay */}
        <div className="relative flex min-h-[150px] flex-col rounded-lg border border-input md:min-h-[300px]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-4 text-base"
          >
            {renderSourceOverlay()}
          </div>
          <Textarea
            autoFocus
            className="flex-1 resize-none border-none bg-transparent p-4 text-base text-transparent caret-foreground shadow-none ring-0 focus-visible:border-none focus-visible:ring-0 md:text-base"
            placeholder="Enter text to translate..."
            value={sourceText}
            onChange={(e) => handleSourceChange(e.target.value)}
          />
        </div>

        {/* Target: pre-wrap block mirroring source structure */}
        <div className={`group/target relative min-h-[150px] flex-col rounded-lg border border-input bg-muted/30 md:min-h-[300px] ${!sourceText.trim() ? 'hidden md:flex' : 'flex'}`}>
          <div className="flex-1 whitespace-pre-wrap break-words p-4 text-base">
            {!extensionInstalled && sourceText.trim() ? (
              <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  Install the extension to translate
                </p>
                <a
                  href={EXTENSION_LINK}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants()}
                >
                  Install Extension
                </a>
              </div>
            ) : segments.length === 0 ? (
              <span className="text-muted-foreground">Translation</span>
            ) : (
              segments.map((seg, i) => (
                <span key={i}>
                  <span
                    className={`rounded transition-colors ${
                      hoveredIndex === i
                        ? 'bg-[#d3e3fd] dark:bg-[#2a3a50]'
                        : 'hover:bg-[#d3e3fd]/50 dark:hover:bg-[#2a3a50]/50'
                    }`}
                    onMouseEnter={() => setHoveredIndex(i)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    {seg.status === 'pending' ? (
                      <Loader2 className="inline size-4 animate-spin text-muted-foreground" />
                    ) : seg.status === 'error' ? (
                      <span
                        role="button"
                        onClick={retryAllFailed}
                        className="inline-flex cursor-pointer items-center gap-1 text-destructive hover:text-destructive/80"
                      >
                        Translation failed
                        <RotateCw className="size-3" />
                      </span>
                    ) : (
                      seg.translated
                    )}
                  </span>
                  {sourceRanges[i]?.separator}
                </span>
              ))
            )}
          </div>
          {segments.some((s) => s.status === 'done') && (
            <CopyButton
              text={segments
                .map((s, i) => s.translated + (sourceRanges[i]?.separator ?? ''))
                .join('')}
            />
          )}
        </div>
      </div>
    </main>
  )
}
