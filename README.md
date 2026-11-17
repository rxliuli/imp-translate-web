# Imp Translate Web

Companion website for the [Imp Translate](https://github.com/rxliuli/imp-translate) browser extension. Provides text, markdown and file translation with bilingual paragraph-level comparison.

## Features

- **Text translation** — line-by-line bilingual display with hover-to-compare
- **Markdown translation** — paragraph-level splitting, code blocks preserved untranslated
- **File translation** — `.epub`, `.html`, `.md`, `.txt`, `.srt`/`.ass`, `.xlsx`, `.docx` and `.csv`, re-exported in their original format, either bilingual or target-only
- Works standalone (Google Translate) or connects to the extension for configured providers

### Spreadsheets

Each translation is written into the cell that shows the source, below it when bilingual — so the workbook keeps its shape: formulas, number and date formats, borders, fills and merged cells are untouched, and every zip member except the three rewritten XML parts is copied byte for byte.

Columns are inferred per sheet, and columns holding enumerations, account names or IDs are skipped so they are not translated. Strings used by several cells are translated once. Cells with rich-text runs (mixed italics inside a sentence) and `.xlsm` macro workbooks are not supported.

### CSV files

Each translation is written into the cell it came from, below the source inside the same cell when bilingual — a newline inside a cell is what a CSV file expects, and the serialiser quotes the cell so the row still holds it.

Columns are inferred from the values they hold, and columns holding enumerations, account names or IDs are skipped so they are not translated. Blank cells and cells holding only a URL or an email address are skipped as well; the first row is a row like any other, so its cells are translated too (and take part in the inference, being where a column's longest value often sits).

The output encoding is always UTF-8, the only encoding a browser can write. A source that was UTF-8 with a BOM, or not UTF-8 at all (a GBK export from Excel on a Chinese Windows is decoded as GB18030), is written back with a UTF-8 BOM, so Excel opens it without mojibake.

Re-serialising normalises the quoting style — a `"abc"` that needed no quotes loses them — which is semantically identical but a different file, so unlike the spreadsheet and Word handlers byte-for-byte fidelity of the untouched parts is not promised.

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
