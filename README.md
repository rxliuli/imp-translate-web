# Imp Translate Web

Companion website for the [Imp Translate](https://github.com/rxliuli/imp-translate) browser extension. Provides text, markdown and file translation with bilingual paragraph-level comparison.

## Features

- **Text translation** — line-by-line bilingual display with hover-to-compare
- **Markdown translation** — paragraph-level splitting, code blocks preserved untranslated
- **File translation** — `.epub`, `.html`, `.md`, `.txt`, `.srt`/`.ass`, `.xlsx` and `.docx`, re-exported in their original format, either bilingual or target-only
- Works standalone (Google Translate) or connects to the extension for configured providers

### Spreadsheets

Each translation is written into the cell that shows the source, below it when bilingual — so the workbook keeps its shape: formulas, number and date formats, borders, fills and merged cells are untouched, and every zip member except the three rewritten XML parts is copied byte for byte.

Columns are inferred per sheet, and columns holding enumerations, account names or IDs are skipped so they are not translated. Strings used by several cells are translated once. Cells with rich-text runs (mixed italics inside a sentence) and `.xlsm` macro workbooks are not supported.

### Word documents

Each translation is written back into the paragraph it came from; when bilingual it sits below the source inside the same paragraph, separated by a line break rather than a new paragraph, so list numbering and paragraph styles stay as they were. Everything except the paragraphs' text is copied byte for byte — table markup, images, headers, styles and comments included; a table cell holds paragraphs of its own, so the text inside cells is translated like any other.

Word splits a sentence across several runs (and inserts markers of its own) for reasons that carry no meaning, so the runs of a paragraph are merged before translation. A bold or italic word inside a translated paragraph can therefore lose its formatting once the paragraph is rewritten. An in-paragraph line break starts a new segment on its own line. Paragraphs holding field codes, tracked deletions, equations or embedded objects are skipped, and headers, footers and footnotes are not translated. `.docm` macro documents are not supported.

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
```
