"""Exercise the build and standalone installer CLIs with uv as the external boundary."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]

# Simulate uv and the installed interpreter/CLI without downloading Python,
# torch, or models. The installer still performs its real filesystem checks.
FAKE_UV = r'''import hashlib, json, os, pathlib, sys
manifest = json.loads(os.environ["TEST_MANIFEST"])
if sys.argv[1] == "venv":
    root = pathlib.Path(sys.argv[-1])
    (root / "bin").mkdir(parents=True)
    packages = {}
    for name, package in manifest["packages"].items():
        metadata = root / "lib" / (name + ".dist-info") / "METADATA"
        metadata.parent.mkdir(parents=True)
        metadata.write_text("Name: " + name + "\nVersion: " + package["version"] + "\n")
        packages[name] = {"version": package["version"], "metadata_path": str(metadata)}
    result = {"python_version": manifest["python_version"], "packages": packages}
    programs = {
        "python": "print(" + repr(json.dumps(result)) + ")\n",
        "mineru-kit": "import sys\nprint(" + repr(json.dumps({"mineru_version": manifest["packages"]["mineru"]["version"]})) + " if sys.argv[1] == 'version' else " + repr(" ".join(manifest["compatibility"]["required_arguments"]) + " zip") + ")\n",
    }
    for name, program in programs.items():
        path = root / "bin" / name
        path.write_text("#!" + os.environ["TEST_PYTHON"] + "\n" + program)
        path.chmod(0o755)
elif sys.argv[1:3] == ["pip", "sync"]:
    assert "--require-hashes" in sys.argv
    lock = pathlib.Path(sys.argv[-1])
    pathlib.Path(os.environ["TEST_LOCK_RECORD"]).write_text(json.dumps({"sha256": hashlib.sha256(lock.read_bytes()).hexdigest(), "path": str(lock)}))
    if os.environ.get("TEST_FAIL_SYNC"):
        sys.exit(1)
else:
    sys.exit(2)
'''


class RuntimeInstallerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.checkout = self.root / "checkout"
        (self.checkout / "scripts").mkdir(parents=True)
        shutil.copytree(ROOT / "runtime", self.checkout / "runtime")
        shutil.copy(ROOT / "package.json", self.checkout / "package.json")
        for name in ("build_runtime_installer.mjs", "install_runtime.py"):
            shutil.copy(ROOT / "scripts" / name, self.checkout / "scripts" / name)
        self.output = self.root / "download" / "install-runtime.py"
        self.manifest = json.loads((ROOT / "runtime/release.json").read_text())

    def build(self, check=True):
        return subprocess.run(
            ["node", str(self.checkout / "scripts/build_runtime_installer.mjs"), str(self.output)],
            cwd=self.root, text=True, capture_output=True, check=check,
        )

    def environment(self):
        bin_directory = self.root / "bin"
        bin_directory.mkdir()
        uv = bin_directory / "uv"
        uv.write_text(f"#!{sys.executable}\n{FAKE_UV}")
        uv.chmod(0o755)
        return {
            **os.environ,
            "PATH": f"{bin_directory}:{os.environ['PATH']}",
            "TEST_MANIFEST": json.dumps(self.manifest),
            "TEST_PYTHON": sys.executable,
            "TEST_LOCK_RECORD": str(self.root / "lock-record.json"),
            "TMPDIR": str(self.root),
        }

    def test_build_is_deterministic_and_checksum_matches(self):
        self.build()
        first = self.output.read_bytes()
        self.build()
        self.assertEqual(first, self.output.read_bytes())
        checksum = Path(f"{self.output}.sha256").read_text()
        self.assertEqual(checksum, f"{hashlib.sha256(first).hexdigest()}  install-runtime.py\n")
        result = subprocess.run([sys.executable, str(self.output), "--help"], cwd=self.output.parent, text=True, capture_output=True, check=True)
        self.assertIn("--profile", result.stdout)

    def test_build_rejects_inconsistent_release_inputs(self):
        lock = self.checkout / "runtime/requirements-cpu.lock"
        original = lock.read_bytes()
        lock.write_bytes(original + b"\n")
        result = self.build(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum mismatch", result.stderr)
        self.assertFalse(self.output.exists())
        lock.write_bytes(original)
        package_path = self.checkout / "package.json"
        package = json.loads(package_path.read_text())
        package["version"] = "0.0.0"
        package_path.write_text(json.dumps(package))
        result = self.build(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("plugin identity", result.stderr)

    def test_standalone_install_both_profiles_and_failed_upgrade_preserves_runtime(self):
        self.build()
        shutil.rmtree(self.checkout)
        environment = self.environment()
        data = self.root / "data"
        for profile in ("cpu", "nvidia"):
            with self.subTest(profile=profile):
                subprocess.run([sys.executable, str(self.output), "install", "--profile", profile, "--data-home", str(data)], cwd=self.output.parent, env=environment, text=True, capture_output=True, check=True)
                descriptor = json.loads((data / "runtime.json").read_text())
                self.assertEqual(descriptor["profile"], profile)
                self.assertEqual(descriptor["release_id"], self.manifest["release_id"])
                self.assertTrue(Path(descriptor["mineru_kit"]).is_file())
                lock_record = json.loads((self.root / "lock-record.json").read_text())
                self.assertEqual(lock_record["sha256"], self.manifest["profiles"][profile]["sha256"])
                self.assertFalse(Path(lock_record["path"]).exists())
        previous = (data / "runtime.json").read_bytes()
        environments = set((data / "environments").iterdir())
        result = subprocess.run([sys.executable, str(self.output), "upgrade", "--profile", "nvidia", "--data-home", str(data)], cwd=self.output.parent, env={**environment, "TEST_FAIL_SYNC": "1"}, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((data / "runtime.json").read_bytes(), previous)
        self.assertEqual(set((data / "environments").iterdir()), environments)
        self.assertFalse(list(self.root.glob("mineru-lock-*")))


if __name__ == "__main__":
    unittest.main()
