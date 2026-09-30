# Zotero MinerU

Zotero MinerU turns a selected PDF into a new stored Markdown attachment. The result keeps `markdown.md`, `middle_json.json`, exported images and auxiliary JSON, and a small `provenance.json` together in one Zotero storage directory. The source PDF is never changed. Repeating a run creates another attachment.

The companion release targets Linux x86_64, Zotero 10, Python 3.13.12, MinerU 4.0.10 and DocVortex 0.5.7. The installer provides CPU and NVIDIA dependency profiles; NVIDIA use also needs a compatible driver. Intel iGPU acceleration is not supported by this release.

## Install

1. Build the plugin with Node.js 24 and pnpm 11.25.0: `pnpm install --frozen-lockfile && pnpm build`. Install the resulting `.scaffold/build/*.xpi` in Zotero using Tools → Plugins → Install Plugin From File.
2. Install the companion environment with `uv run --no-project python scripts/install_runtime.py install --profile cpu` from this checkout. For NVIDIA, use `--profile nvidia`. The installer uses a dedicated directory under `${XDG_DATA_HOME:-$HOME/.local/share}/zotero-mineru/` and atomically updates `runtime.json` after verification. It does not edit system Python or existing environments. See [runtime/README.md](runtime/README.md) for upgrade instructions and checksums.
3. Prepare MinerU models according to your configuration. The first parse may download model files and require network access. Parsing never installs Python packages. The NVIDIA profile can require substantial disk space.

## Configure

Open Zotero Preferences → Zotero MinerU. The runtime status checks the descriptor and actual installed package metadata. Choose a different `runtime.json` if needed.

The MinerU configuration path follows this order: the saved custom path, a nonempty `MINERU_CONFIG` inherited by the Zotero process, then `MINERU_HOME/config.yaml` or `~/.mineru/config.yaml`. The controls show the effective path, let you choose or open a file, create a minimal `{}` YAML file if absent, and reset the custom path. The file may hold plain-text credentials; it is never copied into the result. The runtime selection, executable path, config path and task options are frozen when a task starts, so edits affect the next run. A terminal's environment is not necessarily inherited by the Zotero desktop process.

Task defaults are `tier=standard`, `ocr_mode=auto`, image analysis enabled, and pages `all`. Page range uses MinerU CLI syntax such as `1-5` or `r1`. Model, device, and service configuration belong in MinerU's YAML file. The plugin does not provide arbitrary CLI arguments or an environment editor.

## Use

Right-click one regular Zotero item or PDF attachment and choose **Run MinerU**. An item with one PDF uses it automatically; for multiple PDFs, choose by title and filename. A selected child PDF is used exactly, and an independent PDF produces an independent result in the same collections. Missing stored PDFs are retrieved through Zotero's normal file download; missing linked PDFs fail clearly. Both item and file edit permissions are required.

The task window appends timestamped plugin log entries for preparation, parsing and export, validation, saving, recovery and the final outcome. Expand exception details for safe diagnostic messages, stacks and causes. Select text or use **Copy plugin log**, which includes details even when collapsed. The log follows new entries until you scroll up; return to the bottom to resume following. Plugin logs exist only while that window is open and are never saved to a file or result package. Closing the task window releases its log and lets the task continue. Parsing has no fabricated percentage. **Open stdout** and **Open stderr** open the original separate CLI streams with the system handler. Before those files are created or after they are cleaned up, the buttons explain that the log is unavailable. A failed CLI run also offers **Open configuration file**. **Show result** selects the new attachment only when clicked after success; completion does not change selection.

Only one task runs per plugin instance. Disabling the plugin or quitting Zotero stops an active child process. Zotero MinerU creates a new result each time and does not provide queueing or cancellation controls.

## Current limits

The CLI's stdout and stderr are diagnostics only. A nonzero exit reports “MinerU 解析失败”; inspect the separate logs and configuration file for details. The plugin cannot expose reliable internal parse percentages or infer the exact MinerU internal error from log text. Its Markdown follows the companion CLI's normal export and does not add page markers or blank-page placeholders. The XPI excludes Python, drivers, and models.

The source PDF is related to the result by Zotero's native `dc:relation`; the result note contains `zotero-mineru-generation:v1`. The standalone package only records the input snapshot SHA-256, not Zotero item identity. The new attachment is journaled during publication so startup can recover an incomplete write.
