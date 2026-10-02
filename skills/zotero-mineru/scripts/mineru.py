#!/usr/bin/env python3
"""Find published MinerU results and trace their blocks to the original PDF."""

import argparse
import hashlib
import html
import json
import math
import os
import re
import sys
import time
import unicodedata
import uuid
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
                    value = f"http://127.0.0.1:23119/{config['addonRef']}/v1"
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
    return value.rstrip("/")


class Client:
    def __init__(self, base, timeout=15):
        self.base = base
        self.timeout = timeout
        # Local Zotero traffic must not follow proxy environment settings.
        self.opener = request.build_opener(request.ProxyHandler({}))

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
                return json.load(response)
        except error.HTTPError as exc:
            try:
                with exc:
                    body = json.load(exc)
            except (ValueError, UnicodeError):
                body = {}
            item = body.get("error", {})
            raise Failure(
                item.get("code", "http_error"),
                item.get("message", f"HTTP {exc.code}"),
                **{k: v for k, v in item.items() if k not in {"code", "message"}},
            ) from exc
        except (error.URLError, TimeoutError) as exc:
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

    def wait(self, task, timeout, interval):
        deadline = time.monotonic() + timeout
        while task.get("state") in {"running", "cancel_requested"}:
            if time.monotonic() >= deadline:
                return {**task, "waitingTimedOut": True}
            time.sleep(min(interval, max(0, deadline - time.monotonic())))
            try:
                task = self.call("/tasks", query={"taskID": task["taskID"]})
            except Failure as exc:
                exc.value["error"]["taskID"] = task["taskID"]
                raise
        return task


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


def ensure(client, library, key, options, force, request_id, timeout, interval):
    found = client.find(library, key)
    source = found.get("source", {})
    if not source.get("itemKey") or source.get("libraryID") is None:
        raise Failure(
            "invalid_response", "Results response did not identify the source PDF"
        )
    # Plugin owns options, source snapshots, runtime identity and result reuse.
    payload = {
        "requestID": request_id,
        "source": {k: source[k] for k in ("libraryID", "itemKey")},
        "options": options,
        "force": force,
    }
    try:
        task = client.call("/tasks", data=payload)
    except Failure as exc:
        exc.value["error"]["requestID"] = request_id
        raise
    task = client.wait(task, timeout, interval)
    return {**task, "requestID": request_id}


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
            "Run render with uv run --no-project --with pymupdf python",
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
                default="{}",
                help="JSON object; omitted options inherit plugin preferences",
            )
            p.add_argument("--force", action="store_true")
            p.add_argument(
                "--request-id", help="Retain this ID when resuming the same submission"
            )
            p.add_argument("--timeout", type=float, default=60)
            p.add_argument("--interval", type=float, default=2)
    for name in ("wait", "cancel"):
        p = commands.add_parser(name)
        p.add_argument("--task-id", required=True)
        if name == "wait":
            p.add_argument("--timeout", type=float, default=60)
            p.add_argument("--interval", type=float, default=2)
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
                options = json.loads(args.options)
                if not isinstance(options, dict):
                    raise Failure("invalid_options", "--options must be a JSON object")
                result = ensure(
                    client,
                    args.library_id,
                    args.item_key,
                    options,
                    args.force,
                    args.request_id or str(uuid.uuid4()),
                    args.timeout,
                    args.interval,
                )
            elif args.command == "wait":
                task = client.call("/tasks", query={"taskID": args.task_id})
                result = client.wait(task, args.timeout, args.interval)
            else:
                result = client.call("/tasks/cancel", data={"taskID": args.task_id})
        if args.out:
            Path(args.out).resolve().write_text(
                json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("state") not in {"failed", "cancelled"} else 1
    except Failure as exc:
        print(json.dumps(exc.value, ensure_ascii=False, indent=2))
        return 1
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(
            json.dumps(
                {"error": {"code": "invalid_input", "message": str(exc)}},
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
