"""Queue client/CLI contract at the HTTP boundary; no private helper mocks."""

import contextlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from test_helper import helper


class QueueServer:
    def __init__(self):
        self.requests = []
        self.task = {"taskID": "task-one", "state": "queued"}
        self.states = []
        self.batch = None
        self.reject = None
        self.drop = False
        self.bad_poll = False
        self.ambiguous = False
        self.paused = True
        self.headers = []
        self.redirect = False
        self.nonobject = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def send(self, value, status=200):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def handle_request(self):
                url = urlsplit(self.path)
                route = url.path.split("/v2")[-1]
                body = None
                if self.command == "POST":
                    body = json.loads(
                        self.rfile.read(int(self.headers["Content-Length"]))
                    )
                owner.requests.append((self.command, route, body, parse_qs(url.query)))
                owner.headers.append(dict(self.headers))
                if owner.redirect:
                    self.send_response(302)
                    self.send_header("Location", "/custom/v2/unexpected")
                    self.end_headers()
                    return
                if owner.nonobject:
                    self.send([])
                    return
                if owner.reject:
                    self.send({"error": owner.reject}, 409)
                    return
                if route == "/results":
                    if owner.ambiguous:
                        self.send(
                            {
                                "error": {
                                    "code": "multiple_pdfs",
                                    "message": "Choose",
                                    "candidates": [{"itemKey": "A"}, {"itemKey": "B"}],
                                }
                            },
                            409,
                        )
                    else:
                        self.send(
                            {
                                "source": {"libraryID": 1, "itemKey": "EXACTPDF"},
                                "results": [],
                            }
                        )
                elif route in {"/tasks", "/batches"}:
                    if body is not None and owner.drop:
                        owner.drop = False
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    if body is None:
                        if owner.bad_poll:
                            self.send(
                                {
                                    "error": {
                                        "code": "offline",
                                        "message": "Unavailable",
                                    }
                                },
                                503,
                            )
                            return
                        if owner.states:
                            owner.task["state"] = owner.states.pop(0)
                    self.send(owner.batch if route == "/batches" else owner.task)
                elif route == "/tasks/cancel":
                    owner.task["state"] = "cancel_requested"
                    self.send(owner.task)
                elif route == "/batches/cancel":
                    self.send(owner.batch)
                elif route.startswith("/queue"):
                    if route == "/queue/pause":
                        owner.paused = True
                    elif route == "/queue/resume":
                        owner.paused = False
                    self.send(
                        {
                            "paused": owner.paused,
                            "revision": len(owner.requests),
                            "limit": 10,
                            "remainingCapacity": 9,
                            "pending": [owner.task],
                            "recent": [],
                            "recoveryReady": True,
                            "storageReady": True,
                        }
                    )
                else:
                    self.send({"protocolVersion": 2, "userLibraryID": 1})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}/custom/v2"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def manifest(self, state="queued", invalid=None, expired=None, partial=False):
        self.task["state"] = state
        self.batch = {
            "batchID": "batch-one",
            "createdAt": "now",
            "taskIDs": ["task-one"] + (expired or []),
            "tasks": [self.task],
            "invalid": invalid or [],
            "expiredTaskIDs": expired or [],
            "partialHistory": partial,
        }


