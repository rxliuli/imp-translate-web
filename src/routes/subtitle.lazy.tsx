import { createLazyFileRoute } from '@tanstack/react-router'
import { useState, useRef, useCallback } from 'react'
import { Loader2, RotateCw, Upload, Download, X } from 'lucide-react'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { LANGUAGES, LANGUAGE_MAP } from '@/lib/languages'
import { rpc } from '@/lib/rpc'
import { parseSubtitle, type ParsedSubtitle } from '@/lib/subtitle'
import {
  EXTENSION_LINK,
  STORAGE_KEY,
  getDefaultTargetLang,
  useExtensionInstalled,
} from '@/lib/shared'
import { buttonVariants } from '@/components/ui/button'
import { zipSync, strToU8 } from 'fflate'

export const Route = createLazyFileRoute('/subtitle')({
  component: SubtitlePage,
})

interface SubtitleFileState {
  id: string
  name: string
  parsed: ParsedSubtitle
  translations: (string | null)[]
  errors: boolean[]
}

function getOutputFilename(
  originalName: string,
  targetLang: string,
): string {
  const lastDot = originalName.lastIndexOf('.')
  if (lastDot === -1) return `${originalName}.${targetLang}`
  const ext = originalName.slice(lastDot)
  const base = originalName.slice(0, lastDot)
  const secondDot = base.lastIndexOf('.')
  if (secondDot !== -1) {
    const langSuffix = base.slice(secondDot + 1)
    if (langSuffix in LANGUAGE_MAP) {
      return base.slice(0, secondDot) + '.' + targetLang + ext
    }
  }
  return base + '.' + targetLang + ext
}

