# Locate and visually verify

Use the JSON manifest saved by `ensure`/`wait`, or the stored attachment bundle
directory, as `--bundle`. A manifest preserves source Zotero identity alongside
the file paths; a directory alone has only provenance's input SHA-256.

```bash
uv run --no-project python <skill-dir>/scripts/mineru.py --out candidates.json locate --bundle result.json --query 'E = mc^2'
uv run --no-project python <skill-dir>/scripts/mineru.py --out candidates.json locate --bundle result.json --line 120 --context 2
```

Clues can be text, LaTeX, a caption or an image path. The helper normalizes
formatting and matches block content. A Markdown line additionally includes
neighboring nonempty lines, which can identify surrounding blocks when the
formula itself was parsed incorrectly. Results explain which clue matched;
they do not provide calibrated confidence scores or a character source map.

Inspect all candidates. Repeated text can produce multiple matches. Prefer
matching captions and surrounding context, or ask when the intended region is
unclear. Inline equations return their containing paragraph bbox. Tables match
their body/caption within the enclosing table block. A continued table spans
multiple blocks: the helper follows `continues_prev` across adjacent pages and
returns regions with the same `regionGroup`. Render each region in that group.
Independent groups represent distinct candidates; inspect context to select
the intended one. Several regions of one table are not a matching ambiguity.

## Coordinates

This plugin accepts docvortex middle schema 2.0: `pages[].blocks[]`, block
`index`, optional nested content, and normalized `[x0,y0,x1,y1]` bbox in 0–1.
The coordinates describe the displayed, rotation-applied page, with origin at
the upper left. The helper crops the fully rendered page image.

`page_idx` is the original PDF's zero-based page index, including subset parses:
MinerU retains the original page index mapping when extracting requested pages.
Use it directly; adding the page-range start would map to the wrong page. Legacy
MinerU `pdf_info` or content-list 0–1000 bboxes are different formats and need a
separate adapter. Out-of-range coordinates are errors, not silently clamped.

## Render

PyMuPDF is needed only for this step. The other helper commands use Python's
standard library. Select a zero-based `--candidate` index whenever there are
multiple regions, including several regions of one unambiguous continued table.
Run render for each region index in the selected `regionGroup`; without an index
the helper returns `candidate_required`.

```bash
uv run --no-project --with pymupdf python <skill-dir>/scripts/mineru.py render --bundle result.json --pdf SOURCE-PDF-PATH --candidates candidates.json --candidate 0 --directory verification
```

Obtain `SOURCE-PDF-PATH` from `find`/task `source.path`. The helper verifies its
SHA-256 against provenance and renders those same checked bytes. A mismatch
means the source changed: return to `ensure` and locate again. It also checks
that the candidate's block index and bbox belong to this bundle.

Output includes a full page PNG, region PNG and evidence JSON with PDF page
number, PDF page label when present, rotation, block path, bbox and source hash.
All still have `verified: false`: image generation alone does not establish
content agreement.

View the region image and expand to the full page when context is needed.
For formulas compare symbols, subscripts/superscripts, signs and grouping. For
tables compare headings, row/column alignment, values, units and footnotes.
Report agreement, specific discrepancies, or unresolved visual ambiguity.
Completion: viewed source evidence supporting each reported conclusion, with
the PDF identity/page/region traceable. Corrections go into a separate working
draft while the original parse bundle remains intact.
