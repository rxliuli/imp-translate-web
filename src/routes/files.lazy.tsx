import { createLazyFileRoute } from '@tanstack/react-router'
import { useRef, useState, useCallback } from 'react'
import { Download, Eye, EyeOff, Loader2, RotateCw, Upload, X } from 'lucide-react'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { buttonVariants } from '@/components/ui/button'
import { HtmlPreview } from '@/components/html-preview'
import { LANGUAGES } from '@/lib/languages'
import type { DocumentKind } from '@/lib/documents'
import { type FileItem, useFileTranslation } from '@/lib/useFileTranslation'
import {
  STORAGE_KEY,
  getDefaultTargetLang,
  useExtensionInstalled,
  getOutputFilename,
  ExtensionBanner,
} from '@/lib/shared'

export const Route = createLazyFileRoute('/files')({
  component: FilesPage,
})

const ACCEPT = '.epub,.html,.htm,.md,.markdown,.txt,.srt,.ass,.ssa'

function FilesPage() {
  const extensionInstalled = useExtensionInstalled()
  const [targetLang, setTargetLang] = useState(getDefaultTargetLang)
  const [bilingual, setBilingual] = useState(true)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { files, addFiles, retryFailed, isRetrying, remove, download, downloadAll } =
    useFileTranslation(targetLang, bilingual, extensionInstalled)

  function handleTargetLangChange(value: string) {
    setTargetLang(value)
    localStorage.setItem(STORAGE_KEY, value)
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const hasDone = files.some((f) => f.status === 'done')
  const hasError = files.some((f) => f.status === 'error')

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 overflow-x-hidden px-3 py-4 md:p-6">
      {!extensionInstalled && <ExtensionBanner />}

      <div className="flex items-center gap-2">
        <span className="shrink-0 text-sm text-muted-foreground">Auto Detect</span>
        <span className="text-muted-foreground">&rarr;</span>
        <NativeSelect
          className="min-w-0 !w-auto shrink"
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
          className="min-w-0 !w-auto shrink"
          value={bilingual ? 'bilingual' : 'target'}
          onChange={(e) => setBilingual(e.target.value === 'bilingual')}
        >
          <NativeSelectOption value="bilingual">Bilingual</NativeSelectOption>
          <NativeSelectOption value="target">Target Only</NativeSelectOption>
        </NativeSelect>
      </div>

      <div
        className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-muted-foreground/25 p-8 text-center transition-colors hover:border-muted-foreground/50"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="size-8 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Drop files here or click to browse</p>
          <p className="text-xs text-muted-foreground">
            Supports .epub, .html, .htm, .md, .markdown, .txt, .srt, .ass, .ssa
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          {files.map((f) => (
            <FileRow
              key={f.id}
              item={f}
              targetLang={targetLang}
              bilingual={bilingual}
              isPreviewOpen={previewId === f.id}
              onTogglePreview={() => setPreviewId((prev) => (prev === f.id ? null : f.id))}
              onDownload={() => download(f.id)}
              onRemove={() => {
                if (previewId === f.id) setPreviewId(null)
                remove(f.id)
              }}
            />
          ))}

          {(hasDone || hasError) && (
            <div className="flex items-center justify-center gap-2">
              {hasError && (
                <button
                  onClick={retryFailed}
                  disabled={isRetrying}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  <RotateCw className={`size-4 ${isRetrying ? 'animate-spin' : ''}`} />
                  {isRetrying ? 'Retrying…' : 'Retry Failed'}
                </button>
              )}
              {hasDone && (
                <button onClick={downloadAll} className={buttonVariants({ variant: 'default' })}>
                  <Download className="size-4" />
                  Download All
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </main>
  )
}

const KIND_LABELS: Record<DocumentKind, string> = {
  epub: 'EPUB',
  html: 'HTML',
  markdown: 'Markdown',
  text: 'Text',
  subtitle: 'Subtitle',
}

function KindBadge({ kind }: { kind: FileItem['kind'] }) {
  if (kind === 'unsupported') {
    return (
      <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
        Unsupported
      </span>
    )
  }
  return (
    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {KIND_LABELS[kind]}
    </span>
  )
}

function FileRow({
  item,
  targetLang,
  bilingual,
  isPreviewOpen,
  onTogglePreview,
  onDownload,
  onRemove,
}: {
  item: FileItem
  targetLang: string
  bilingual: boolean
  isPreviewOpen: boolean
  onTogglePreview: () => void
  onDownload: () => void
  onRemove: () => void
}) {
  const { status, progress } = item
  const errorCount = item.errors.filter(Boolean).length
  const progressPct =
    progress.total > 0 ? (progress.done / progress.total) * 100 : status === 'done' ? 100 : 0
  const outputName =
    item.kind !== 'unsupported' ? getOutputFilename(item.name, targetLang, bilingual) : ''
  const canPreview = item.kind === 'html'

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{item.name}</span>
            <KindBadge kind={item.kind} />
            {outputName && (
              <span className="truncate text-xs text-muted-foreground">&rarr; {outputName}</span>
            )}
          </div>

          {status === 'unsupported' ? (
            <p className="mt-1 text-xs text-destructive">{item.error}</p>
          ) : status === 'error' && item.error ? (
            <p className="mt-1 text-xs text-destructive">{item.error}</p>
          ) : (
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
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {status === 'error' ? (
                  <span className="text-destructive">{errorCount} failed</span>
                ) : status === 'done' ? (
                  'Done'
                ) : status === 'parsing' ? (
                  'Parsing…'
                ) : status === 'queued' ? (
                  'Queued'
                ) : (
                  `${progress.done}/${progress.total}`
                )}
              </span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {(status === 'parsing' || status === 'queued' || status === 'translating') && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
          {canPreview && (
            <button
              onClick={onTogglePreview}
              title={isPreviewOpen ? 'Hide preview' : 'Show preview'}
              className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-foreground"
            >
              {isPreviewOpen ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          )}
          {status === 'done' && (
            <button
              onClick={onDownload}
              title="Download"
              className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-foreground"
            >
              <Download className="size-4" />
            </button>
          )}
          <button
            onClick={onRemove}
            title="Remove"
            className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {isPreviewOpen && canPreview && (
        <HtmlPreview
          file={item.file}
          translations={item.translations}
          bilingual={bilingual}
          translating={status === 'translating' || status === 'queued'}
        />
      )}
    </div>
  )
}