class QueueClientTests(unittest.TestCase):
    def setUp(self):
        self.remote = QueueServer()
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.input = self.root / "batch.json"
        self.input.write_text(
            json.dumps(
                {
                    "items": [
                        {"source": {"libraryID": 1, "itemKey": "PARENT"}},
                        {
                            "requestID": "explicit-item",
                            "source": {"libraryID": 1, "itemKey": "EXACTPDF"},
                            "options": {"ocr_mode": "force"},
                            "force": True,
                        },
                    ]
                }
            )
        )

    def tearDown(self):
        self.remote.close()
        self.temp.cleanup()

    def cli(self, *args, out=None):
        stdout = io.StringIO()
        prefix = ["--api-base", self.remote.base]
        if out:
            prefix += ["--out", str(out)]
        with contextlib.redirect_stdout(stdout):
            code = helper.main(prefix + list(args))
        return code, json.loads(stdout.getvalue())

    def posts(self):
        return [
            (route, body)
            for method, route, body, _ in self.remote.requests
            if method == "POST"
        ]

    def test_queued_running_cancel_requested_are_polled_until_publication(self):
        self.remote.states = ["queued", "running", "cancel_requested", "succeeded"]
        code, result = self.cli(
            "ensure",
            "--library-id",
            "1",
            "--item-key",
            "PARENT",
            "--interval",
            "0.001",
            "--timeout",
            "1",
        )
        self.assertEqual(code, 0)
        self.assertEqual(result["outcome"], "succeeded")
        self.assertTrue(result["terminal"])
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(len([r for r in self.remote.requests if r[1] == "/tasks"]), 5)
        self.assertTrue(self.remote.paused)  # Submission never resumes.

    def test_detach_and_timeout_zero_then_later_wait(self):
        for flag, expected in (("--detach", 0), ("--timeout", 2)):
            with self.subTest(flag=flag):
                self.remote.requests.clear()
                args = ["ensure", "--library-id", "1", "--item-key", "EXACTPDF", flag]
                if flag == "--timeout":
                    args += ["0"]
                code, result = self.cli(*args)
                self.assertEqual(code, expected)
                self.assertEqual(result["outcome"], "nonterminal")
                self.assertFalse(result["terminal"])
                self.assertEqual(result["waitingTimedOut"], flag == "--timeout")
                self.assertEqual(len(self.posts()), 1)
                self.assertFalse(
                    any(
                        r[0] == "GET" and r[1] == "/tasks" for r in self.remote.requests
                    )
                )
        self.remote.states = ["succeeded"]
        code, result = self.cli("wait", "--task-id", "task-one", "--interval", "0.001")
        self.assertEqual(code, 0)
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(len(self.posts()), 1)

    def test_positive_timeout_does_not_cancel_resume_or_resubmit(self):
        code, result = self.cli(
            "ensure",
            "--library-id",
            "1",
            "--item-key",
            "EXACTPDF",
            "--timeout",
            "0.01",
            "--interval",
            "0.002",
        )
        self.assertEqual(code, 2)
        self.assertTrue(result["waitingTimedOut"])
        self.assertEqual([route for route, _ in self.posts()], ["/tasks"])

    def test_all_terminal_failures_and_unknown_state_are_not_success(self):
        for state in ("failed", "cancelled", "interrupted", "mystery"):
            with self.subTest(state=state):
                self.remote.task["state"] = state
                code, result = self.cli("wait", "--task-id", "task-one")
                self.assertEqual(code, 1)
                if state == "mystery":
                    self.assertEqual(result["error"]["code"], "invalid_response")
                    self.assertEqual(result["error"]["taskID"], "task-one")
                else:
                    self.assertEqual(result["outcome"], state)
                    self.assertTrue(result["terminal"])
        self.assertFalse(self.posts())

    def test_global_query_pause_resume_move_and_cancel(self):
        self.assertTrue(self.cli("queue")[1]["paused"])
        self.assertFalse(self.cli("resume")[1]["paused"])
        self.assertTrue(self.cli("pause")[1]["paused"])
        self.cli("move", "--task-id", "task-one", "--before", "other")
        self.cli("move", "--task-id", "task-one", "--after", "other")
        self.assertEqual(
            self.cli("task", "--task-id", "task-one")[1]["outcome"], "nonterminal"
        )
        code, result = self.cli("cancel", "--task-id", "task-one")
        self.assertEqual(code, 0)
        self.assertEqual(result["state"], "cancel_requested")
        self.assertFalse(result["terminal"])
        self.assertEqual(
            self.posts(),
            [
                ("/queue/resume", {}),
                ("/queue/pause", {}),
                ("/queue/move", {"taskID": "task-one", "before": "other"}),
                ("/queue/move", {"taskID": "task-one", "after": "other"}),
                ("/tasks/cancel", {"taskID": "task-one"}),
            ],
        )

    def test_omitted_options_are_not_a_client_default_snapshot(self):
        self.cli("ensure", "--library-id", "1", "--item-key", "PARENT", "--detach")
        payload = self.posts()[-1][1]
        self.assertNotIn("options", payload)
        self.assertEqual(payload["source"]["itemKey"], "EXACTPDF")
        self.assertFalse(payload["force"])
        self.cli(
            "ensure",
            "--library-id",
            "1",
            "--item-key",
            "EXACTPDF",
            "--options",
            '{"ocr_mode":"never","image_analysis":false}',
            "--force",
            "--detach",
        )
        payload = self.posts()[-1][1]
        self.assertEqual(
            payload["options"], {"ocr_mode": "never", "image_analysis": False}
        )
        self.assertTrue(payload["force"])

    def test_source_ambiguity_does_not_choose_or_force(self):
        self.remote.ambiguous = True
        code, result = self.cli("ensure", "--library-id", "1", "--item-key", "PARENT")
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "multiple_pdfs")
        self.assertEqual(len(result["error"]["candidates"]), 2)
        self.assertTrue(result["error"]["requestID"])
        self.assertFalse(self.posts())

    def test_batch_stable_manifest_ids_options_and_detach(self):
        self.remote.manifest()
        for _ in range(2):
            code, result = self.cli(
                "submit-batch", "--manifest", str(self.input), "--detach"
            )
            self.assertEqual(code, 0)
            self.assertFalse(result["terminal"])
        payloads = [body for _, body in self.posts()]
        self.assertEqual(payloads[0], payloads[1])
        self.assertNotIn("options", payloads[0]["items"][0])
        self.assertNotIn("force", payloads[0]["items"][0])
        self.assertEqual(payloads[0]["items"][1]["requestID"], "explicit-item")
        self.assertEqual(payloads[0]["items"][0]["source"]["itemKey"], "PARENT")
        self.cli(
            "submit-batch",
            "--manifest",
            str(self.input),
            "--request-id",
            "new-operation",
            "--detach",
        )
        self.assertNotEqual(
            self.posts()[-1][1]["items"][0]["requestID"],
            payloads[0]["items"][0]["requestID"],
        )
        self.assertEqual(self.posts()[-1][1]["items"][1]["requestID"], "explicit-item")
        self.assertTrue(self.remote.paused)

    def test_batch_wait_checks_every_member_and_does_not_mutate(self):
        self.remote.manifest()
        second = {"taskID": "second", "state": "succeeded"}
        self.remote.batch["tasks"].insert(0, second)
        self.remote.batch["taskIDs"].append("second")
        self.remote.states = ["queued", "running", "succeeded"]
        code, result = self.cli(
            "wait", "--batch-id", "batch-one", "--interval", "0.001"
        )
        self.assertEqual(code, 0)
        self.assertEqual(result["outcome"], "succeeded")
        self.assertTrue(result["terminal"])
        self.assertGreaterEqual(len(self.remote.requests), 3)
        self.assertFalse(self.posts())

    def test_batch_invalid_and_terminal_member_failures(self):
        invalid = [
            {"index": 1, "error": {"code": "multiple_pdfs", "message": "Choose PDF"}}
        ]
        self.remote.manifest("succeeded", invalid=invalid)
        code, result = self.cli(
            "submit-batch", "--manifest", str(self.input), "--detach"
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["invalid"], invalid)
        self.assertEqual(result["outcome"], "failed")
        for state in ("failed", "cancelled", "interrupted"):
            self.remote.manifest(state)
            code, result = self.cli("batch", "--batch-id", "batch-one")
            self.assertEqual(code, 1)
            self.assertTrue(result["hasUnsuccessfulMembers"])

    def test_batch_partial_expired_empty_and_unknown_are_not_success(self):
        self.remote.manifest("succeeded", expired=["expired"], partial=True)
        self.remote.batch["tasks"] = []
        self.remote.batch["taskIDs"] = ["expired"]
        for command in ("batch", "wait"):
            code, result = self.cli(command, "--batch-id", "batch-one")
            self.assertEqual(code, 1)
            self.assertEqual(result["outcome"], "incomplete_history")
            self.assertFalse(result["terminal"])
            self.assertEqual(result["expiredTaskIDs"], ["expired"])
        self.remote.manifest("alien")
        self.assertEqual(
            self.cli("wait", "--batch-id", "batch-one")[1]["error"]["code"],
            "invalid_response",
        )
        self.remote.manifest("succeeded")
        self.remote.batch["tasks"] = []  # Missing member is not silently successful.
        self.assertEqual(
            self.cli("batch", "--batch-id", "batch-one")[1]["error"]["code"],
            "invalid_response",
        )
        self.remote.batch["taskIDs"] = []
        self.assertEqual(self.cli("batch", "--batch-id", "batch-one")[0], 1)
        self.remote.batch["invalid"] = [{"index": 0, "error": {"code": "no_pdf"}}]
        self.assertEqual(
            self.cli("wait", "--batch-id", "batch-one")[1]["outcome"], "failed"
        )

    def test_batch_timeout_query_and_cancel(self):
        self.remote.manifest()
        code, result = self.cli(
            "submit-batch", "--manifest", str(self.input), "--timeout", "0"
        )
        self.assertEqual(code, 2)
        self.assertTrue(result["waitingTimedOut"])
        self.assertEqual(self.cli("batch", "--batch-id", "batch-one")[0], 0)
        self.cli("cancel", "--batch-id", "batch-one")
        self.assertEqual(
            [route for route, _ in self.posts()], ["/batches", "/batches/cancel"]
        )
        self.assertTrue(self.remote.paused)

    def test_repeated_batch_task_ids_are_valid_retained_replays(self):
        self.remote.manifest("succeeded")
        self.remote.batch["taskIDs"].append("task-one")
        self.remote.batch["tasks"].append(dict(self.remote.task))
        code, result = self.cli("wait", "--batch-id", "batch-one")
        self.assertEqual(code, 0)
        self.assertEqual(result["outcome"], "succeeded")
        self.assertEqual(result["taskIDs"], ["task-one", "task-one"])
        self.assertFalse(self.posts())

    def test_partial_history_still_waits_for_retained_members(self):
        self.remote.manifest(expired=["expired"], partial=True)
        self.remote.states = ["running", "succeeded"]
        code, result = self.cli(
            "wait", "--batch-id", "batch-one", "--interval", "0.001"
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["outcome"], "incomplete_history")
        self.assertEqual(result["tasks"][0]["state"], "succeeded")
        self.assertFalse(result["terminal"])
        self.assertFalse(result["waitingTimedOut"])
        self.assertEqual(len(self.remote.requests), 2)

    def test_force_replay_does_not_generate_fresh_request_ids(self):
        self.remote.manifest("succeeded")
        manifest = {
            "items": [
                {"source": {"libraryID": 1, "itemKey": "EXACTPDF"}, "force": True}
            ]
        }
        self.input.write_text(json.dumps(manifest))
        first = self.cli("submit-batch", "--manifest", str(self.input), "--detach")[1]
        self.input.write_text(json.dumps(manifest, sort_keys=True, indent=4))
        replay = self.cli("submit-batch", "--manifest", str(self.input), "--detach")[1]
        self.assertEqual(first["submission"], replay["submission"])
        self.assertEqual(first["batchID"], replay["batchID"])
        fresh = self.cli(
            "submit-batch",
            "--manifest",
            str(self.input),
            "--request-id",
            "explicit-new-generation",
            "--detach",
        )[1]
        self.assertNotEqual(
            first["submission"]["requestID"], fresh["submission"]["requestID"]
        )
        self.assertNotEqual(
            first["submission"]["items"][0]["requestID"],
            fresh["submission"]["items"][0]["requestID"],
        )
        self.assertTrue(fresh["submission"]["items"][0]["force"])
        self.assertEqual(len(self.posts()), 3)

    def test_unknown_submission_state_keeps_admitted_task_and_batch_ids(self):
        self.remote.task["state"] = "alien"
        code, result = self.cli(
            "ensure", "--library-id", "1", "--item-key", "EXACTPDF", "--detach"
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "invalid_response")
        self.assertEqual(result["error"]["taskID"], "task-one")
        self.assertTrue(result["error"]["requestID"])
        self.remote.manifest("alien")
        code, result = self.cli(
            "submit-batch", "--manifest", str(self.input), "--detach"
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["batchID"], "batch-one")
        self.assertEqual(result["lastRecord"]["taskIDs"], ["task-one"])

    def test_batch_manifest_boundaries_are_local_errors_without_submission(self):
        for manifest in (
            {"items": []},
            {"items": [{}] * 1001},
            {"requestID": "", "items": [{}]},
            {"items": [{}], "options": {}},
        ):
            with self.subTest(manifest=str(manifest)[:80]):
                self.input.write_text(json.dumps(manifest))
                code, result = self.cli(
                    "submit-batch", "--manifest", str(self.input), "--detach"
                )
                self.assertEqual(code, 1)
                self.assertEqual(result["error"]["code"], "invalid_manifest")
        self.assertFalse(self.remote.requests)

    def test_batch_queue_full_retains_capacity_invalid_and_replay_payload(self):
        self.remote.reject = {
            "code": "queue_full",
            "message": "Full",
            "remainingCapacity": 1,
            "requiredCapacity": 2,
            "invalid": [{"index": 2, "error": {"code": "no_pdf"}}],
        }
        output = self.root / "error.json"
        code, result = self.cli(
            "submit-batch", "--manifest", str(self.input), "--detach", out=output
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["remainingCapacity"], 1)
        self.assertEqual(result["error"]["requiredCapacity"], 2)
        self.assertEqual(result["error"]["invalid"][0]["index"], 2)
        self.assertEqual(json.loads(output.read_text()), result)
        self.assertEqual(
            result["error"]["requestID"], result["submission"]["requestID"]
        )
        self.assertEqual(len(self.posts()), 1)

    def test_lost_batch_ack_has_stable_generated_ids_and_reusable_output(self):
        self.remote.manifest()
        self.remote.drop = True
        saved = self.root / "lost.json"
        code, lost = self.cli(
            "submit-batch", "--manifest", str(self.input), "--detach", out=saved
        )
        self.assertEqual(code, 1)
        self.assertEqual(lost["error"]["code"], "connection_failed")
        self.assertEqual(len(self.posts()), 1)
        code, replay = self.cli("submit-batch", "--manifest", str(saved), "--detach")
        self.assertEqual(code, 0)
        self.assertEqual(lost["submission"], replay["submission"])
        self.assertEqual(self.posts()[0][1], self.posts()[1][1])
        self.assertEqual(replay["batchID"], "batch-one")

    def test_lost_single_ack_preserves_generated_request_and_exact_wire_source(self):
        self.remote.drop = True
        code, result = self.cli(
            "ensure", "--library-id", "1", "--item-key", "PARENT", "--detach"
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "connection_failed")
        self.assertTrue(result["error"]["requestID"])
        self.assertEqual(result["submission"]["source"]["itemKey"], "EXACTPDF")
        self.cli(
            "ensure",
            "--library-id",
            "1",
            "--item-key",
            "EXACTPDF",
            "--request-id",
            result["error"]["requestID"],
            "--detach",
        )
        self.assertEqual(self.posts()[0][1], self.posts()[1][1])
        self.assertEqual(len(self.posts()), 2)

    def test_poll_error_preserves_request_task_batch_ids_and_last_record(self):
        self.remote.bad_poll = True
        code, result = self.cli(
            "ensure", "--library-id", "1", "--item-key", "PARENT", "--interval", "0.001"
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["taskID"], "task-one")
        self.assertEqual(result["lastRecord"]["state"], "queued")
        self.assertEqual(
            result["error"]["requestID"], result["submission"]["requestID"]
        )
        self.remote.manifest()
        code, result = self.cli(
            "submit-batch", "--manifest", str(self.input), "--interval", "0.001"
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["batchID"], "batch-one")
        self.assertEqual(result["lastRecord"]["taskIDs"], ["task-one"])
        self.assertEqual(
            result["error"]["requestID"], result["submission"]["requestID"]
        )
        self.assertEqual([route for route, _ in self.posts()], ["/tasks", "/batches"])

    def test_initial_query_error_keeps_known_id_and_output_failure_keeps_response(self):
        self.remote.bad_poll = True
        code, result = self.cli("wait", "--task-id", "known")
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["taskID"], "known")
        self.remote.bad_poll = False
        code, result = self.cli(
            "ensure",
            "--library-id",
            "1",
            "--item-key",
            "EXACTPDF",
            "--detach",
            out=self.root,
        )  # Directory cannot be an output file.
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "output_failed")
        self.assertEqual(result["response"]["taskID"], "task-one")
        self.assertEqual(result["response"]["requestID"], result["error"]["requestID"])
        self.assertEqual(len(self.posts()), 1)

    def test_old_base_explicitly_requires_upgrade_and_default_uses_package_identity(
        self,
    ):
        with self.assertRaises(helper.Failure) as raised:
            helper.Client(self.remote.base.replace("/v2", "/v1"))
        self.assertEqual(raised.exception.value["error"]["code"], "upgrade_required")
        self.assertFalse(self.remote.requests)
        env = dict(os.environ)
        env.pop("ZOTERO_MINERU_API_BASE", None)
        # A real CLI process proves upgrade errors remain machine-readable.
        result = subprocess.run(
            [
                sys.executable,
                helper.__file__,
                "--api-base",
                self.remote.base.replace("/v2", "/v1"),
                "status",
            ],
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "upgrade_required")
        config = json.loads(
            (Path(helper.__file__).parents[3] / "package.json").read_text()
        )["config"]
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import runpy; m=runpy.run_path("
                + repr(helper.__file__)
                + "); print(m['api_base']())",
            ],
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip(), f"http://127.0.0.1:23119/{config['addonRef']}/v2"
        )

    def test_redirect_and_nonobject_response_fail_without_false_success(self):
        self.remote.redirect = True
        code, result = self.cli("status")
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "invalid_response")
        self.assertEqual(len(self.remote.requests), 1)
        self.remote.redirect = False
        self.remote.nonobject = True
        code, result = self.cli("task", "--task-id", "task-one")
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "invalid_response")
        self.assertEqual(result["error"]["taskID"], "task-one")

    def test_reorder_race_is_reported_with_task_identity_without_retry(self):
        self.remote.reject = {
            "code": "task_not_queued",
            "message": "Already dispatched",
        }
        code, result = self.cli("move", "--task-id", "task-one", "--before", "other")
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "task_not_queued")
        self.assertEqual(result["error"]["taskID"], "task-one")
        self.assertEqual(len(self.posts()), 1)

    def test_no_browser_origin_and_proxy_environment_ignored(self):
        env = {
            **os.environ,
            "http_proxy": "http://127.0.0.1:1",
            "HTTP_PROXY": "http://127.0.0.1:1",
            "no_proxy": "",
            "NO_PROXY": "",
        }
        result = subprocess.run(
            [sys.executable, helper.__file__, "--api-base", self.remote.base, "status"],
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["protocolVersion"], 2)
        self.assertFalse(
            any(key.lower() == "origin" for key in self.remote.headers[-1])
        )


if __name__ == "__main__":
    unittest.main()
