# Imp Translate Web

Companion website for the [Imp Translate](https://github.com/rxliuli/imp-translate) browser extension. Provides text, markdown and file translation with bilingual paragraph-level comparison.

## Features

- **Text translation** — line-by-line bilingual display with hover-to-compare
- **Markdown translation** — paragraph-level splitting, code blocks preserved untranslated
- **File translation** — `.epub`, `.html`, `.md`, `.txt`, `.srt`/`.ass` and `.xlsx`, re-exported in their original format, either bilingual or target-only
- Works standalone (Google Translate) or connects to the extension for configured providers

### Spreadsheets

Each translation is written into the cell that shows the source, below it when bilingual — so the workbook keeps its shape: formulas, number and date formats, borders, fills and merged cells are untouched, and every zip member except the three rewritten XML parts is copied byte for byte.

Columns are inferred per sheet, and columns holding enumerations, account names or IDs are skipped so they are not translated. Strings used by several cells are translated once. Cells with rich-text runs (mixed italics inside a sentence) and `.xlsm` macro workbooks are not supported.

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
```
