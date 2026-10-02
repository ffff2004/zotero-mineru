import type { TaskView } from "./task";
import type { PluginLogRecord } from "./pluginLog";
import { getString } from "../../utils/locale";

const taskWindows = new Set<Window>();
const HTML = "http://www.w3.org/1999/xhtml";

export function closeTaskWindows(): void {
  for (const win of taskWindows) {
    if (!win.closed) win.close();
  }
  taskWindows.clear();
}

function openFile(
  win: Window,
  path: string | undefined,
  unavailable: string,
): void {
  let available = false;
  try {
    available = !!path && Zotero.File.pathToFile(path).isFile();
  } catch {
    // A removed or invalid temporary path is unavailable.
  }
  if (!available || !path) {
    win.alert(unavailable);
    return;
  }
  Zotero.launchFile(path);
}

type WindowSink = { current?: (view: TaskView) => void };

// This closure retains only a detachable sink, never a dialog, model or records.
function reportTo(sink: WindowSink): (view: TaskView) => void {
  return (view) => sink.current?.(view);
}

/** Closing the window detaches reporting; the controller continues its task. */
export function createTaskWindow(): (view: TaskView) => void {
  const sink: WindowSink = {};
  let latest: TaskView = { phase: "preparing" };
  let pending: PluginLogRecord[] = [];
  let loaded = false;
  let following = true;
  const area = () =>
    dialog.window?.document.getElementById("mineru-plugin-log");
  const append = (record: PluginLogRecord) => {
    const log = area();
    if (!log) return;
    const doc = log.ownerDocument;
    if (!doc) return;
    const row = doc.createElementNS(HTML, "div");
    row.className = "mineru-log-record";
    const line = doc.createElementNS(HTML, "div");
    const stage =
      record.stage === "task" || record.stage === "recovery"
        ? getString(`log-stage-${record.stage}`)
        : getString(`phase-${record.stage}`);
    line.textContent = `${record.timestamp} | ${stage} | ${getString(`log-event-${record.event}`)} | ${record.message}`;
    row.append(line);
    if (record.details) {
      const details = doc.createElementNS(HTML, "details");
      const summary = doc.createElementNS(HTML, "summary");
      summary.textContent = getString("log-details");
      const pre = doc.createElementNS(HTML, "pre") as HTMLPreElement;
      pre.style.cssText =
        "white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0";
      pre.textContent = record.details;
      details.append(summary, pre);
      row.append(details);
      details.addEventListener("toggle", () => {
        if (following) log.scrollTop = log.scrollHeight;
      });
    }
    log.append(row);
    if (following) log.scrollTop = log.scrollHeight;
  };
  const render = () => {
    if (!loaded || dialog.window?.closed) return;
    const doc = dialog.window.document;
    const result = doc.getElementById("result") as HTMLButtonElement | null;
    if (result) result.hidden = latest.phase !== "done";
    const config = doc.getElementById("config") as HTMLButtonElement | null;
    if (config) config.hidden = latest.phase !== "failed" || !latest.configPath;
  };
  const dialog = new ztoolkit.Dialog(2, 1)
    .addCell(0, 0, {
      tag: "p",
      namespace: "html",
      properties: { textContent: getString("plugin-log") },
    })
    .addCell(1, 0, {
      tag: "div",
      namespace: "html",
      id: "mineru-plugin-log",
      attributes: { tabindex: "0", "aria-label": getString("plugin-log") },
      styles: {
        height: "290px",
        overflowY: "auto",
        userSelect: "text",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        padding: "8px",
        border: "1px solid GrayText",
      },
    })
    .addButton(getString("copy-plugin-log"), "copy", {
      noClose: true,
      callback: () => {
        const lines = Array.from(area()?.children || []).map((row) => {
          const line = row.firstElementChild?.textContent || "";
          const details = row.querySelector("pre")?.textContent;
          return details
            ? `${line}\n${getString("log-details")}:\n${details}`
            : line;
        });
        Zotero.Utilities.Internal.copyTextToClipboard(lines.join("\n\n"));
      },
    })
    .addButton(getString("open-stdout"), "stdout", {
      noClose: true,
      callback: () =>
        openFile(
          dialog.window,
          latest.logs?.stdout,
          getString("log-unavailable"),
        ),
    })
    .addButton(getString("open-stderr"), "stderr", {
      noClose: true,
      callback: () =>
        openFile(
          dialog.window,
          latest.logs?.stderr,
          getString("log-unavailable"),
        ),
    })
    .addButton(getString("open-configuration"), "config", {
      noClose: true,
      callback: () =>
        openFile(
          dialog.window,
          latest.configPath,
          getString("config-unavailable"),
        ),
    })
    .addButton(getString("show-result"), "result", {
      noClose: true,
      callback: () => {
        if (latest.phase === "done" && latest.result) {
          ztoolkit.getGlobal("ZoteroPane").selectItem(latest.result.id);
        }
      },
    })
    .setDialogData({
      beforeUnloadCallback: () => {
        sink.current = undefined;
        pending = [];
        latest = { phase: "preparing" };
        area()?.replaceChildren();
      },
      loadCallback: () => {
        if (dialog.window.closed || !sink.current) return;
        loaded = true;
        const log = area();
        log?.addEventListener("scroll", () => {
          following = log.scrollHeight - log.clientHeight - log.scrollTop <= 4;
        });
        for (const record of pending) append(record);
        pending = [];
        render();
      },
      unloadCallback: () => {
        sink.current = undefined;
        pending = [];
        latest = { phase: "preparing" };
        area()?.replaceChildren();
        taskWindows.delete(dialog.window);
      },
    })
    .open(getString("task-title"), {
      width: 760,
      height: 440,
      resizable: true,
      noDialogMode: true,
    });
  sink.current = (view) => {
    if (dialog.window.closed) return;
    // Do not retain the record a second time in the action state.
    const { record, ...actions } = view;
    latest = actions;
    if (record) {
      if (loaded) append(record);
      else pending.push(record);
    }
    render();
  };
  taskWindows.add(dialog.window);
  return reportTo(sink);
}
