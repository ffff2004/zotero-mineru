"""Write SHA256SUMS for the built XPI and companion distribution files."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "runtime/release.json",
    "runtime/requirements-cpu.in",
    "runtime/requirements-cpu.lock",
    "runtime/requirements-nvidia.in",
    "runtime/requirements-nvidia.lock",
    "runtime/README.md",
    "scripts/install_runtime.py",
    "scripts/write_release_checksums.py",
    ".scaffold/build/zotero-miner-u.xpi",
)


def main() -> None:
    manifest = json.loads((ROOT / "runtime/release.json").read_text())
    package = json.loads((ROOT / "package.json").read_text())
    if manifest["plugin"] != {"id": package["config"]["addonID"], "version": package["version"]}:
        raise RuntimeError("Release manifest plugin identity differs from package.json")
    for profile in manifest["profiles"].values():
        lock = ROOT / "runtime" / profile["lock"]
        if hashlib.sha256(lock.read_bytes()).hexdigest() != profile["sha256"]:
            raise RuntimeError(f"Release manifest checksum differs from {lock}")
    lines = []
    for name in FILES:
        path = ROOT / name
        if not path.is_file():
            raise FileNotFoundError(f"Build the XPI and companion files first: {name}")
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {name}")
    target = ROOT / "runtime" / "SHA256SUMS"
    target.write_text("\n".join(lines) + "\n")
    print(target)


if __name__ == "__main__":
    main()
