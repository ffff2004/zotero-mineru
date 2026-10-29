# Local task API v2

The plugin registers endpoints on Zotero's loopback server for its loaded
lifetime. The prefix comes from `package.json` config: `/<addonRef>/v2`, currently
`/mineru/v2`. The usual port is 23119 (integration tests use 23124). Zotero must
be running with the plugin loaded. The separate local-library-API preference is
not required for these endpoints; library search through `/api/` does require it.

Requests and responses use JSON. Clients supply Zotero `libraryID` and `itemKey`,
not filesystem paths or CLI arguments. Browser Origin requests are rejected even
with connector headers. Legacy `/<addonRef>/v1/status` and `/results` remain
readable; **all v1 task operations return 409 `upgrade_required`**, including
queries. Upgrade clients before submitting; queued work is not completion.

## Readiness and results

`GET /status` returns `protocolVersion: 2`, `plugin`, `userLibraryID`,
`recoveryReady`, `storageReady`, `runtime`, `busy` and `paused`. Reading a bundle
needs no compatible runtime. Admission requires healthy queue storage and
publication recovery, but runtime availability is checked at execution.

`GET /results?libraryID=1&itemKey=ABCDEFGH` accepts a parent or exact PDF. A parent
with multiple PDFs returns `multiple_pdfs` and `error.candidates` (library ID,
item key, title, filename). Clients obtain a selection and use that PDF key;
the plugin never chooses among ambiguous PDFs.

The response contains `source` and `results`. The source has library ID, item
key, local path and SHA-256 (path/hash may be null). Results are associated with
that exact PDF by the plugin note marker and `dc:relation`, and contain:

- `libraryID`, `itemKey`, `title`, `dateAdded`;
- `availability`: `valid`, `stale`, `partial` or `damaged`;
- `sourceSha256`, `options`, `runtime`, `configurationSha256`, `environmentSha256`;
- `paths.markdown`, `paths.middle`, `paths.provenance` (null if unavailable);
- `issues`: usability limitations.

`valid` means a structurally usable bundle matching the current PDF hash, not
accurate OCR or a match for every reading task. `stale` means changed PDF bytes;
`partial` retains Markdown but lacks usable sidecars/assets/source verification;
`damaged` lacks usable Markdown. Automatic execution reuse additionally requires
matching actual frozen configuration bytes, environment fingerprint, runtime
release/profile and all parse options. Environment fingerprints cover `MINERU_*`,
`HOME` and variables referenced as `${ENV}` in YAML, without recording values.
Older provenance remains readable but is not automatically reusable.

## Tasks and late configuration binding

`POST /tasks` admits an exact PDF request:

```json
{
  "requestID": "operation-uuid",
  "source": { "libraryID": 1, "itemKey": "PDFKEY01" },
  "options": {},
  "force": false
}
```

Options accept `tier`, `ocr_mode`, `image_analysis`, `page_range`. Admission
stores only explicit options and force. **At dequeue**, the plugin reads latest
preferences, runtime descriptor path and custom configuration path once;
explicit overrides win. Preparation snapshots PDF/configuration bytes and the
child environment. Subsequent edits cannot change that execution. `force: true`
creates a new generation without deleting old attachments.

HTTP 201 returns a newly created task (initially `queued`). Replay returns 200.
Different request IDs always create separate tasks, even for identical inputs;
there is no active-task joining. Retain the request ID after a lost response:
same canonical explicit inputs return the original retained task, even if it
failed or preferences changed. Changed inputs return `request_id_conflict`.
Omitted options and `{}`, or omitted force and `false`, are equivalent. Retry a
failed/cancelled/interrupted task explicitly with a **fresh request ID**.

`GET /tasks?taskID=...` returns:

- `taskID`, `source`, `createdAt`, `updatedAt`, optional `completedAt`;
- `state`: `queued`, `running`, `cancel_requested`, `succeeded`, `failed`,
  `cancelled`, `interrupted`;
- `phase`, `disposition` (`created`, `reused_task`, `reused_result`);
- `execution`: safe actual options, runtime release/profile and input/config/env
  hashes, once preparation has completed;
- `result` after confirmed success; `error` code/message/optional category.

Poll while `queued`, `running` or `cancel_requested`. All other states are
terminal, including `interrupted`. A wait timeout stops only client waiting,
never cancels or resubmits. A task ID identifies work, not a result attachment.

`POST /tasks/cancel` with `{ "taskID": "..." }` durably cancels queued work
without affecting the active task. For active work it persists
`cancel_requested` before signalling; poll until settled. Late committed output
remains success. The execution slot covers preparation, child termination/wait,
both log drains, publication recovery/finalization, sensitive scratch cleanup
and final durable task transition; terminal progress notifications do not release
it. Cleanup uncertainty pauses further execution. Plugin shutdown stops intake and
signals the active child immediately, then awaits initialization, child wait and
both drains, publication/scratch cleanup, and the final durable mutation before
instance replacement. Public requests still validating when intake stops are
rejected; internal completion writes remain allowed. Shutdown rejects if durable
settlement or child/scratch cleanup cannot be confirmed.

