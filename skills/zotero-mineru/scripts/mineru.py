#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pymupdf>=1.24"]
# ///
"""Find published MinerU results and trace their blocks to the original PDF."""

import argparse
import hashlib
import html
import http.client
import json
import math
import os
import re
import sys
import time
import unicodedata
import uuid
from collections import Counter
from pathlib import Path
from urllib import error, parse, request


class Failure(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.value = {"error": {"code": code, "message": message, **details}}


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Failure("invalid_file", f"Cannot read JSON: {path}") from exc


def api_base(explicit=None):
    value = explicit or os.environ.get("ZOTERO_MINERU_API_BASE")
    if not value:
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "package.json"
            if candidate.is_file():
                config = read_json(candidate).get("config", {})
                if config.get("addonRef"):
                    value = f"http://127.0.0.1:23119/{config['addonRef']}/v2"
                    break
    if not value:
        raise Failure(
            "api_base_missing",
            "Set --api-base to the installed plugin's local task API",
        )
    url = parse.urlsplit(value)
    if (
        url.scheme != "http"
        or url.hostname not in {"localhost", "127.0.0.1", "::1"}
        or url.username
        or url.password
    ):
        raise Failure("invalid_api_base", "The task API must be an HTTP loopback URL")
    if url.path.rstrip("/").endswith("/v1"):
        raise Failure("upgrade_required", "Use the installed plugin's v2 API base")
    if url.query or url.fragment:
        raise Failure(
            "invalid_api_base", "The API base cannot contain query or fragment"
        )
    return value.rstrip("/")


NONTERMINAL = {"queued", "running", "cancel_requested"}
TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}


def task_outcome(task):
    if (
        not isinstance(task, dict)
        or not isinstance(task.get("taskID"), str)
        or not task["taskID"]
        or not isinstance(task.get("state"), str)
        or task["state"] not in NONTERMINAL | TERMINAL
    ):
        raise Failure(
            "invalid_response", "Expected a known task ID and state", record=task
        )
    terminal = task["state"] in TERMINAL
    return {
        **task,
        "terminal": terminal,
        "outcome": task["state"] if terminal else "nonterminal",
        "waitingTimedOut": False,
    }


def batch_outcome(batch):
    if (
        not isinstance(batch, dict)
        or not isinstance(batch.get("batchID"), str)
        or not batch["batchID"]
    ):
        raise Failure("invalid_response", "Expected a batch record", record=batch)
    for key in ("taskIDs", "tasks", "invalid", "expiredTaskIDs"):
        if not isinstance(batch.get(key), list):
            raise Failure("invalid_response", f"Batch lacks {key}", record=batch)
    if not isinstance(batch.get("partialHistory"), bool):
        raise Failure("invalid_response", "Batch lacks partialHistory", record=batch)
    tasks = [task_outcome(task) for task in batch["tasks"]]
    ids = batch["taskIDs"]
    expired = batch["expiredTaskIDs"]
    retained = [task["taskID"] for task in tasks]
    if (
        not all(isinstance(item, str) and item for item in ids + expired)
        or Counter(ids) != Counter(retained + expired)
        or (not ids and not batch["invalid"])
    ):
        raise Failure("invalid_response", "Inconsistent batch membership", record=batch)
    pending = any(not task["terminal"] for task in tasks)
    incomplete = batch["partialHistory"] or bool(expired)
    failed = bool(batch["invalid"]) or any(
        task["state"] in TERMINAL - {"succeeded"} for task in tasks
    )
    if incomplete:
        outcome = "incomplete_history"
    elif pending:
        outcome = "nonterminal"
    else:
        outcome = "failed" if failed else "succeeded"
    return {
        **batch,
        "tasks": tasks,
        "terminal": not pending and not incomplete,
        "outcome": outcome,
        "hasUnsuccessfulMembers": failed,
        "waitingTimedOut": False,
    }


def operation_exit(result):
    if (
        result.get("error")
        or result.get("hasUnsuccessfulMembers")
        or result.get("outcome")
        in {"failed", "cancelled", "interrupted", "incomplete_history"}
    ):
        return 1
    return 2 if result.get("waitingTimedOut") else 0


