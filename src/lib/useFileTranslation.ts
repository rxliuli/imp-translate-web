// Shared upload/queue/progress/retry/download logic for the /files route.
// Translates every file's segments in fixed-size, fixed-budget request batches,
// running up to FILE_CONCURRENCY files at once (mirrors the queue previously
// duplicated in epub.lazy.tsx and html.lazy.tsx).

import { useEffect, useRef, useState } from 'react'
import { zipSync } from 'fflate'
import { rpc } from './rpc'
import {
  getHandler,
  toBytes,
  toBlob,
  type DocumentKind,
  type ParsedDocument,
} from './documents'
import { getOutputFilename } from './shared'
import { splitLongText } from './segments'
import { toErrorMessage } from './translationRun'

export type FileStatus =
  | 'queued'
  | 'parsing'
  | 'translating'
  | 'done'
  | 'error'
  | 'unsupported'

export interface FileItem {
  id: string
  file: File
  name: string
  kind: DocumentKind | 'unsupported'
  status: FileStatus
  progress: { done: number; total: number }
  error?: string
  doc?: ParsedDocument
  translations: (string | undefined)[]
  errors: boolean[]
}

export const BATCH_SIZE = 20
const FILE_CONCURRENCY = 5
// The extension/server accepts at most 20,000 chars of `texts` per request, so
// batches are bounded by both item count and total characters. A segment may be
// longer than this (html, epub and subtitle have no structural cut point inside
// a run), which is why `packBatches` splits it into pieces first.
export const MAX_CHARS_PER_REQUEST = 20000

/** One `translateBatch` request: `texts[k]` translates source segment `segments[k]`. */
export interface Batch {
  segments: number[]
  texts: string[]
}

export interface RequestPlan {
  /** Requests to send in order; none exceeds either request bound. */
  batches: Batch[]
  /** How many pieces each requested source segment was split into. */
  piecesPerSegment: Map<number, number>
}

/**
 * Partition `indices` into request batches that respect BATCH_SIZE items and
 * MAX_CHARS_PER_REQUEST characters, preserving input order. A segment longer
 * than MAX_CHARS_PER_SEGMENT is split into pieces first, because only the text
 * and markdown handlers cut long segments at a structural boundary — html, epub
 * and subtitle segments can be arbitrarily long. Every piece is at most
 * MAX_CHARS_PER_SEGMENT chars, which is under MAX_CHARS_PER_REQUEST, so a
 * one-item batch always fits and no batch can go over budget. `Batch.segments`
 * says which source segment each text belongs to, so the caller can rejoin the
 * pieces with `accumulateBatchResults`.
 */
export function packBatches(
  segments: readonly string[],
  indices: readonly number[],
): RequestPlan {
  const batches: Batch[] = []
  const piecesPerSegment = new Map<number, number>()
  let batch: Batch = { segments: [], texts: [] }
  let chars = 0
  for (const index of indices) {
    for (const text of splitLongText(segments[index] ?? '')) {
      if (
        batch.texts.length > 0 &&
        (batch.texts.length >= BATCH_SIZE || chars + text.length > MAX_CHARS_PER_REQUEST)
      ) {
        batches.push(batch)
        batch = { segments: [], texts: [] }
        chars = 0
      }
      batch.segments.push(index)
      batch.texts.push(text)
      chars += text.length
      piecesPerSegment.set(index, (piecesPerSegment.get(index) ?? 0) + 1)
    }
  }
  if (batch.texts.length > 0) batches.push(batch)
  return { batches, piecesPerSegment }
}

/**
 * Fold one batch's results into the pieces translated so far, returning the
 * source segments whose last piece just arrived (keyed by segment index, in
 * batch order). `pending` is mutated: a segment's collected pieces are dropped
 * once its translation is complete, so a caller never publishes a segment after
 * only part of its pieces came back.
 */
export function accumulateBatchResults(
  pending: Map<number, string[]>,
  piecesPerSegment: ReadonlyMap<number, number>,
  batch: Batch,
  results: readonly string[],
): Map<number, string> {
  const settled = new Map<number, string>()
  batch.segments.forEach((segment, i) => {
    const pieces = pending.get(segment) ?? []
    // A short response keeps the text we sent for the missing piece, mirroring
    // how the queue has always fallen back to the source.
    pieces.push(results[i] ?? batch.texts[i])
    if (pieces.length === piecesPerSegment.get(segment)) {
      settled.set(segment, pieces.join(''))
      pending.delete(segment)
    } else {
      pending.set(segment, pieces)
    }
  })
  return settled
}