## Queue management

`GET /queue` returns `paused`, `revision`, `limit`, `remainingCapacity`, optional
`activeTaskID`, ordered `pending` task records, newest-first terminal `recent`,
`recoveryReady` and `storageReady`.

- `POST /queue/pause` with `{}` stops subsequent dispatch, not the active task.
- `POST /queue/resume` with `{}` explicitly enables dispatch.
- `POST /queue/move` with `{ "taskID": "...", "before": "target-id" }` or
  `after` changes global pending order. Both tasks must still be queued;
  otherwise `task_not_queued` is returned. No preemption or revision token is
  required: moves and dequeue are serialized against the committed order.

The plugin preference `queueLimit` is the sole admission capacity authority:
default 10 **pending** tasks, excluding the active task. It must be a positive
integer. The Preferences control accepts 1–2147483647, Zotero's native integer
preference range; invalid values set outside that control cause 503
`invalid_queue_limit`. Lowering it never evicts tasks. Capacity checks never assume speculative
immediate dispatch. FIFO order, manual moves and pause changes are durable.
Fresh and recovered startups are paused; admission does not implicitly resume.

## Batches

`POST /batches` accepts a batch request ID and 1–1000 task requests in `items`:

```json
{
  "requestID": "batch-uuid",
  "items": [
    {
      "requestID": "item-uuid",
      "source": { "libraryID": 1, "itemKey": "PDFKEY01" }
    }
  ]
}
```

Each item uses task submission fields. Unlike single submit, batch entries may
name a parent with exactly one PDF. Invalid/ambiguous entries are reported
individually in `invalid` (`index`, `error`). All **new valid unique tasks** must
fit remaining capacity, otherwise the entire valid subset is rejected as
`queue_full`, with `remainingCapacity`, `requiredCapacity`, and `invalid`.
Retained task replays consume no new slots. Batch replay with unchanged item
inputs returns its retained manifest; changed inputs conflict. Batch IDs and
task request IDs have separate namespaces.

`GET /batches?batchID=...` returns `batchID`, `createdAt`, ordered `taskIDs`,
retained `tasks`, `invalid`, `expiredTaskIDs` and `partialHistory`.
`POST /batches/cancel` with `{ "batchID": "..." }` cancels queued members and
requests cancellation of an active member, retaining completed results. Batches
are thin indexes, not atomic execution transactions; members can be moved and
fail independently. Clients poll member states; there is no subscription or
long-poll framework.

## Durability, restart and retention

Versioned private JSON snapshots live under Zotero's data directory in
`<addonRef>-queue/queue.json`. Mutations serialize candidate state → atomic
flush/write → publish committed memory → acknowledgement → execution effects.
Storage errors, corrupt snapshots and unsupported versions fail closed, never
silently reset. Atomic replacement/flush is not a promise of perfect power-loss
protection or permanent exactly-once execution.

Startup recovers publication journals **before** reconciling old active tasks.
New journals correlate exact task/attempt/token identities; completion evidence
is durable before their removal. Normal result reuse also records task-owned
evidence before skipping execution. Exact verified completion yields success;
otherwise an old active task becomes `interrupted`, never automatically rerun.
Legacy publication journals recover attachments but cannot certify a new queue
task. Recovery uncertainty blocks dispatch and task outcome reconciliation.

Retain all unfinished tasks and the newest 100 terminal tasks by completion time
(`interrupted` counts as terminal). Eviction removes request replay registration
and private diagnostics, never published attachments. Owning batch manifests
remain while they own unfinished tasks; additionally retain the newest 100
other manifests (including replay-only wrappers). This bounds metadata by
unfinished work plus 100 manifests, not permanent aliases. Retained manifests
can have expired members and explicitly report partial history. Unknown or
evicted IDs return `task_not_found`/`batch_not_found`.

Copied PDF/configuration and parse/export scratch are removed on settled
execution. Raw stdout/stderr remain separately in task-owned private diagnostic
files until history eviction. **Raw CLI logs may contain secrets**; they are not
redacted and are never returned through task JSON/HTTP. Queue snapshots persist
no configuration content, environment values, logs or Zotero objects.

## Errors and failure policy

Errors use `{ "error": { "code": "...", "message": "..." } }` plus details.
Malformed input uses 400; permissions/browser Origin 403; missing/expired IDs
404; ambiguity/request conflict/capacity/reorder race/upgrade required 409;
startup/recovery/storage/configuration prerequisites 503.

Background failures are task records queried with HTTP 200. Inspect `state`
and `error`, not HTTP status alone. Input/process/validation failures continue
with the next task. Observed shared runtime or configuration preparation failures
(including configuration copy, hash or environment-read access errors) mark the
task failed and pause, preserving pending work until repair and explicit resume;
source-PDF access failures remain individual input failures. Unsafe
cleanup/termination or publication recovery failures block further
execution pending repair/restart. There is no automatic retry.
