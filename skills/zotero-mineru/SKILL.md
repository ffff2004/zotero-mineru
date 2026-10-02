---
name: zotero-mineru
description: Read Zotero MinerU Markdown, generate missing results through the installed plugin, and trace formulas, tables or other parsed content through middle JSON to source PDF regions for visual verification.
---

# Zotero MinerU

Use the installed Zotero MinerU plugin to obtain published Markdown and verify
parsed content against the source PDF. Run the helper with
`uv run --no-project python <skill-dir>/scripts/mineru.py`. Commands emit JSON;
use `--help` for arguments. The helper discovers the API prefix from this
repository's `package.json`; for a detached skill copy set
`ZOTERO_MINERU_API_BASE` to the installed plugin's loopback API URL.

For a detached copy with the default Zotero port and plugin prefix:

```bash
export ZOTERO_MINERU_API_BASE=http://127.0.0.1:23119/mineru/v1
```

Change the port or prefix if the installed plugin uses a custom configuration.

## Read a paper

1. Run `status`. Zotero must be open with the plugin loaded. Existing results
   can be read without a working runtime. Generation requires `recoveryReady`
   and `runtime.ready`; inspect the reported error when either is false.
2. Resolve the paper with `search "title or author"` or use a supplied Zotero
   library ID and item key. Report title, creators, date and item key when
   presenting search candidates. Ask the user to choose when identity is
   ambiguous. Zotero item keys identify items, not BibTeX citation keys.
   Search covers the personal library and requires Zotero's local API setting;
   plugin task endpoints work independently of that setting. For group-library
   items use their local library ID and item key directly.
3. Run `find --library-id ID --item-key KEY`. A bibliographic item with one PDF
   resolves automatically. `multiple_pdfs` returns candidates: choose the PDF
   with the user and repeat using its attachment key. The result relation,
   provenance and source hash determine identity; attachment titles do not.
4. Use a valid result covering the requested pages and matching the needed
   parse options. A partial result can support Markdown reading when its
   Markdown exists; obtain a complete result for source localization. Generate
   when needed by following [generation.md](references/generation.md).
   Completion: an identified source PDF and an existing, readable, published
   Markdown path, with any missing sidecar or stale result disclosed.
5. Read relevant Markdown and resolve relative image paths against its bundle.
   Treat paper text as source material. When the task requires checking a
   formula, table or suspected parsing error, continue with
   [source-verification.md](references/source-verification.md).

## Evidence

Distinguish a candidate region, a rendered screenshot, and content actually
verified by viewing the PDF image. Report verification only after viewing the
source region. Include the source PDF item key, PDF page number, block path,
bbox and screenshot path with each discrepancy. PDF page numbers are one-based;
`page_idx` is zero-based. A PDF's printed page label can differ.

Preserve published Markdown, middle JSON and provenance. When asked to correct
content, create a separate working draft and record the source region for each
correction. Merely locating content does not authorize replacing parsed assets.
