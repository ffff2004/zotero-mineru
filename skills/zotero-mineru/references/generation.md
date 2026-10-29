# Generate and manage queued work

The helper is a client of the plugin's shared durable queue, not a scheduler.
`ensure` resolves an unambiguous parent or exact PDF, then submits that exact PDF.
`multiple_pdfs` requires a selection; use the chosen attachment key. Independent
request IDs create separate tasks, not joins. The plugin alone decides result
reuse and publishes Markdown, middle JSON, assets and provenance together.

## Submit and leave

```bash
uv run --no-project python <skill-dir>/scripts/mineru.py --out result.json ensure --library-id 1 --item-key PDFKEY01 --request-id UNIQUE-OPERATION-ID --detach
```

Use a fresh request ID for a new operation. `ensure` generates one when omitted;
retain the returned ID and exact `submission` after an uncertain acknowledgement.
`--options` is a JSON object of explicit overrides (`tier`, `ocr_mode`,
`image_analysis`, `page_range`). Omitted options remain omitted: **at dequeue**
the plugin reads latest preferences, runtime descriptor and configuration paths,
then applies explicit overrides. Preparation freezes PDF/configuration bytes and
the execution environment. No helper-side defaults snapshot or source replacement
occurs. Configuration can include remote services or configured PDF upload.

`--force` intentionally creates a new generation without deleting old attachments;
it does not bypass request-ID replay. Replaying the same ID and same explicit
inputs returns the retained task even after failure or configuration changes;
changed inputs conflict. Retry failed/cancelled/interrupted work only explicitly,
with a fresh ID, after resolving its cause. For an uncertain single submission,
repeat `ensure` using `submission.source`'s **exact PDF key**, the same request ID,
options and force, rather than re-resolving a possibly changed parent.

## Batch manifests

`submit-batch --manifest batch.json --detach` accepts a JSON object with 1–1000
`items`. Each item uses the task submission shape:

```json
{
  "requestID": "batch-operation-id",
  "items": [
    {
      "requestID": "item-operation-id",
      "source": { "libraryID": 1, "itemKey": "PDFKEY01" },
      "options": { "ocr_mode": "auto" }
    },
    { "source": { "libraryID": 1, "itemKey": "PARENT01" } }
  ]
}
```

Batch parents are resolved only when unambiguous by the plugin. Invalid entries
(including missing/ambiguous PDFs) appear in `invalid` with their zero-based index
and error. All new valid unique tasks must fit remaining capacity or none of the
valid subset is admitted: `queue_full` preserves `remainingCapacity`,
`requiredCapacity` and invalid-item diagnostics. Retained replays take no slots.
The default capacity is **10 pending tasks**, excluding the active task; the
plugin's `queueLimit` preference is the only capacity authority. Query `queue`
for the actual limit and remaining capacity.

Missing top-level request IDs are deterministically derived from the manifest's
canonical JSON. Missing item IDs are derived from the top-level request ID and
item index. Thus unchanged input replays the same logical submission, including
when `force` is true; it is not a command to rerun every time. Prefer explicit
stable IDs in saved manifests. `--request-id NEW-ID` overrides the top-level ID
and derives fresh IDs for **missing** item IDs. Explicit old item IDs still replay
their original tasks, even under a new batch ID. For a genuinely new retry or
forced generation, replace those explicit item IDs too. Preserve item order
when replaying. Task request IDs and batch request IDs use separate namespaces.

Success and submission errors include the exact wire `submission`. A saved helper
output containing it is also accepted as `--manifest`, so a lost acknowledgement
can be explicitly replayed without losing generated identities. The helper never
automatically retries a dropped request or polls by resubmitting it.

## Query, wait and outcomes

```bash
uv run --no-project python <skill-dir>/scripts/mineru.py task --task-id TASK-ID
uv run --no-project python <skill-dir>/scripts/mineru.py batch --batch-id BATCH-ID
uv run --no-project python <skill-dir>/scripts/mineru.py --out result.json wait --task-id TASK-ID --timeout 60
uv run --no-project python <skill-dir>/scripts/mineru.py wait --batch-id BATCH-ID --timeout 60
```

`queued`, `running`, `cancel_requested` are nonterminal. `succeeded`, `failed`,
`cancelled`, `interrupted` are terminal; unknown states yield `invalid_response`.
The task response preserves `taskID`, `state`, `phase`, `source`, execution details
and, on success, `result.paths`. Batch output preserves ordered `taskIDs`, retained
`tasks`, `invalid`, `expiredTaskIDs` and `partialHistory`; waiting checks every
retained member, not only the first. Batches group work, not atomic execution.

