# Local task API v1

The plugin registers endpoints on Zotero's existing loopback HTTP server for
its loaded lifetime. The prefix is `/<package.config.addonRef>/v1`, currently
`/mineru/v1`. The usual port is 23119; integration tests use 23124. Zotero must
be running with the plugin loaded. These endpoints do not require Zotero's
separate local-library-API preference. General library search through `/api/`
does require that preference.

Requests and responses use JSON. Clients supply Zotero `libraryID` and
`itemKey`, never source filesystem paths or arbitrary CLI arguments. Browser
Origin requests are rejected, including requests with connector headers.

## Readiness and results

`GET /status` returns `protocolVersion`, `plugin`, `userLibraryID`,
`recoveryReady`, `runtime` and `busy`. Reading an existing bundle does not
require a compatible runtime. Creating a result requires successful publication
recovery and a compatible runtime and configuration.

`GET /results?libraryID=1&itemKey=ABCDEFGH` accepts a bibliographic item or exact
PDF attachment. A parent with multiple PDFs returns `multiple_pdfs` and
`error.candidates`; each candidate has library ID, item key, title and filename.
The client obtains a user selection and repeats the request with that PDF key.

A successful response has `source` and `results`. The source contains library ID,
item key, local path and SHA-256; path/hash are null if its file is unavailable.
Results are linked to that exact source with the plugin's note marker and
`dc:relation`, and have:

- `libraryID`, `itemKey`, `title`, `dateAdded`;
- `availability`: `valid`, `stale`, `partial` or `damaged`;
- `sourceSha256`, recorded `options`, `runtime`, `configurationSha256` and
  `environmentSha256`;
- `paths.markdown`, `paths.middle`, `paths.provenance` (null if unavailable);
- `issues`: missing or invalid sidecars/assets, unavailable source and other
  reasons limiting use.

`valid` means the inspected bundle is structurally usable and its recorded PDF
hash matches the current source. It does not promise accurate OCR or matching
options for every reading task. `stale` means the source bytes changed. A
`partial` result retains readable Markdown but lacks usable sidecars, assets or
source verification. `damaged` lacks usable Markdown. Task reuse additionally
checks actual frozen configuration bytes, the configuration's environment
inputs, runtime release/profile and all requested parse options. The child uses
a frozen process environment; its fingerprint includes `MINERU_*`, `HOME` and
variables referenced through `${ENV}` in YAML, without recording their values
in the result. Older provenance without these fields remains readable
but is not eligible for automatic task reuse.

## Submit, query and cancel

`POST /tasks` ensures a published result exists:

```json
{
  "requestID": "operation-uuid",
  "source": { "libraryID": 1, "itemKey": "PDFKEY01" },
  "options": {},
  "force": false
}
```

The source must be the selected PDF attachment. Options accept `tier`,
`ocr_mode`, `image_analysis` and `page_range`; omitted values inherit the plugin
preferences. The configured parsing mode and remote services are used directly.
`force: true` requests another generation and retains existing attachments.

Retain `requestID` when retrying the same submission. Reusing that ID with
different inputs returns `request_id_conflict`. New tasks return HTTP 201; task
or result reuse can return 200. The task ID identifies asynchronous work, not a
published attachment.

`GET /tasks?taskID=...` returns a task record:

- `taskID`, `source`, `createdAt`, `updatedAt`;
- `state`: `running`, `cancel_requested`, `succeeded`, `failed`, `cancelled`;
- `phase`: preparation, parsing, validation, saving or terminal phase;
- `disposition`: `created`, `reused_task`, `reused_result`;
- `result`: the published result record after success;
- `error`: machine-readable code, message and optional failure category.

One task owns the execution slot through preparation, parsing, publication and
cleanup. A different request returns `task_busy` with the active task ID.
Eligible requests can join work after its snapshot is established. No queue or
percentage progress is exposed.

`POST /tasks/cancel` with `{ "taskID": "..." }` requests cancellation. Poll
until a terminal state: requesting cancellation is not proof that the child or
rollback has stopped. A committed publication remains successful. Cleanup or
recovery failure is a failure, not cancellation, and retained journals block
further generation until recovery succeeds.

Task records are in memory and bounded. After Zotero/plugin restart or record
eviction, `task_not_found` means to query published results before submitting
again. Request IDs are idempotent within the retained session records, not
across restarts. CLI logs stay in task-owned files rather than HTTP responses.

## Errors

HTTP errors have `{ "error": { "code": "...", "message": "..." } }` with
additional details such as PDF candidates or the busy task ID. Malformed input
uses 400, permission/browser-origin denial 403, missing items/tasks 404,
ambiguity/busy/request conflict 409, startup/recovery prerequisites 503.

Background parse/validation/publication failures are terminal task records;
querying such a record still returns HTTP 200. Follow its `state` and `error`,
not just the HTTP status. Failure categories distinguish input, environment,
process, validation, persistence and recovery. Resolve the reported cause
before retrying; waiting timeouts never cancel or resubmit a task automatically.
