# Companion runtime (Linux x86_64)

This release combination pins official PyPI `mineru` 4.0.10 and `docvortex`
0.5.7 with CPython 3.13.12. The hash-locked dependency sets target glibc 2.34
or newer. The source and wheel hashes are in `release.json`.

Download `install-runtime.py` and `install-runtime.py.sha256` from the same
GitHub Release as your plugin. The installer embeds the manifest and both
dependency locks; it runs from any directory with uv installed, without a
source checkout. Verify the download and install the CPU profile:

```sh
sha256sum -c install-runtime.py.sha256
uv run --no-project install-runtime.py install --profile cpu
```

For source builds, `pnpm build` also generates `.scaffold/build/install-runtime.py`
and `install-runtime.py.sha256`. `pnpm build:runtime-installer` generates only
these two files using Node.js. The build validates the plugin identity and lock
hashes and embeds their exact contents. Release CI uploads both files beside
the XPI. To verify the built installer:

```sh
(cd .scaffold/build && sha256sum -c install-runtime.py.sha256)
```

Maintainers can additionally generate and verify the tracked source checksums
and XPI checksum after the final production build:

```sh
pnpm build
uv run --no-project python scripts/write_release_checksums.py
sha256sum -c runtime/SHA256SUMS
(cd .scaffold/build && sha256sum -c XPI-SHA256SUMS)
```

Commit `runtime/SHA256SUMS` with the stable companion source files. If distributing
the XPI checksum, upload `.scaffold/build/XPI-SHA256SUMS` beside
`zotero-miner-u.xpi`. The XPI checksum is generated after building because the build embeds
a changing build timestamp; rebuild the XPI only before regenerating its
checksum.

The NVIDIA profile adds MinerU's published `torch` extra, currently locking
PyTorch 2.14.0 and its CUDA 13 dependencies. It requires a compatible NVIDIA
driver and has a substantially larger download. Device and model choices remain
in the MinerU config.

```sh
uv run --no-project install-runtime.py install --profile nvidia
```

For an upgrade, download the installer and checksum from the new plugin
Release, verify it, then run `uv run --no-project install-runtime.py upgrade
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