class LoopbackRedirectHandler(request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise Failure("invalid_response", "The local API must not redirect requests")


class Client:
    def __init__(self, base, timeout=15):
        self.base = api_base(base)
        self.timeout = timeout
        # Local Zotero traffic must not follow proxy environment settings.
        self.opener = request.build_opener(
            request.ProxyHandler({}), LoopbackRedirectHandler()
        )

    def call(self, endpoint, data=None, query=None, local_api=False):
        base = self.base
        if local_api:
            url = parse.urlsplit(base)
            base = parse.urlunsplit((url.scheme, url.netloc, "/api/users/0", "", ""))
        url = base + endpoint
        if query:
            url += "?" + parse.urlencode(query)
        headers = {"Accept": "application/json", "Zotero-API-Version": "3"}
        payload = None
        if data is not None:
            payload = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            with self.opener.open(
                request.Request(url, data=payload, headers=headers),
                timeout=self.timeout,
            ) as response:
                value = json.load(response)
                if not local_api and not isinstance(value, dict):
                    raise Failure(
                        "invalid_response", "Expected a plugin JSON object", url=url
                    )
                return value
        except error.HTTPError as exc:
            try:
                with exc:
                    body = json.load(exc)
            except (OSError, http.client.HTTPException, ValueError, UnicodeError):
                body = {}
            item = body.get("error", {}) if isinstance(body, dict) else {}
            if not isinstance(item, dict):
                item = {}
            raise Failure(
                item.get("code", "http_error"),
                item.get("message", f"HTTP {exc.code}"),
                **{k: v for k, v in item.items() if k not in {"code", "message"}},
            ) from exc
        except (OSError, error.URLError, http.client.HTTPException) as exc:
            raise Failure(
                "connection_failed",
                "Cannot reach Zotero; no task was resubmitted",
                url=url,
            ) from exc
        except (ValueError, UnicodeError) as exc:
            raise Failure(
                "invalid_response", "Zotero returned invalid JSON", url=url
            ) from exc

    def find(self, library, key):
        return self.call("/results", query={"libraryID": library, "itemKey": key})

    def wait(self, record, timeout, interval, batch=False):
        summarize = batch_outcome if batch else task_outcome
        endpoint, id_key = ("/batches", "batchID") if batch else ("/tasks", "taskID")
        deadline = time.monotonic() + timeout
        try:
            record = summarize(record)
            while (
                any(task["state"] in NONTERMINAL for task in record["tasks"])
                if batch
                else record["state"] in NONTERMINAL
            ):
                if time.monotonic() >= deadline:
                    return {**record, "waitingTimedOut": True}
                time.sleep(min(interval, max(0, deadline - time.monotonic())))
                updated = self.call(endpoint, query={id_key: record[id_key]})
                if (
                    not isinstance(updated, dict)
                    or updated.get(id_key) != record[id_key]
                ):
                    raise Failure(
                        "invalid_response", "Polled identity changed", record=updated
                    )
                record = summarize(updated)
            return record
        except Failure as exc:
            exc.value["lastRecord"] = record
            if isinstance(record, dict) and id_key in record:
                exc.value["error"][id_key] = record[id_key]
            raise

    def submit(self, payload, timeout, interval, batch=False, detach=False):
        record = None
        id_key = "batchID" if batch else "taskID"
        try:
            record = self.call("/batches" if batch else "/tasks", data=payload)
            if detach:
                result = batch_outcome(record) if batch else task_outcome(record)
            else:
                result = self.wait(record, timeout, interval, batch=batch)
            return {**result, "requestID": payload["requestID"], "submission": payload}
        except Failure as exc:
            exc.value["error"]["requestID"] = payload["requestID"]
            exc.value["submission"] = payload
            if isinstance(record, dict) and record.get(id_key):
                exc.value["error"][id_key] = record[id_key]
                exc.value.setdefault("lastRecord", record)
            raise


def search(client, query):
    library_id = client.call("/status").get("userLibraryID")
    if library_id is None:
        raise Failure(
            "invalid_response", "Plugin status lacks the local personal library ID"
        )
    results, offset, size = [], 0, 100
    while True:
        batch = client.call(
            "/items/top",
            query={"q": query, "start": offset, "limit": size},
            local_api=True,
        )
        if not isinstance(batch, list):
            raise Failure("invalid_response", "Expected a Zotero item list")
        for item in batch:
            data = item.get("data", {})
            results.append(
                {
                    "itemKey": item.get("key", data.get("key")),
                    "libraryID": library_id,
                    "title": data.get("title", ""),
                    "creators": data.get("creators", []),
                    "date": data.get("date", ""),
                    "itemType": data.get("itemType"),
                }
            )
        if len(batch) < size:
            return {"items": results}
        offset += len(batch)


def ensure(
    client, library, key, options, force, request_id, timeout, interval, detach=False
):
    try:
        found = client.find(library, key)
        source = found.get("source", {}) if isinstance(found, dict) else {}
        if not source.get("itemKey") or source.get("libraryID") is None:
            raise Failure(
                "invalid_response", "Results response did not identify the source PDF"
            )
        # Plugin owns defaults, source snapshots, runtime identity and result reuse.
        payload = {
            "requestID": request_id,
            "source": {k: source[k] for k in ("libraryID", "itemKey")},
            "force": force,
        }
        if options is not None:
            payload["options"] = options
        return client.submit(payload, timeout, interval, detach=detach)
    except Failure as exc:
        exc.value["error"]["requestID"] = request_id
        raise


def batch_submission(manifest, request_id=None):
    """Fill stable wire identities, without storing a second queue or defaults."""
    if not isinstance(manifest, dict):
        raise Failure("invalid_manifest", "Batch manifest must be a JSON object")
    # Saved helper outputs (including lost acknowledgements) are reusable inputs.
    manifest = manifest.get("submission", manifest)
    if not isinstance(manifest, dict) or set(manifest) - {"requestID", "items"}:
        raise Failure("invalid_manifest", "Expected requestID and items only")
    items = manifest.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 1000:
        raise Failure("invalid_manifest", "Batch items must contain 1–1000 requests")
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    if request_id is None:
        request_id = (
            manifest.get("requestID")
            if "requestID" in manifest
            else str(uuid.uuid5(uuid.NAMESPACE_URL, "zotero-mineru-batch:" + canonical))
        )
    if not isinstance(request_id, str) or not request_id:
        raise Failure("invalid_manifest", "requestID must be a nonempty string")
    prepared = []
    for index, item in enumerate(items):
        # Leave per-item source/options diagnostics to the plugin, including ambiguity.
        if isinstance(item, dict):
            item = dict(item)
            if "requestID" not in item:
                item["requestID"] = str(
                    uuid.uuid5(uuid.NAMESPACE_URL, f"{request_id}:item:{index}")
                )
        prepared.append(item)
    return {"requestID": request_id, "items": prepared}


def bundle_files(path):
    path = Path(path).resolve()
    if path.is_dir():
        return {
            "markdown": path / "markdown.md",
            "middle": path / "middle_json.json",
            "provenance": path / "provenance.json",
        }, None
    manifest = read_json(path)
    result = manifest.get("result", manifest)
    if "paths" not in result:
        raise Failure(
            "invalid_manifest",
            "Pass a bundle directory or result/task JSON containing paths",
        )
    files = {}
    for key, value in result["paths"].items():
        if value:
            location = Path(value)
            files[key] = location if location.is_absolute() else path.parent / location
    return files, manifest.get("source", result.get("source"))


def normalize(value):
    value = html.unescape(unicodedata.normalize("NFKC", value))
    value = re.sub(r"<[^>]*>", " ", value)
    return re.sub(r"[\s$`*_{}\\]+", "", value).casefold()


def fragments(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for child in value:
            yield from fragments(child)
    elif isinstance(value, dict):
        for key in (
            "content",
            "text",
            "latex",
            "html",
            "image_path",
            "image_source",
            "src",
            "url",
        ):
            if key in value:
                yield from fragments(value[key])


def bbox_valid(bbox):
    return (
        isinstance(bbox, list)
        and len(bbox) == 4
        and all(
            isinstance(v, (int, float))
            and not isinstance(v, bool)
            and math.isfinite(v)
            and 0 <= v <= 1
            for v in bbox
        )
        and bbox[0] < bbox[2]
        and bbox[1] < bbox[3]
    )


def read_middle(path):
    middle = read_json(path)
    if (
        not isinstance(middle, dict)
        or middle.get("schema") != "docvortex.middle"
        or middle.get("schema_version") != "2.0"
        or not isinstance(middle.get("metadata"), dict)
        or middle["metadata"].get("file_suffix") != "pdf"
        or not isinstance(middle.get("pages"), list)
    ):
        raise Failure(
            "unsupported_middle",
            "Expected docvortex.middle schema_version 2.0 for a PDF with 0–1 page bboxes",
        )
    previous_page = -1
    for page in middle["pages"]:
        if not isinstance(page, dict):
            raise Failure("invalid_middle", "Expected a page object")
        page_idx = page.get("page_idx")
        if (
            not isinstance(page_idx, int)
            or isinstance(page_idx, bool)
            or page_idx <= previous_page
        ):
            raise Failure(
                "invalid_middle",
                "PDF page indices must be nonnegative and strictly increasing",
            )
        previous_page = page_idx
        blocks = page.get("blocks", [])
        if not isinstance(blocks, list):
            raise Failure("invalid_middle", "Expected a block list")
        previous_block = -1
        for block in blocks:
            if not isinstance(block, dict):
                raise Failure("invalid_middle", "Expected a block object")
            index = block.get("index")
            if (
                not isinstance(index, int)
                or isinstance(index, bool)
                or index <= previous_block
                or not bbox_valid(block.get("bbox"))
            ):
                raise Failure(
                    "invalid_middle",
                    "PDF blocks need increasing nonnegative indices and nonempty 0–1 bboxes",
                )
            previous_block = index
    return middle


def locate(bundle, query=None, line=None, context=2):
    files, source = bundle_files(bundle)
    if not files.get("middle"):
        raise Failure(
            "middle_missing",
            "This result has no middle JSON; generate a complete result for localization",
        )
    middle = read_middle(files["middle"])
    clues = []
    if query:
        clues.append(("query", query))
    if line is not None:
        lines = files["markdown"].read_text(encoding="utf-8").splitlines()
        if not 1 <= line <= len(lines):
            raise Failure("invalid_line", "Markdown line is outside the document")
        clues.append(("markdown_line", lines[line - 1]))
        for i in range(max(0, line - 1 - context), min(len(lines), line + context)):
            if i != line - 1 and lines[i].strip():
                clues.append((f"context_line_{i + 1}", lines[i]))
    clues = [(name, normalize(text)) for name, text in clues if normalize(text)]
    if not clues:
        raise Failure(
            "empty_query",
            "Supply nonempty text, LaTeX, caption, image path, or a Markdown line",
        )
    all_blocks = []
    for pi, page in enumerate(middle["pages"]):
        page_idx = page.get("page_idx")
        for bi, block in enumerate(page.get("blocks", [])):
            text = normalize(" ".join(fragments(block)))
            evidence = []
            weight = 0
            for name, clue in clues:
                if clue in text:
                    evidence.append(f"{name}: normalized substring matched")
                    weight += 4 if name in {"query", "markdown_line"} else 1
                elif len(text) >= 12 and text in clue:
                    evidence.append(f"{name}: block text contained in clue")
                    weight += 2 if name in {"query", "markdown_line"} else 1
            all_blocks.append(
                {
                    "page_idx": page_idx,
                    "pageNumber": page_idx + 1,
                    "blockIndex": block.get("index", bi),
                    "type": block.get("type"),
                    "blockPath": f"pages[{pi}].blocks[{bi}]",
                    "bbox": block.get("bbox"),
                    "localizable": bbox_valid(block.get("bbox")),
                    "evidence": evidence,
                    "excerpt": " ".join(fragments(block))[:700],
                    "_weight": weight,
                    "_continues": block.get("continues_prev") is True,
                }
            )
    # MinerU marks the first continued table of an adjacent page as continuing
    # the previous page's last table. Retain every region in that chain.
    links = {block["blockPath"]: set() for block in all_blocks}
    for previous, current in zip(middle["pages"], middle["pages"][1:]):
        if current["page_idx"] != previous["page_idx"] + 1:
            continue
        before = [
            b
            for b in all_blocks
            if b["page_idx"] == previous["page_idx"] and b["type"] == "table"
        ]
        after = [
            b
            for b in all_blocks
            if b["page_idx"] == current["page_idx"]
            and b["type"] == "table"
            and b["_continues"]
        ]
        if before and after:
            left, right = before[-1]["blockPath"], after[0]["blockPath"]
            links[left].add(right)
            links[right].add(left)
    by_path = {b["blockPath"]: b for b in all_blocks}
    selected = {b["blockPath"] for b in all_blocks if b["evidence"]}
    groups = []
    while selected:
        initial = min(selected)
        connected, pending = set(), [initial]
        while pending:
            path = pending.pop()
            if path in connected:
                continue
            connected.add(path)
            pending.extend(links[path] - connected)
        selected -= connected
        group = min(connected)
        for path in connected:
            item = by_path[path]
            item["regionGroup"] = group
            if not item["evidence"]:
                item["evidence"] = [
                    "continues_prev: linked region of a matched cross-page table"
                ]
        groups.append(connected)
    included = set().union(*groups) if groups else set()
    candidates = sorted(
        [by_path[path] for path in included],
        key=lambda x: (-x["_weight"], x["page_idx"], x["blockIndex"]),
    )
    for item in candidates:
        del item["_weight"]
        del item["_continues"]
    if not candidates:
        raise Failure(
            "no_matching_block",
            "No block matched; try neighboring text, caption or image path",
        )
    return {
        "source": source,
        "middle": str(files["middle"]),
        "candidates": candidates,
        "ambiguous": len(groups) > 1,
        "verified": False,
    }


def render(bundle, pdf, candidate, out, dpi=144, padding=0.01):
    try:
        import pymupdf as fitz
    except ImportError as exc:
        raise Failure(
            "renderer_missing",
            "Run render with uv run <skill-dir>/scripts/mineru.py render",
        ) from exc
    files, source = bundle_files(bundle)
    provenance = read_json(files["provenance"])
    expected = provenance.get("source", {}).get("sha256")
    if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise Failure("invalid_provenance", "Provenance lacks a valid source SHA-256")
    # Render the bytes actually checked rather than reopening a mutable source path.
    contents = Path(pdf).read_bytes()
    actual = hashlib.sha256(contents).hexdigest()
    if actual != expected:
        raise Failure(
            "stale_source",
            "PDF changed since parsing; ensure a new result before rendering",
            expected=expected,
            actual=actual,
        )
    page_idx, bbox = candidate.get("page_idx"), candidate.get("bbox")
    if (
        not isinstance(page_idx, int)
        or isinstance(page_idx, bool)
        or page_idx < 0
        or not bbox_valid(bbox)
    ):
        raise Failure(
            "invalid_region",
            "Region needs a nonnegative original page_idx and a 0–1 bbox",
        )
    if not 36 <= dpi <= 600 or not 0 <= padding <= 0.2:
        raise Failure("invalid_render_options", "Use DPI 36–600 and padding 0–0.2")
    # Validate candidate coordinates against the actual package, so a region from
    # another generation cannot silently be used with this provenance.
    middle = read_middle(files["middle"])
    matching = [
        block
        for page in middle.get("pages", [])
        if page.get("page_idx") == page_idx
        for block in page.get("blocks", [])
        if block.get("index") == candidate.get("blockIndex")
        and block.get("bbox") == bbox
    ]
    if not matching:
        raise Failure(
            "region_mismatch", "Candidate does not belong to this middle JSON"
        )
    directory = Path(out).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    with fitz.open(stream=contents, filetype="pdf") as doc:
        if page_idx >= len(doc):
            raise Failure(
                "page_out_of_bounds", "Middle JSON page is outside the original PDF"
            )
        page = doc[page_idx]
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        # Middle bbox is in displayed (rotation-applied) page coordinates. Crop
        # the full rendered pixmap instead of mixing PDF and rotation matrices.
        rect = fitz.IRect(
            math.floor(max(0, bbox[0] - padding) * pix.width),
            math.floor(max(0, bbox[1] - padding) * pix.height),
            math.ceil(min(1, bbox[2] + padding) * pix.width),
            math.ceil(min(1, bbox[3] + padding) * pix.height),
        )
        crop = fitz.Pixmap(pix.colorspace, rect, pix.alpha)
        crop.copy(pix, rect)
        stem = f"page-{page_idx + 1}-block-{candidate.get('blockIndex')}"
        full_path = directory / f"{stem}-page.png"
        crop_path = directory / f"{stem}-region.png"
        pix.save(str(full_path))
        crop.save(str(crop_path))
        result = {
            "source": source,
            "sourcePath": str(Path(pdf).resolve()),
            "sourceSha256": actual,
            "page_idx": page_idx,
            "pageNumber": page_idx + 1,
            "pageLabel": page.get_label() or None,
            "rotation": page.rotation,
            "bbox": bbox,
            "blockIndex": candidate.get("blockIndex"),
            "blockPath": candidate.get("blockPath"),
            "pixelRect": list(rect),
            "dpi": dpi,
            "pageImage": str(full_path),
            "regionImage": str(crop_path),
            "verified": False,
        }
    (directory / f"{stem}-evidence.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result


def add_wait_options(parser, detach=False):
    parser.add_argument(
        "--timeout",
        type=float,
        default=60,
        help="Seconds to wait; 0 returns immediately without cancelling",
    )
    parser.add_argument("--interval", type=float, default=2)
    if detach:
        parser.add_argument(
            "--detach",
            action="store_true",
            help="Return after admission; never resume the queue implicitly",
        )


def parser():
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument(
        "--api-base",
        help="Loopback plugin API URL; otherwise use env or repository package.json",
    )
    root.add_argument(
        "--out", help="Also save returned JSON (manifest or evidence) to this file"
    )
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    p = commands.add_parser("search")
    p.add_argument("query")
    for name in ("find", "ensure"):
        p = commands.add_parser(name)
        p.add_argument("--library-id", type=int, required=True)
        p.add_argument("--item-key", required=True)
        if name == "ensure":
            p.add_argument(
                "--options",
                default=None,
                help="JSON object; omitted options inherit plugin preferences",
            )
            p.add_argument("--force", action="store_true")
            p.add_argument(
                "--request-id", help="Retain this ID when resuming the same submission"
            )
            add_wait_options(p, detach=True)
    p = commands.add_parser(
        "submit-batch", help="Submit a reusable JSON batch manifest"
    )
    p.add_argument(
        "--manifest",
        required=True,
        help="JSON file; saved submission output also accepted",
    )
    p.add_argument(
        "--request-id", help="Override batch request ID for an explicitly new operation"
    )
    add_wait_options(p, detach=True)
    for name in ("task", "batch", "wait", "cancel"):
        p = commands.add_parser(name)
        if name in {"task", "batch"}:
            p.add_argument(f"--{name}-id", required=True)
        else:
            group = p.add_mutually_exclusive_group(required=True)
            group.add_argument("--task-id")
            group.add_argument("--batch-id")
        if name == "wait":
            add_wait_options(p)
    for name in ("queue", "pause", "resume"):
        commands.add_parser(name)
    p = commands.add_parser("move")
    p.add_argument("--task-id", required=True)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--before")
    group.add_argument("--after")
    p = commands.add_parser("locate")
    p.add_argument(
        "--bundle",
        required=True,
        help="Bundle directory or saved result/task manifest JSON",
    )
    p.add_argument("--query")
    p.add_argument("--line", type=int, help="One-based Markdown line")
    p.add_argument("--context", type=int, default=2)
    p = commands.add_parser("render")
    p.add_argument("--bundle", required=True)
    p.add_argument("--pdf", required=True)
    p.add_argument("--candidates", required=True, help="Saved locate output")
    p.add_argument(
        "--candidate",
        type=int,
        help="Zero-based region index; required whenever there are multiple regions, including one continued table",
    )
    p.add_argument("--directory", required=True)
    p.add_argument("--dpi", type=int, default=144)
    p.add_argument("--padding", type=float, default=0.01)
    return root


def main(argv=None):
    args = parser().parse_args(argv)
    identities = {
        key: getattr(args, attr)
        for key, attr in (
            ("taskID", "task_id"),
            ("batchID", "batch_id"),
            ("requestID", "request_id"),
        )
        if getattr(args, attr, None)
    }
    if args.command == "ensure":
        identities["requestID"] = args.request_id or str(uuid.uuid4())
    try:
        if hasattr(args, "timeout") and (
            args.timeout < 0
            or args.interval <= 0
            or not math.isfinite(args.timeout)
            or not math.isfinite(args.interval)
        ):
            raise Failure(
                "invalid_wait_options",
                "Timeout must be nonnegative and interval positive",
            )
        if args.command == "locate":
            if args.context < 0:
                raise Failure("invalid_context", "Context must be nonnegative")
            result = locate(args.bundle, args.query, args.line, args.context)
        elif args.command == "render":
            candidates = read_json(args.candidates).get("candidates", [])
            if args.candidate is None and len(candidates) != 1:
                raise Failure(
                    "candidate_required",
                    "Choose --candidate to render one region; render every region in the selected regionGroup separately",
                    count=len(candidates),
                )
            index = args.candidate if args.candidate is not None else 0
            if not 0 <= index < len(candidates):
                raise Failure(
                    "invalid_candidate", "Candidate index is outside the match list"
                )
            result = render(
                args.bundle,
                args.pdf,
                candidates[index],
                args.directory,
                args.dpi,
                args.padding,
            )
        else:
            client = Client(api_base(args.api_base))
            if args.command == "status":
                result = client.call("/status")
            elif args.command == "search":
                result = search(client, args.query)
            elif args.command == "find":
                result = client.find(args.library_id, args.item_key)
            elif args.command == "ensure":
                options = json.loads(args.options) if args.options is not None else None
                if args.options is not None and not isinstance(options, dict):
                    raise Failure("invalid_options", "--options must be a JSON object")
                result = ensure(
                    client,
                    args.library_id,
                    args.item_key,
                    options,
                    args.force,
                    identities["requestID"],
                    args.timeout,
                    args.interval,
                    args.detach,
                )
            elif args.command == "submit-batch":
                payload = batch_submission(read_json(args.manifest), args.request_id)
                identities["requestID"] = payload["requestID"]
                result = client.submit(
                    payload, args.timeout, args.interval, batch=True, detach=args.detach
                )
            elif args.command in {"task", "batch", "wait", "cancel"}:
                batch = bool(getattr(args, "batch_id", None))
                endpoint, id_key = (
                    ("/batches", "batchID") if batch else ("/tasks", "taskID")
                )
                query = {id_key: identities[id_key]}
                record = (
                    client.call(endpoint + "/cancel", data=query)
                    if args.command == "cancel"
                    else client.call(endpoint, query=query)
                )
                if (
                    not isinstance(record, dict)
                    or record.get(id_key) != identities[id_key]
                ):
                    raise Failure(
                        "invalid_response", "Response identity changed", record=record
                    )
                result = (
                    client.wait(record, args.timeout, args.interval, batch=batch)
                    if args.command == "wait"
                    else (batch_outcome(record) if batch else task_outcome(record))
                )
            elif args.command in {"queue", "pause", "resume"}:
                result = (
                    client.call("/queue")
                    if args.command == "queue"
                    else client.call("/queue/" + args.command, data={})
                )
            elif args.command == "move":
                position = (
                    {"before": args.before} if args.before else {"after": args.after}
                )
                result = client.call(
                    "/queue/move", data={"taskID": args.task_id, **position}
                )
    except Failure as exc:
        result = exc.value
        result["error"] = {**identities, **result["error"]}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        result = {"error": {"code": "invalid_input", "message": str(exc), **identities}}
    if args.out:
        try:
            Path(args.out).resolve().write_text(
                json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except OSError as exc:
            result = {
                "error": {"code": "output_failed", "message": str(exc), **identities},
                "response": result,
            }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return operation_exit(result)


if __name__ == "__main__":
    sys.exit(main())
