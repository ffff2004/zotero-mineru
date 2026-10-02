# Generate and publish

Use `ensure` to let the plugin resolve effective preferences, snapshot the PDF,
reuse an eligible result or task, and run its existing validation and attachment
publication flow. The plugin stores Markdown, middle JSON, assets and provenance
together and relates the result attachment to its exact source PDF.

```bash
uv run --no-project python <skill-dir>/scripts/mineru.py --out result.json ensure --library-id 1 --item-key PDFKEY01 --request-id UNIQUE-OPERATION-ID --timeout 60
```

Use a fresh request ID for a new operation and retain it in subsequent retries
of that submission. `--options` is a JSON object containing explicit overrides;
omitted options inherit plugin preferences, including the configured parsing
mode and any configured PDF upload. Proceed directly using that configuration.
`--force` creates a new generation when the user explicitly requests reparsing.
Reparsing retains earlier result attachments.

The response contains `taskID`, `state`, `phase`, `source` and, on success,
`result.paths`. `disposition` describes whether this submission created work or
reused a task/result. Reading task status has no publication side effect.

## Waiting and recovery

`running` and `cancel_requested` are in progress. `succeeded`, `failed` and
`cancelled` are terminal. `waitingTimedOut: true` means only that the helper's
wait ended; the plugin task continues. Save the task ID and resume:

```bash
uv run --no-project python <skill-dir>/scripts/mineru.py --out result.json wait --task-id TASK-ID --timeout 60
```

Keep waits short enough to communicate progress. A dropped connection does not
prove that a submission failed: preserve the returned `requestID` or `taskID`.
Query a known task first. If Zotero restarted or the task is unknown, wait for
plugin recovery, run `find` again to discover already published results, then
submit if still necessary. Reuse the request ID when the original task service
is still available. A fresh ID with `--force` means intentionally new work.

When the user requests cancellation:

```bash
uv run --no-project python <skill-dir>/scripts/mineru.py cancel --task-id TASK-ID
```

Poll until cleanup reaches a terminal state. Publication already committed may
return success despite a late cancellation request; use its published result.

## Result usability

- `valid`: usable bundle from the current source PDF. Check its options and page
  range against the present task; the plugin makes the final reuse decision.
- `partial`: readable Markdown with absent or unusable sidecars/assets. Report
  limitations when reading it; `ensure` obtains complete results when needed.
- `stale`: the source PDF hash changed. Use `ensure` for the current PDF.
- `damaged`: Markdown is absent or unusable. Use `ensure`.

A successful generation is complete when `state` is `succeeded`, the plugin
returns the published result attachment identity and paths, and the Markdown
file is readable. Report a terminal error's exact code and message; retry only
after resolving its cause. The helper uses the plugin API for publication; a
standalone CLI ZIP is not a published Zotero result.
