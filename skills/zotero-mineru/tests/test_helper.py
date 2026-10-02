"""Observable helper behavior with real PDF files and an external HTTP double."""

import contextlib
import hashlib
import importlib.util
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pymupdf

SPEC = importlib.util.spec_from_file_location(
    "mineru_helper", Path(__file__).parents[1] / "scripts" / "mineru.py"
)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class LibraryServer:
    def __init__(self):
        self.submissions = []
        self.polls = 0
        self.ambiguous = False
        self.task = {"taskID": "one", "state": "running", "phase": "parsing"}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def send(self, value, code=200):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())

            def do_GET(self):
                if "/results?" in self.path:
                    if owner.ambiguous:
                        self.send(
                            {
                                "error": {
                                    "code": "multiple_pdfs",
                                    "message": "Choose a PDF",
                                    "candidates": [{"itemKey": "A"}, {"itemKey": "B"}],
                                }
                            },
                            409,
                        )
                    else:
                        self.send(
                            {
                                "source": {"libraryID": 1, "itemKey": "SOURCE"},
                                "results": [],
                            }
                        )
                elif "/tasks?" in self.path:
                    owner.polls += 1
                    self.send(
                        {
                            **owner.task,
                            "state": "succeeded",
                            "result": {
                                "itemKey": "RESULT",
                                "paths": {"markdown": "/stored/markdown.md"},
                            },
                        }
                    )
                elif "/items/top?" in self.path:
                    offset = int(
                        helper.parse.parse_qs(helper.parse.urlsplit(self.path).query)[
                            "start"
                        ][0]
                    )
                    count = 100 if offset == 0 else 1
                    self.send(
                        [
                            {
                                "key": str(offset + i),
                                "library": {"id": 1},
                                "data": {"title": "Paper"},
                            }
                            for i in range(count)
                        ]
                    )
                else:
                    self.send({"protocolVersion": 1, "userLibraryID": 9})

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.submissions.append(data)
                self.send(
                    {
                        **owner.task,
                        "disposition": "created"
                        if len(owner.submissions) == 1
                        else "reused_task",
                    }
                )

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = helper.Client(
            f"http://127.0.0.1:{self.server.server_port}/example/v1"
        )

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        self.pdf = self.root / "source.pdf"
        with pymupdf.open() as doc:
            doc.new_page(width=200, height=100)
            page = doc.new_page(width=200, height=100)
            page.draw_rect(
                pymupdf.Rect(20, 10, 80, 40), color=(1, 0, 0), fill=(1, 0, 0)
            )
            page.set_rotation(90)
            doc.new_page(width=200, height=100)
            doc.save(self.pdf)
        self.provenance = {
            "source": {"sha256": hashlib.sha256(self.pdf.read_bytes()).hexdigest()},
            "requested_options": {"page_range": "2-3"},
        }
        self.middle = {
            "schema": "docvortex.middle",
            "schema_version": "2.0",
            "metadata": {"file_suffix": "pdf"},
            "is_full_document": False,
            "pages": [
                {
                    "page_idx": 1,
                    "blocks": [
                        {
                            "index": 0,
                            "type": "text",
                            "bbox": [0.6, 0.1, 0.9, 0.4],
                            "content": [
                                {"type": "text", "content": "The energy is "},
                                {"type": "equation_inline", "content": "E=mc^2"},
                            ],
                        },
                        {
                            "index": 1,
                            "type": "table",
                            "bbox": [0.1, 0.5, 0.9, 0.8],
                            "content": [
                                {
                                    "type": "table_caption",
                                    "content": [
                                        {
                                            "type": "text",
                                            "content": "Table 1: measurements",
                                        }
                                    ],
                                },
                                {
                                    "type": "table_body",
                                    "content": "<table><tr><td>42</td></tr></table>",
                                },
                            ],
                        },
                    ],
                },
                {
                    "page_idx": 2,
                    "blocks": [
                        {
                            "index": 0,
                            "type": "table",
                            "bbox": [0.1, 0.1, 0.9, 0.5],
                            "continues_prev": True,
                            "content": [
                                {
                                    "type": "table_caption",
                                    "content": [
                                        {
                                            "type": "text",
                                            "content": "Table 1: measurements",
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                },
            ],
        }
        self.write_bundle()

    def tearDown(self):
        self.temp.cleanup()

    def write_bundle(self):
        (self.bundle / "middle_json.json").write_text(json.dumps(self.middle))
        (self.bundle / "provenance.json").write_text(json.dumps(self.provenance))
        (self.bundle / "markdown.md").write_text(
            "The energy is $E=mc^2$\n\nTable 1: measurements\n"
        )

    def test_inline_equation_keeps_paragraph_region_and_original_page_index(self):
        found = helper.locate(self.bundle, query="$E = mc^2$")
        self.assertFalse(found["ambiguous"])
        candidate = found["candidates"][0]
        self.assertEqual(candidate["type"], "text")
        self.assertEqual(candidate["page_idx"], 1)
        self.assertEqual(candidate["pageNumber"], 2)
        self.assertEqual(candidate["bbox"], [0.6, 0.1, 0.9, 0.4])
        self.assertFalse(found["verified"])

    def test_repeated_caption_retains_both_table_regions(self):
        self.middle["pages"][1]["blocks"][0]["continues_prev"] = False
        self.write_bundle()
        found = helper.locate(self.bundle, query="Table 1: measurements")
        self.assertTrue(found["ambiguous"])
        self.assertEqual([c["pageNumber"] for c in found["candidates"]], [2, 3])
        self.assertTrue(all(c["type"] == "table" for c in found["candidates"]))

    def test_continued_table_without_caption_returns_all_regions(self):
        self.middle["pages"][1]["blocks"][0]["content"] = [
            {"type": "table_body", "content": "continuation rows"}
        ]
        self.write_bundle()
        found = helper.locate(self.bundle, query="Table 1: measurements")
        self.assertFalse(found["ambiguous"])
        self.assertEqual([c["pageNumber"] for c in found["candidates"]], [2, 3])
        self.assertEqual(
            found["candidates"][0]["regionGroup"], found["candidates"][1]["regionGroup"]
        )
        self.assertIn("continues_prev", found["candidates"][1]["evidence"][0])

    def test_image_path_and_neighboring_context(self):
        self.middle["pages"][0]["blocks"][1]["content"].append(
            {"type": "table_body", "image_path": "images/table.jpg"}
        )
        self.write_bundle()
        self.assertEqual(
            helper.locate(self.bundle, query="images/table.jpg")["candidates"][0][
                "blockIndex"
            ],
            1,
        )
        found = helper.locate(self.bundle, query="wrong OCR", line=2)
        self.assertEqual(len(found["candidates"]), 3)

    def test_rotated_page_crop_contains_real_source_pixels(self):
        candidate = helper.locate(self.bundle, query="E=mc^2")["candidates"][0]
        rendered = helper.render(
            self.bundle, self.pdf, candidate, self.root / "images", dpi=72, padding=0
        )
        self.assertEqual(rendered["rotation"], 90)
        self.assertEqual(rendered["pageNumber"], 2)
        image = pymupdf.Pixmap(rendered["regionImage"])
        self.assertEqual((image.width, image.height), (30, 60))
        self.assertEqual(image.pixel(15, 30), (255, 0, 0))
        page = pymupdf.Pixmap(rendered["pageImage"])
        self.assertEqual((page.width, page.height), (100, 200))
        self.assertFalse(rendered["verified"])

    def test_changed_pdf_refused_before_render(self):
        candidate = helper.locate(self.bundle, query="E=mc^2")["candidates"][0]
        self.pdf.write_bytes(self.pdf.read_bytes() + b"\n% changed")
        with self.assertRaises(helper.Failure) as raised:
            helper.render(self.bundle, self.pdf, candidate, self.root / "images")
        self.assertEqual(raised.exception.value["error"]["code"], "stale_source")

    def test_all_pdf_rotations_crop_the_same_visual_content(self):
        rectangles = {
            0: [0.1, 0.1, 0.4, 0.4],
            90: [0.6, 0.1, 0.9, 0.4],
            180: [0.6, 0.6, 0.9, 0.9],
            270: [0.1, 0.6, 0.4, 0.9],
        }
        for rotation, bbox in rectangles.items():
            with self.subTest(rotation=rotation):
                pdf = self.root / f"rotation-{rotation}.pdf"
                with pymupdf.open() as doc:
                    page = doc.new_page(width=200, height=100)
                    page.draw_rect(
                        pymupdf.Rect(20, 10, 80, 40), color=(1, 0, 0), fill=(1, 0, 0)
                    )
                    page.set_rotation(rotation)
                    doc.save(pdf)
                self.provenance["source"]["sha256"] = hashlib.sha256(
                    pdf.read_bytes()
                ).hexdigest()
                self.middle["pages"] = [
                    {
                        "page_idx": 0,
                        "blocks": [
                            {
                                "index": 0,
                                "type": "equation",
                                "bbox": bbox,
                                "content": "x=y",
                            }
                        ],
                    }
                ]
                self.write_bundle()
                candidate = helper.locate(self.bundle, query="x=y")["candidates"][0]
                result = helper.render(
                    self.bundle,
                    pdf,
                    candidate,
                    self.root / f"images-{rotation}",
                    dpi=72,
                    padding=0,
                )
                image = pymupdf.Pixmap(result["regionImage"])
                self.assertEqual(
                    image.pixel(image.width // 2, image.height // 2), (255, 0, 0)
                )

    def test_invalid_bbox_and_out_of_bounds_page_are_refused(self):
        candidate = helper.locate(self.bundle, query="E=mc^2")["candidates"][0]
        with self.assertRaises(helper.Failure) as raised:
            helper.render(
                self.bundle,
                self.pdf,
                {**candidate, "bbox": [0, 0, 1000, 1000]},
                self.root / "images",
            )
        self.assertEqual(raised.exception.value["error"]["code"], "invalid_region")
        self.middle["pages"][0]["page_idx"] = 99
        self.middle["pages"] = self.middle["pages"][:1]
        self.write_bundle()
        candidate = helper.locate(self.bundle, query="E=mc^2")["candidates"][0]
        with self.assertRaises(helper.Failure) as raised:
            helper.render(self.bundle, self.pdf, candidate, self.root / "images")
        self.assertEqual(raised.exception.value["error"]["code"], "page_out_of_bounds")

    def test_manifest_retains_identity_and_relative_paths(self):
        manifest = self.root / "result.json"
        manifest.write_text(
            json.dumps(
                {
                    "source": {"itemKey": "SOURCE"},
                    "result": {
                        "paths": {
                            "markdown": "bundle/markdown.md",
                            "middle": "bundle/middle_json.json",
                            "provenance": "bundle/provenance.json",
                        }
                    },
                }
            )
        )
        found = helper.locate(manifest, query="E=mc^2")
        self.assertEqual(found["source"]["itemKey"], "SOURCE")
        self.assertEqual(Path(found["middle"]), self.bundle / "middle_json.json")

    def test_ambiguous_cli_render_does_not_choose_first(self):
        candidates = self.root / "candidates.json"
        candidates.write_text(
            json.dumps(helper.locate(self.bundle, query="Table 1: measurements"))
        )
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = helper.main(
                [
                    "render",
                    "--bundle",
                    str(self.bundle),
                    "--pdf",
                    str(self.pdf),
                    "--candidates",
                    str(candidates),
                    "--directory",
                    str(self.root / "images"),
                ]
            )
        self.assertEqual(code, 1)
        self.assertEqual(
            json.loads(stdout.getvalue())["error"]["code"], "candidate_required"
        )

    def test_schema_versions_and_non_pdf_coordinates_are_refused(self):
        changes = (
            {"schema": "different.product"},
            {"schema_version": "999"},
            {"metadata": {"file_suffix": "ofd"}},
        )
        candidate = helper.locate(self.bundle, query="E=mc^2")["candidates"][0]
        original = self.middle.copy()
        for change in changes:
            with self.subTest(change=change):
                self.middle = {**original, **change}
                self.write_bundle()
                for operation in (
                    lambda: helper.locate(self.bundle, query="E=mc^2"),
                    lambda: helper.render(
                        self.bundle, self.pdf, candidate, self.root / "images"
                    ),
                ):
                    with self.assertRaises(helper.Failure) as raised:
                        operation()
                    self.assertEqual(
                        raised.exception.value["error"]["code"], "unsupported_middle"
                    )

    def test_invalid_middle_page_order_and_bbox_are_refused(self):
        original = json.loads(json.dumps(self.middle))
        for mutation in ("page_order", "block_bbox", "block_order"):
            with self.subTest(mutation=mutation):
                self.middle = json.loads(json.dumps(original))
                if mutation == "page_order":
                    self.middle["pages"].reverse()
                elif mutation == "block_order":
                    self.middle["pages"][0]["blocks"].reverse()
                else:
                    self.middle["pages"][0]["blocks"][0]["bbox"] = [0, 0, 1000, 1000]
                self.write_bundle()
                with self.assertRaises(helper.Failure) as raised:
                    helper.locate(self.bundle, query="E=mc^2")
                self.assertEqual(
                    raised.exception.value["error"]["code"], "invalid_middle"
                )

    def test_one_continued_table_requires_region_index_not_ambiguity_resolution(self):
        found = helper.locate(self.bundle, query="Table 1: measurements")
        self.assertFalse(found["ambiguous"])
        candidates = self.root / "candidates.json"
        candidates.write_text(json.dumps(found))
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = helper.main(
                [
                    "render",
                    "--bundle",
                    str(self.bundle),
                    "--pdf",
                    str(self.pdf),
                    "--candidates",
                    str(candidates),
                    "--directory",
                    str(self.root / "images"),
                ]
            )
        self.assertEqual(code, 1)
        issue = json.loads(stdout.getvalue())["error"]
        self.assertEqual(issue["code"], "candidate_required")
        self.assertIn("regionGroup", issue["message"])


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.remote = LibraryServer()

    def tearDown(self):
        self.remote.close()

    def test_ensure_waits_for_publication_and_preserves_request_id(self):
        result = helper.ensure(
            self.remote.client, 1, "PARENT", {}, False, "stable-id", 1, 0.01
        )
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["result"]["itemKey"], "RESULT")
        self.assertEqual(
            self.remote.submissions,
            [
                {
                    "requestID": "stable-id",
                    "source": {"libraryID": 1, "itemKey": "SOURCE"},
                    "options": {},
                    "force": False,
                }
            ],
        )

    def test_wait_timeout_does_not_cancel_or_resubmit(self):
        result = helper.ensure(
            self.remote.client, 1, "SOURCE", {}, False, "stable-id", 0, 0.01
        )
        self.assertTrue(result["waitingTimedOut"])
        self.assertEqual(result["taskID"], "one")
        self.assertEqual(len(self.remote.submissions), 1)
        self.assertEqual(self.remote.polls, 0)
        result = self.remote.client.wait(result, 1, 0.01)
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(len(self.remote.submissions), 1)

    def test_retry_preserves_operation_identity(self):
        helper.ensure(self.remote.client, 1, "SOURCE", {}, False, "stable-id", 0, 0.01)
        result = helper.ensure(
            self.remote.client, 1, "SOURCE", {}, False, "stable-id", 0, 0.01
        )
        self.assertEqual(result["disposition"], "reused_task")
        self.assertEqual(
            [r["requestID"] for r in self.remote.submissions],
            ["stable-id", "stable-id"],
        )

    def test_multiple_pdfs_returns_candidates_without_submission(self):
        self.remote.ambiguous = True
        with self.assertRaises(helper.Failure) as raised:
            helper.ensure(
                self.remote.client, 1, "PARENT", {}, False, "stable-id", 0, 0.01
            )
        self.assertEqual(raised.exception.value["error"]["code"], "multiple_pdfs")
        self.assertEqual(len(raised.exception.value["error"]["candidates"]), 2)
        self.assertFalse(self.remote.submissions)

    def test_metadata_search_is_paginated(self):
        result = helper.search(self.remote.client, "Paper")
        self.assertEqual(len(result["items"]), 101)
        self.assertEqual(result["items"][-1]["itemKey"], "100")
        self.assertTrue(all(item["libraryID"] == 9 for item in result["items"]))

    def test_remote_api_base_is_refused(self):
        with self.assertRaises(helper.Failure):
            helper.api_base("https://example.com/mineru/v1")


if __name__ == "__main__":
    unittest.main()
