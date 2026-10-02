"""Write tracked companion checksums and a release-time XPI checksum."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COMPANION_FILES = (
    "runtime/release.json",
    "runtime/requirements-cpu.in",
    "runtime/requirements-cpu.lock",
    "runtime/requirements-nvidia.in",
    "runtime/requirements-nvidia.lock",
    "runtime/README.md",
    "scripts/install_runtime.py",
    "scripts/write_release_checksums.py",
)
XPI = ROOT / ".scaffold" / "build" / "zotero-miner-u.xpi"


def main() -> None:
    manifest = json.loads((ROOT / "runtime/release.json").read_text())
    package = json.loads((ROOT / "package.json").read_text())
    if manifest["plugin"] != {"id": package["config"]["addonID"], "version": package["version"]}:
        raise RuntimeError("Release manifest plugin identity differs from package.json")
    for profile in manifest["profiles"].values():
        lock = ROOT / "runtime" / profile["lock"]
        if hashlib.sha256(lock.read_bytes()).hexdigest() != profile["sha256"]:
            raise RuntimeError(f"Release manifest checksum differs from {lock}")
    if not XPI.is_file():
        raise FileNotFoundError(f"Build the XPI first: {XPI}")
    lines = []
    for name in COMPANION_FILES:
        path = ROOT / name
        if not path.is_file():
            raise FileNotFoundError(f"Missing companion distribution file: {name}")
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {name}")
    companion_target = ROOT / "runtime" / "SHA256SUMS"
    xpi_target = XPI.parent / "XPI-SHA256SUMS"
    companion_target.write_text("\n".join(lines) + "\n")
    xpi_target.write_text(f"{hashlib.sha256(XPI.read_bytes()).hexdigest()}  {XPI.name}\n")
    print(companion_target)
    print(xpi_target)


if __name__ == "__main__":
    main()
