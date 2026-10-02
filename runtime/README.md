# Companion runtime (Linux x86_64)

This release combination pins official PyPI `mineru` 4.0.10 and `docvortex`
0.5.7 with CPython 3.13.12. The hash-locked dependency sets target glibc 2.34
or newer. The source and wheel hashes are in `release.json`.

After the final production build, generate and verify both checksum files from
the repository root:

```sh
pnpm build
uv run --no-project python scripts/write_release_checksums.py
sha256sum -c runtime/SHA256SUMS
(cd .scaffold/build && sha256sum -c XPI-SHA256SUMS)
```

Commit `runtime/SHA256SUMS` with the stable companion distribution files. Ship
`.scaffold/build/XPI-SHA256SUMS` beside `zotero-miner-u.xpi` as a release
artifact. The XPI checksum is generated at release time because the build embeds
a changing build timestamp; rebuild the XPI only before regenerating its
checksum.

Install the CPU profile with:

```sh
uv run --no-project python scripts/install_runtime.py install --profile cpu
```

The NVIDIA profile adds MinerU's published `torch` extra, currently locking
PyTorch 2.14.0 and its CUDA 13 dependencies. It requires a compatible NVIDIA
driver and has a substantially larger download. Device and model choices remain
in the MinerU config.

```sh
uv run --no-project python scripts/install_runtime.py install --profile nvidia
```

For an upgrade, distribute a new manifest and lock files under a new release
ID, then run `uv run --no-project python scripts/install_runtime.py upgrade
--profile cpu` (or `nvidia`). The new environment has its own directory under
`${XDG_DATA_HOME:-$HOME/.local/share}/zotero-mineru/environments/`. The active
descriptor is `runtime.json` in the parent directory. Installation and
compatibility checks finish before the descriptor is replaced. A failed
installation removes only its new candidate environment, preserving the old
descriptor and environment. The script never edits system Python or other
virtual environments. Parsed attachments and MinerU config are untouched.

The installer checks actual installed distribution metadata for both packages,
`mineru-kit version --json` for MinerU, and published parse options. The CLI
JSON version output does not contain the DocVortex version. The Zotero plugin
reads the descriptor and installed `METADATA` when Preferences checks status or
a task starts. It also checks the expected interpreter and CLI paths for
executable files. Only the installer invokes `version --json`.
The descriptor does not carry a config path.

Config path selection is: saved Preferences value, inherited nonempty
`MINERU_CONFIG`, then the bundled release's default (`MINERU_HOME/config.yaml`
when `MINERU_HOME` is nonempty, otherwise `~/.mineru/config.yaml`). Paths are
expanded and frozen to an absolute value when a task starts. Model files use
MinerU's own download and cache flow; the first parse may require network
access. No Python package install occurs during a parse. To inspect a failure,
read the separate task stdout and stderr logs, check the selected config file,
and rerun the installer for a missing or mismatched runtime.

The installer checks package versions and CLI argument support before activating
the descriptor. Each result package is checked for ZIP layout, MiddleJson schema,
and asset references before it is saved.