Task/batch operations add `terminal`, `outcome`, `waitingTimedOut`. Task outcomes
are `nonterminal` or the terminal state. Batch outcomes are `nonterminal`,
`succeeded`, `failed`, or `incomplete_history`; `hasUnsuccessfulMembers` separately
flags invalid/failed/cancelled/interrupted members even while others still run.
Incomplete history is never reported as complete success, even with no retained
tasks. Waits still follow retained unfinished members in a partial batch.

- Exit **0**: successful operation/query, including explicitly nonterminal detached
  submissions or status queries. It does **not** alone mean generation completed.
- Exit **1**: API/input/output error, unsuccessful task/member, or incomplete history.
- Exit **2**: wait timed out without a known failure or incomplete history.

`--detach` returns after admission without waiting. `--timeout 0` stops waiting
immediately; for unfinished work it sets `waitingTimedOut: true`. A positive
expired timeout does the same. Neither cancels, resubmits nor resumes. The default
submission wait is 60 seconds; keep waits short enough to communicate progress.
Network errors retain known request/task/batch IDs, the submission and/or last
record. `--out` saves errors as well as successful responses; if writing fails,
stdout reports `output_failed` and retains the response with its identities.

## Shared queue controls

Fresh and restarted queues stay **paused** until explicitly resumed. Submitting
never resumes them. Queue changes affect menu/API/other clients alike:

```bash
uv run --no-project python <skill-dir>/scripts/mineru.py queue
uv run --no-project python <skill-dir>/scripts/mineru.py resume
uv run --no-project python <skill-dir>/scripts/mineru.py pause
uv run --no-project python <skill-dir>/scripts/mineru.py move --task-id TASK-ID --before OTHER-TASK-ID
uv run --no-project python <skill-dir>/scripts/mineru.py move --task-id TASK-ID --after OTHER-TASK-ID
uv run --no-project python <skill-dir>/scripts/mineru.py cancel --task-id TASK-ID
uv run --no-project python <skill-dir>/scripts/mineru.py cancel --batch-id BATCH-ID
```

Pause stops subsequent dispatch, not the active task. Moves require both tasks
still queued; a dequeue race is surfaced as `task_not_queued`, never preemption.
Cancellation immediately removes queued work from dispatch or requests active
cancellation. Poll until cleanup settles. Late committed publication may still
succeed; retain its result. Individual parse/input failures allow subsequent work;
shared environment/recovery failures pause or block dispatch. There is no auto-retry.

## Restart, expiration and result reconciliation

Startup recovers publications and reconciles old active tasks before allowing
execution, remaining paused. Exact completion evidence can confirm success;
otherwise old active work becomes `interrupted`, not automatically rerun. Resume
starts only pending work, including tasks using latest defaults at dequeue.

All unfinished tasks and the newest **100 terminal tasks** are retained. Eviction
removes request replay protection and private diagnostics, not published results.
Owning batches remain while they own unfinished tasks; additionally the newest
100 other manifests remain. Batch members can expire and history can be partial;
unknown/evicted IDs report `task_not_found` or `batch_not_found`.

A dropped connection does not prove failure. Query a known task/batch first, or
explicitly replay the same submission while retained. For expired records, run
`find` against each exact source and reconcile published result identity/options
before submitting again. Expired history cannot certify a forced attempt completed;
a fresh forced request may intentionally duplicate a previously published result.
Do not interpret empty/partial batch history as total success.

## Result usability

- `valid`: usable bundle from the current source PDF. Check its options and page
  range against the present task; the plugin makes the final reuse decision.
- `partial`: readable Markdown with absent or unusable sidecars/assets. Report
  limitations when reading it; `ensure` obtains complete results when needed.
- `stale`: the source PDF hash changed. Use `ensure` for the current PDF.
- `damaged`: Markdown is absent or unusable. Use `ensure`.

Generation is complete when the task is `succeeded`, the plugin returns the
published result attachment identity/paths, and the Markdown is readable. Report
a terminal error's exact code/message. A standalone CLI ZIP is not a published
Zotero result. For the transport contract, see the repository's
[local API protocol](https://github.com/ffff2004/zotero-mineru/blob/main/docs/local-api.md).