function computeStatus(f: FileItem): FileStatus {
  // 'parsing', 'unsupported' and 'queued' aren't derivable from
  // errors/translations alone, so they pass through until something moves
  // the file into (or past) translation.
  if (f.status === 'parsing' || f.status === 'unsupported' || f.status === 'queued') {
    return f.status
  }
  // A file-level error (e.g. parse failure) must win even though
  // `errors`/`progress.total` are both still empty at that point — otherwise
  // it falls through to the `progress.total === 0` branch below and reads as
  // "done" with nothing to show for it.
  if (f.error) return 'error'
  if (f.errors.some(Boolean)) return 'error'
  if (f.progress.total === 0 || f.translations.every((t) => t !== undefined)) {
    return 'done'
  }
  return 'translating'
}

export function useFileTranslation(targetLang: string, bilingual: boolean, extensionInstalled: boolean) {
  const [files, setFiles] = useState<FileItem[]>([])
  const batchIdRef = useRef(0)

  // Keep "latest value" refs for use inside async callbacks (queued tasks,
  // rpc responses) without re-running those callbacks on every change. These
  // are updated in effects, not during render, per the rules of React.
  const targetLangRef = useRef(targetLang)
  useEffect(() => {
    targetLangRef.current = targetLang
  }, [targetLang])
  const extensionInstalledRef = useRef(extensionInstalled)
  useEffect(() => {
    extensionInstalledRef.current = extensionInstalled
  }, [extensionInstalled])
  const filesRef = useRef(files)
  useEffect(() => {
    filesRef.current = files
  }, [files])

  const queueRef = useRef<Array<() => Promise<void>>>([])
  const runningRef = useRef(0)

  // Guards retryFailed() against a fast double-click enqueuing the same
  // failed segments twice: filesRef is only synced after render via an
  // effect, so two synchronous calls in a row would otherwise both see the
  // same (stale) failed indices and re-enqueue them.
  const retryingRef = useRef(false)
  const [isRetrying, setIsRetrying] = useState(false)

  function drain() {
    // Every queued task translates one file through packBatches(), so no
    // matter how many of the FILE_CONCURRENCY slots run at once, each request
    // stays within the extension's item/char budget.
    while (runningRef.current < FILE_CONCURRENCY && queueRef.current.length > 0) {
      const task = queueRef.current.shift()!
      runningRef.current++
      task().finally(() => {
        runningRef.current--
        drain()
      })
    }
  }

  function enqueue(task: () => Promise<void>) {
    queueRef.current.push(task)
    drain()
  }

  function updateFile(id: string, updater: (f: FileItem) => FileItem) {
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f
        const next = updater(f)
        return { ...next, status: computeStatus(next) }
      }),
    )
  }

  async function translateIndices(
    id: string,
    segments: string[],
    indices: number[],
    lang: string,
  ) {
    const { batches, piecesPerSegment } = packBatches(segments, indices)
    // The pieces of one segment can land in different batches, so the translated
    // pieces wait here until the last one arrives: `translations[i]` must never
    // hold a truncated translation (nor count as done in `progress`).
    const pending = new Map<number, string[]>()

    for (const batch of batches) {
      try {
        const results = await rpc.sendMessage('translateBatch', {
          texts: batch.texts,
          to: lang,
        })
        const settled = accumulateBatchResults(pending, piecesPerSegment, batch, results)
        updateFile(id, (f) => {
          const translations = [...f.translations]
          const errors = [...f.errors]
          settled.forEach((translation, segment) => {
            translations[segment] = translation
            errors[segment] = false
          })
          const done = translations.filter((t) => t !== undefined).length
          return { ...f, translations, errors, progress: { ...f.progress, done } }
        })
      } catch (err) {
        const message = toErrorMessage(err)
        // Drop the pieces this batch carried so a retry re-sends whole segments.
        for (const segment of batch.segments) pending.delete(segment)
        updateFile(id, (f) => {
          const errors = [...f.errors]
          batch.segments.forEach((segment) => {
            errors[segment] = true
          })
          return { ...f, errors, error: message }
        })
      }
    }
  }

  function addFiles(fileList: FileList | File[]) {
    const batchId = ++batchIdRef.current
    const arr = Array.from(fileList)
    arr.forEach((file, i) => {
      const id = `${batchId}-${i}-${file.name}`
      const handler = getHandler(file)

      if (!handler) {
        setFiles((prev) => [
          ...prev,
          {
            id,
            file,
            name: file.name,
            kind: 'unsupported',
            status: 'unsupported',
            progress: { done: 0, total: 0 },
            error: 'Unsupported file type',
            translations: [],
            errors: [],
          },
        ])
        return
      }

      setFiles((prev) => [
        ...prev,
        {
          id,
          file,
          name: file.name,
          kind: handler.kind,
          status: 'parsing',
          progress: { done: 0, total: 0 },
          translations: [],
          errors: [],
        },
      ])

      handler
        .parse(file)
        .then((doc) => {
          const hasSegments = doc.segments.length > 0
          const willQueue = hasSegments && extensionInstalledRef.current
          updateFile(id, (f) => ({
            ...f,
            doc,
            // No segments: nothing to translate, it's already done. Queued:
            // waiting its turn behind FILE_CONCURRENCY other files. Neither
            // extension nor segments: mirrors the old pages, which left such
            // files stuck mid-progress until the extension appears.
            status: !hasSegments ? 'done' : willQueue ? 'queued' : 'translating',
            progress: { done: 0, total: doc.segments.length },
            translations: new Array(doc.segments.length).fill(undefined),
            errors: new Array(doc.segments.length).fill(false),
          }))
          if (!willQueue) return
          enqueue(() => {
            updateFile(id, (f) => ({ ...f, status: 'translating' }))
            return translateIndices(
              id,
              doc.segments,
              doc.segments.map((_, idx) => idx),
              targetLangRef.current,
            )
          })
        })
        .catch((err) => {
          updateFile(id, (f) => ({
            ...f,
            status: 'error',
            error: err instanceof Error ? err.message : 'Failed to parse file',
          }))
        })
    })
  }

  function retryFailed() {
    if (retryingRef.current) return

    const targets = filesRef.current
      .map((f) => {
        if (!f.doc) return undefined
        const failedIndices = f.errors
          .map((e, i) => (e ? i : -1))
          .filter((i) => i !== -1)
        return failedIndices.length > 0 ? { file: f, failedIndices } : undefined
      })
      .filter((t): t is { file: FileItem; failedIndices: number[] } => t !== undefined)
    if (targets.length === 0) return

    retryingRef.current = true
    setIsRetrying(true)
    let pending = targets.length
    function settleOne() {
      pending--
      if (pending === 0) {
        retryingRef.current = false
        setIsRetrying(false)
      }
    }

    targets.forEach(({ file: f, failedIndices }) => {
      updateFile(f.id, (ff) => {
        const errors = [...ff.errors]
        failedIndices.forEach((i) => (errors[i] = false))
        return { ...ff, errors, error: undefined }
      })

      enqueue(() =>
        translateIndices(f.id, f.doc!.segments, failedIndices, targetLangRef.current).finally(
          settleOne,
        ),
      )
    })
  }

  function remove(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  function clear() {
    setFiles([])
  }

  function buildOutput(f: FileItem): { data: Blob | Uint8Array | string; filename: string } | undefined {
    if (!f.doc) return undefined
    const translations = f.translations.map((t, i) => t ?? f.doc!.segments[i])
    const data = f.doc.rebuild(translations, bilingual)
    const filename = getOutputFilename(f.name, targetLang, bilingual)
    return { data, filename }
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function download(id: string) {
    const f = filesRef.current.find((x) => x.id === id)
    if (!f?.doc) return
    const out = buildOutput(f)
    if (!out) return
    triggerDownload(toBlob(out.data, f.doc.mimeType), out.filename)
  }

  function downloadAll() {
    const doneFiles = filesRef.current.filter((f) => f.status === 'done' && f.doc)
    if (doneFiles.length === 0) return

    if (doneFiles.length === 1) {
      download(doneFiles[0].id)
      return
    }

    const zipData: Record<string, Uint8Array> = {}
    for (const f of doneFiles) {
      const out = buildOutput(f)
      if (!out) continue
      zipData[out.filename] = toBytes(out.data)
    }
    const zipped = zipSync(zipData)
    const blob = new Blob([zipped], { type: 'application/zip' })
    triggerDownload(blob, `files.${targetLang}.zip`)
  }

  return { files, addFiles, retryFailed, isRetrying, remove, clear, download, downloadAll }
}
