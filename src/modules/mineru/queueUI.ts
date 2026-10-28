import { mineruService, type TaskRecord } from "./service";
import { getString } from "../../utils/locale";

const HTML = "http://www.w3.org/1999/xhtml";
let queueWindow: Window | undefined;

export function closeQueueWindow(): void {
  queueWindow?.close();
  queueWindow = undefined;
}

/** A detachable view of the global queue, never an owner of its execution. */
export function openQueueWindow(): Window {
  if (queueWindow && !queueWindow.closed) {
    queueWindow.focus();
    return queueWindow;
  }
  let disposed = false;
  let refreshing = false;
  let changing = false;
  let timer: number | undefined;
  let fingerprint = "";
  const detach: (() => void)[] = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) dialog.window.clearInterval(timer);
    for (const remove of detach) remove();
    detach.length = 0;
    if (queueWindow === dialog.window) queueWindow = undefined;
  };
  const dialog = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      id: "mineru-queue",
      styles: { padding: "12px", overflow: "auto", height: "90vh" },
    })
    .setDialogData({
      beforeUnloadCallback: dispose,
      unloadCallback: dispose,
      loadCallback: () => {
        if (disposed || dialog.window.closed) return;
        const win = dialog.window;
        const doc = win.document;
        const root = doc.getElementById("mineru-queue")!;
        const element = (tag: string, id: string, text = "") => {
          const node = doc.createElementNS(HTML, tag) as HTMLElement;
          node.id = id;
          node.textContent = text;
          return node;
        };
        const status = element("p", "mineru-queue-status");
        status.setAttribute("role", "status");
        const error = element("p", "mineru-queue-error");
        error.setAttribute("role", "alert");
        const queryError = element("p", "mineru-queue-query-error");
        queryError.setAttribute("role", "alert");
        const controls = element("div", "mineru-queue-controls");
        const active = element("div", "mineru-queue-active");
        const pending = element("ol", "mineru-queue-pending");
        const recent = element("ul", "mineru-queue-recent");
        const heading = (id: string, text: string, list: HTMLElement) => {
          const title = element("h2", id, text);
          list.setAttribute("aria-labelledby", id);
          return title;
        };
        root.append(
          status,
          element("p", "mineru-queue-help", getString("queue-help")),
          controls,
          error,
          queryError,
          heading(
            "mineru-queue-active-title",
            getString("queue-active"),
            active,
          ),
          active,
          heading(
            "mineru-queue-pending-title",
            getString("queue-pending"),
            pending,
          ),
          pending,
          heading(
            "mineru-queue-recent-title",
            getString("queue-recent"),
            recent,
          ),
          recent,
        );
        const describeError = (value: unknown) => {
          const failure = value as { code?: string; message?: string };
          return `${getString("queue-action-failed")}: ${failure.code ? `${failure.code}: ` : ""}${failure.message || String(value)}`;
        };
        const action = async (fn: () => unknown | Promise<unknown>) => {
          if (disposed || changing) return;
          changing = true;
          for (const node of root.querySelectorAll("button"))
            (node as HTMLButtonElement).disabled = true;
          error.textContent = "";
          try {
            await fn();
          } catch (failure) {
            if (!disposed) error.textContent = describeError(failure);
          } finally {
            changing = false;
            if (!disposed) {
              fingerprint = "";
              await refresh();
            }
          }
        };
        // One delegated listener; replacing rows leaves no retained per-task handlers.
        const actions = new Map<string, () => unknown | Promise<unknown>>();
        const click = (event: Event) => {
          const target = (event.target as Element).closest("button");
          if (target && actions.has(target.id))
            void action(actions.get(target.id)!);
        };
        root.addEventListener("click", click);
        detach.push(() => {
          root.removeEventListener("click", click);
          actions.clear();
          root.replaceChildren();
        });
        const button = (
          parent: HTMLElement,
          id: string,
          label: string,
          fn: () => unknown | Promise<unknown>,
          disabled = false,
        ) => {
          const node = element("button", id, label) as HTMLButtonElement;
          node.type = "button";
          node.disabled = disabled;
          actions.set(id, fn);
          parent.append(node);
        };
        let titles = new Map<string, string>();
        const row = (task: TaskRecord, parent: HTMLElement, tag = "li") => {
          const node = element(
            tag,
            `mineru-queue-${parent === recent ? "history" : "task"}-${task.taskID}`,
          );
          node.dataset.taskId = task.taskID;
          node.dataset.state = task.state;
          node.style.cssText = "padding:8px;overflow-wrap:anywhere";
          const state = getString(`queue-state-${task.state}`);
          node.append(
            element(
              "p",
              `${node.id}-label`,
              `${titles.get(task.taskID) || task.source.itemKey} — ${task.source.libraryID}/${task.source.itemKey} — ${state} — ${task.phase} — ${task.taskID}`,
            ),
          );
          if (task.error)
            node.append(
              element(
                "p",
                `${node.id}-error`,
                `${task.error.code}: ${task.error.message}`,
              ),
            );
          if (task.state === "succeeded" && task.result) {
            const result = task.result;
            button(
              node,
              `${node.id}-result`,
              getString("show-result"),
              async () => {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                  result.libraryID,
                  result.itemKey,
                );
                if (disposed) return;
                if (!item || item.deleted)
                  throw new Error(getString("queue-result-unavailable"));
                await Zotero.getMainWindow().ZoteroPane.selectItem(item.id);
              },
            );
          }
          parent.append(node);
          return node;
        };
        const refresh = async () => {
          if (disposed || refreshing || changing) return;
          refreshing = true;
          try {
            const queue = await mineruService.getQueue();
            const current = queue.activeTaskID
              ? await mineruService.getTask(queue.activeTaskID)
              : undefined;
            const labels = await Promise.all(
              [
                ...queue.pending,
                ...queue.recent,
                ...(current ? [current] : []),
              ].map(async (task) => {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(
                  task.source.libraryID,
                  task.source.itemKey,
                );
                return [
                  task.taskID,
                  String(
                    (item &&
                      (item.getField("title") || item.attachmentFilename)) ||
                      task.source.itemKey,
                  ),
                ] as const;
              }),
            );
            if (disposed || changing) return;
            titles = new Map(labels);
            queryError.textContent = "";
            const next = JSON.stringify({ queue, current, labels });
            if (fingerprint === next) return;
            fingerprint = next;
            const focus = doc.activeElement?.id;
            actions.clear();
            controls.replaceChildren();
            active.replaceChildren();
            pending.replaceChildren();
            recent.replaceChildren();
            status.textContent = `${getString(queue.paused ? "queue-paused" : "queue-enabled")} — ${getString("queue-capacity", { args: { pending: queue.pending.length, limit: queue.limit, remaining: queue.remainingCapacity } })} — ${getString(queue.storageReady && queue.recoveryReady ? "queue-ready" : "queue-not-ready")}`;
            button(
              controls,
              "mineru-queue-pause",
              getString("queue-pause"),
              () => mineruService.pause(),
              queue.paused,
            );
            button(
              controls,
              "mineru-queue-resume",
              getString("queue-resume"),
              () => mineruService.resume(),
              !queue.paused || !queue.storageReady || !queue.recoveryReady,
            );
            if (current) {
              const node = row(current, active, "div");
              button(
                node,
                `${node.id}-cancel`,
                getString("queue-cancel"),
                () => mineruService.cancel(current.taskID),
                current.state !== "running",
              );
            } else active.textContent = getString("queue-none");
            queue.pending.forEach((task, index) => {
              const node = row(task, pending);
              button(node, `${node.id}-cancel`, getString("queue-cancel"), () =>
                mineruService.cancel(task.taskID),
              );
              const previous = queue.pending[index - 1]?.taskID;
              const next = queue.pending[index + 1]?.taskID;
              button(
                node,
                `${node.id}-up`,
                getString("queue-up"),
                () => mineruService.move(task.taskID, { before: previous }),
                !previous,
              );
              button(
                node,
                `${node.id}-down`,
                getString("queue-down"),
                () => mineruService.move(task.taskID, { after: next }),
                !next,
              );
              button(
                node,
                `${node.id}-top`,
                getString("queue-top"),
                () =>
                  mineruService.move(task.taskID, {
                    before: queue.pending[0].taskID,
                  }),
                index === 0,
              );
            });
            for (const task of queue.recent) row(task, recent);
            if (focus)
              (doc.getElementById(focus) as HTMLElement | null)?.focus();
          } catch (failure) {
            if (!disposed) queryError.textContent = describeError(failure);
          } finally {
            refreshing = false;
          }
        };
        void refresh();
        timer = win.setInterval(() => {
          void refresh();
        }, 500);
      },
    })
    .open(getString("queue-title"), {
      width: 900,
      height: 650,
      resizable: true,
      noDialogMode: true,
    });
  queueWindow = dialog.window;
  return queueWindow;
}