function downloadBlob(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function SubtitlePage() {
  const extensionInstalled = useExtensionInstalled()
  const [targetLang, setTargetLang] = useState(getDefaultTargetLang)
  const [files, setFiles] = useState<SubtitleFileState[]>([])
  const translateIdRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fileQueueRef = useRef<Array<() => Promise<void>>>([])
  const fileRunningRef = useRef(0)
  const FILE_CONCURRENCY = 5

  function drainFileQueue() {
    while (
      fileRunningRef.current < FILE_CONCURRENCY &&
      fileQueueRef.current.length > 0
    ) {
      const task = fileQueueRef.current.shift()!
      fileRunningRef.current++
      task().finally(() => {
        fileRunningRef.current--
        drainFileQueue()
      })
    }
  }

  function enqueueFile(task: () => Promise<void>) {
    fileQueueRef.current.push(task)
    drainFileQueue()
  }

  function addFiles(fileList: FileList) {
    const id = ++translateIdRef.current
    const newFiles = Array.from(fileList).filter((f) =>
      /\.(srt|ass|ssa)$/i.test(f.name),
    )

    for (const file of newFiles) {
      const fileId = `${id}-${file.name}`
      const reader = new FileReader()
      reader.onload = () => {
        const content = reader.result as string
        const parsed = parseSubtitle(content, file.name)
        const state: SubtitleFileState = {
          id: fileId,
          name: file.name,
          parsed,
          translations: new Array(parsed.segments.length).fill(null),
          errors: new Array(parsed.segments.length).fill(false),
        }
        setFiles((prev) => [...prev, state])
        if (extensionInstalled) {
          enqueueFile(() => translateFile(fileId, parsed, targetLang))
        }
      }
      reader.readAsText(file)
    }
  }

  async function translateFile(
    fileId: string,
    parsed: ParsedSubtitle,
    lang: string,
  ): Promise<void> {
    const BATCH_SIZE = 20
    for (let start = 0; start < parsed.segments.length; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE, parsed.segments.length)
      const batch = parsed.segments.slice(start, end)
      try {
        const results = await rpc.sendMessage('translateBatch', {
          texts: batch,
          to: lang,
        })
        setFiles((prev) =>
          prev.map((f) => {
            if (f.id !== fileId) return f
            const translations = [...f.translations]
            for (let j = 0; j < results.length; j++) {
              translations[start + j] = results[j] ?? batch[j]
            }
            return { ...f, translations }
          }),
        )
      } catch {
        setFiles((prev) =>
          prev.map((f) => {
            if (f.id !== fileId) return f
            const errors = [...f.errors]
            for (let j = start; j < end; j++) {
              errors[j] = true
            }
            return { ...f, errors }
          }),
        )
      }
    }
  }

  function retryFile(fileState: SubtitleFileState) {
    const failedIndices = fileState.errors
      .map((e, i) => (e ? i : -1))
      .filter((i) => i !== -1)
    if (failedIndices.length === 0) return

    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== fileState.id) return f
        const errors = [...f.errors]
        failedIndices.forEach((i) => (errors[i] = false))
        return { ...f, errors }
      }),
    )

    enqueueFile(async () => {
      const BATCH_SIZE = 20
      for (let b = 0; b < failedIndices.length; b += BATCH_SIZE) {
        const batchIndices = failedIndices.slice(b, b + BATCH_SIZE)
        const batchTexts = batchIndices.map(
          (i) => fileState.parsed.segments[i],
        )
        try {
          const results = await rpc.sendMessage('translateBatch', {
            texts: batchTexts,
            to: targetLang,
          })
          setFiles((prev) =>
            prev.map((f) => {
              if (f.id !== fileState.id) return f
              const translations = [...f.translations]
              batchIndices.forEach((i, j) => {
                translations[i] = results[j] ?? batchTexts[j]
              })
              return { ...f, translations }
            }),
          )
        } catch {
          setFiles((prev) =>
            prev.map((f) => {
              if (f.id !== fileState.id) return f
              const errors = [...f.errors]
              batchIndices.forEach((i) => (errors[i] = true))
              return { ...f, errors }
            }),
          )
        }
      }
    })
  }

  function removeFile(fileId: string) {
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
  }

  function downloadFile(fileState: SubtitleFileState) {
    const translations = fileState.translations.map(
      (t, i) => t ?? fileState.parsed.segments[i],
    )
    const content = fileState.parsed.rebuild(translations)
    downloadBlob(content, getOutputFilename(fileState.name, targetLang))
  }

  function downloadAll() {
    const doneFiles = files.filter((f) => getFileStatus(f) === 'done')
    if (doneFiles.length === 0) return

    const zipData: Record<string, Uint8Array> = {}
    for (const f of doneFiles) {
      const translations = f.translations.map(
        (t, i) => t ?? f.parsed.segments[i],
      )
      const content = f.parsed.rebuild(translations)
      const name = getOutputFilename(f.name, targetLang)
      zipData[name] = strToU8(content)
    }
    const zipped = zipSync(zipData)
    const blob = new Blob([zipped], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `subtitles.${targetLang}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleTargetLangChange(value: string) {
    setTargetLang(value)
    localStorage.setItem(STORAGE_KEY, value)
  }

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files)
      }
    },
    [extensionInstalled, targetLang],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

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

      <div
        className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-muted-foreground/25 p-8 transition-colors hover:border-muted-foreground/50"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="size-8 text-muted-foreground" />
        <div className="text-center">
          <p className="text-sm font-medium">
            Drop subtitle files here or click to browse
          </p>
          <p className="text-xs text-muted-foreground">
            Supports .srt, .ass, .ssa
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".srt,.ass,.ssa"
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
              file={f}
              targetLang={targetLang}
              onDownload={() => downloadFile(f)}
              onRetry={() => retryFile(f)}
              onRemove={() => removeFile(f.id)}
            />
          ))}

          {files.some((f) => getFileStatus(f) === 'done') && (
            <button
              onClick={downloadAll}
              className={buttonVariants({ variant: 'default' }) + ' self-center'}
            >
              <Download className="size-4" />
              Download All
            </button>
          )}
        </div>
      )}
    </main>
  )
}

function getFileStatus(
  f: SubtitleFileState,
): 'translating' | 'done' | 'error' {
  if (f.errors.some(Boolean)) return 'error'
  if (f.translations.every((t) => t !== null)) return 'done'
  return 'translating'
}

function FileRow({
  file,
  targetLang,
  onDownload,
  onRetry,
  onRemove,
}: {
  file: SubtitleFileState
  targetLang: string
  onDownload: () => void
  onRetry: () => void
  onRemove: () => void
}) {
  const status = getFileStatus(file)
  const total = file.translations.length
  const done = file.translations.filter((t) => t !== null).length
  const errorCount = file.errors.filter(Boolean).length
  const progress = total > 0 ? (done / total) * 100 : 0

  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{file.name}</span>
          <span className="text-xs text-muted-foreground">
            &rarr; {getOutputFilename(file.name, targetLang)}
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
            onClick={onRetry}
            className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-foreground"
          >
            <RotateCw className="size-4" />
          </button>
        )}
        {status === 'done' && (
          <button
            onClick={onDownload}
            className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-foreground"
          >
            <Download className="size-4" />
          </button>
        )}
        <button
          onClick={onRemove}
          className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
