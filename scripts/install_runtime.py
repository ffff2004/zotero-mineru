"""Install an immutable, hash-locked companion environment and publish its descriptor."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "runtime" / "release.json"


def check(command: list[str]) -> str:
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    return result.stdout


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def installed(python: Path, cli: Path, manifest: dict) -> dict:
    """Read installed distribution metadata, independently of the lock and descriptor."""
    probe = """import importlib.metadata as m, json, sys
result = {}
for name in ('mineru', 'docvortex'):
    dist = m.distribution(name)
    metadata_file = next((file for file in dist.files or () if file.name == 'METADATA' and file.parent.name.endswith('.dist-info')), None)
    if metadata_file is None:
        raise RuntimeError(f'{name} has no installed METADATA file')
    result[name] = {'version': dist.version, 'metadata_path': str(dist.locate_file(metadata_file))}
print(json.dumps({'python_version': sys.version.split()[0], 'packages': result}))
"""
    result = json.loads(check([str(python), "-c", probe]))
    if result["python_version"] != manifest["python_version"]:
        raise RuntimeError("Installed Python version differs from release manifest")
    for name, expected in manifest["packages"].items():
        if result["packages"][name]["version"] != expected["version"]:
            raise RuntimeError(f"Installed {name} version differs from release manifest")
        metadata = Path(result["packages"][name]["metadata_path"])
        if not metadata.is_file() or not metadata.resolve().is_relative_to(python.parent.parent.resolve()):
            raise RuntimeError(f"Installed {name} metadata is outside the environment")
    if not cli.is_file() or not os.access(cli, os.X_OK):
        raise RuntimeError("mineru-kit executable is missing")
    version = json.loads(check([str(cli), "version", "--json"]))
    if version.get("mineru_version") != result["packages"]["mineru"]["version"]:
        raise RuntimeError("mineru-kit version disagrees with installed package metadata")
    help_text = check([str(cli), "parse", "--help"])
    for argument in manifest["compatibility"]["required_arguments"]:
        if argument not in help_text:
            raise RuntimeError(f"mineru-kit parse does not expose {argument}")
    if manifest["compatibility"]["export_format"] not in help_text:
        raise RuntimeError("mineru-kit parse does not advertise ZIP export")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "upgrade"))
    parser.add_argument("--profile", choices=("cpu", "nvidia"), default="cpu")
    parser.add_argument("--data-home", type=Path, help="Test or portable data directory override")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    if sys.platform != "linux" or platform.machine() != "x86_64":
        raise RuntimeError("This lock supports Linux x86_64 only")
    libc, libc_version = platform.libc_ver()
    if libc != "glibc" or tuple(map(int, libc_version.split(".")[:2])) < (2, 34):
        raise RuntimeError("This lock requires glibc 2.34 or newer")
    lock = ROOT / "runtime" / manifest["profiles"][args.profile]["lock"]
    if digest(lock) != manifest["profiles"][args.profile]["sha256"]:
        raise RuntimeError("Release lock checksum mismatch")
    data_home = args.data_home or Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "zotero-mineru"
    data_home = data_home.expanduser().resolve()
    environments = data_home / "environments"
    environments.mkdir(parents=True, exist_ok=True)
    final = environments / f"{manifest['release_id']}-{args.profile}-{uuid.uuid4().hex[:12]}"
    staged: Path | None = None
    try:
        # Console scripts embed an absolute interpreter shebang. The candidate
        # must be installed at its permanent path; only the descriptor moves.
        staged = final
        check(["uv", "venv", "--python", manifest["python_version"], "--managed-python", str(staged)])
        check(["uv", "pip", "sync", "--python", str(staged / "bin/python"), "--require-hashes", str(lock)])
        actual = installed(final / "bin/python", final / "bin/mineru-kit", manifest)
        descriptor = {
            "schema_version": 1,
            "release_id": manifest["release_id"],
            "profile": args.profile,
            "python": str(final / "bin/python"),
            "mineru_kit": str(final / "bin/mineru-kit"),
            "python_version": actual["python_version"],
            "packages": actual["packages"],
        }
        data_home.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=data_home, prefix=".runtime-", delete=False) as stream:
            temp_descriptor = Path(stream.name)
            json.dump(descriptor, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.replace(temp_descriptor, data_home / "runtime.json")
        finally:
            temp_descriptor.unlink(missing_ok=True)
        staged = None
        print(f"Installed {manifest['release_id']} ({args.profile})")
        print(f"Runtime descriptor: {data_home / 'runtime.json'}")
    finally:
        if staged is not None:
            shutil.rmtree(staged)


if __name__ == "__main__":
    main()
