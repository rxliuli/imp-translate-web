import { useState, useEffect } from 'react'
import { Check, Copy } from 'lucide-react'
import { LANGUAGE_MAP } from '@/lib/languages'

export const EXTENSION_LINK =
  'https://chromewebstore.google.com/detail/imp-translate/nmbcckfgobecechfdamananmfnnjbbbd'
export const DISCORD_LINK = 'https://discord.gg/gFhKUthc88'
export const STORAGE_KEY = 'imp-translate-target-lang'

export function getDefaultTargetLang(): string {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && stored in LANGUAGE_MAP) return stored
  const browserLang = navigator.language.split('-')[0]
  if (browserLang !== 'zh' && browserLang in LANGUAGE_MAP) return browserLang
  return 'en'
}

export function useExtensionInstalled() {
  const [installed, setInstalled] = useState(
    () => document.documentElement.dataset.impTranslateInstalled === 'true',
  )
  useEffect(() => {
    if (installed) return
    const observer = new MutationObserver(() => {
      if (document.documentElement.dataset.impTranslateInstalled === 'true') {
        setInstalled(true)
        observer.disconnect()
      }
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-imp-translate-installed'],
    })
    return () => observer.disconnect()
  }, [installed])
  return installed
}

export interface Segment {
  source: string
  translated: string
  status: 'pending' | 'done' | 'error'
}

// Translate a source filename into a translated output filename, preserving
// an existing language suffix: `book.zh.html` -> `book.en.html`.
export function getOutputFilename(
  originalName: string,
  targetLang: string,
  bilingual: boolean,
): string {
  const suffix = bilingual ? `.${targetLang}.bilingual` : `.${targetLang}`
  const lastDot = originalName.lastIndexOf('.')
  if (lastDot === -1) return `${originalName}${suffix}`
  const ext = originalName.slice(lastDot)
  const base = originalName.slice(0, lastDot)
  const secondDot = base.lastIndexOf('.')
  if (secondDot !== -1) {
    const langSuffix = base.slice(secondDot + 1)
    if (langSuffix in LANGUAGE_MAP) {
      return base.slice(0, secondDot) + suffix + ext
    }
  }
  return base + suffix + ext
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 cursor-pointer rounded-md bg-background/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground group-hover/target:opacity-100"
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </button>
  )
}
