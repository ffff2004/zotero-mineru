import type { TaskView } from "./task";
import { getString } from "../../utils/locale";

const taskWindows = new Set<Window>();

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

/** Each task owns a modeless progress window, including its temporary log actions. */
export function createTaskWindow(): (view: TaskView) => void {
  let latest: TaskView = { phase: "preparing" };
  const render = () => {
    if (dialog.window?.closed) return;
    const doc = dialog.window?.document;
    const phase = doc?.getElementById("mineru-task-phase");
    const message = doc?.getElementById("mineru-task-message");
    if (phase)
      phase.textContent = getString(
        `phase-${latest.phase}` as Parameters<typeof getString>[0],
      );
    if (message) message.textContent = latest.message || "";
    const result = doc?.getElementById("result") as HTMLButtonElement | null;
    if (result) result.hidden = latest.phase !== "done";
    const config = doc?.getElementById("config") as HTMLButtonElement | null;
    if (config) config.hidden = latest.phase !== "failed" || !latest.configPath;
  };
  const dialog = new ztoolkit.Dialog(2, 1)
    .addCell(0, 0, {
      tag: "p",
      namespace: "html",
      id: "mineru-task-phase",
      properties: { textContent: getString("phase-preparing") },
    })
    .addCell(1, 0, {
      tag: "p",
      namespace: "html",
      id: "mineru-task-message",
      properties: { textContent: "" },
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
          const pane = ztoolkit.getGlobal("ZoteroPane");
          pane.selectItem(latest.result.id);
        }
      },
    })
    .setDialogData({
      loadCallback: render,
      unloadCallback: () => taskWindows.delete(dialog.window),
    })
    .open(getString("task-title"), {
      width: 480,
      height: 210,
      noDialogMode: true,
    });
  taskWindows.add(dialog.window);
  return (view) => {
    latest = view;
    render();
  };
}
