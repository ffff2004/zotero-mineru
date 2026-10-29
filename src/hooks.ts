import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { resolveSelectedPDF } from "./modules/mineru/task";
import { mineruService } from "./modules/mineru/service";
import { registerLocalAPI } from "./modules/mineru/localAPI";
import { closeQueueWindow, openQueueWindow } from "./modules/mineru/queueUI";
import { closeTaskWindows, createTaskWindow } from "./modules/mineru/ui";
let unregisterAPI: (() => void) | undefined;

async function choosePDF(
  win: Window,
  pdfs: Zotero.Item[],
): Promise<Zotero.Item | undefined> {
  const choices = pdfs.map(
    (pdf) => `${pdf.getField("title")} — ${pdf.attachmentFilename || ""}`,
  );
  const selected = { value: 0 };
  const accepted = Services.prompt.select(
    win as mozIDOMWindowProxy,
    getString("task-title"),
    getString("choose-pdf"),
    choices,
    selected,
  );
  return accepted ? pdfs[selected.value] : undefined;
}

async function runFromWindow(win: _ZoteroTypes.MainWindow): Promise<void> {
  const items = (win as any).ZoteroPane.getSelectedItems() as Zotero.Item[];
  const invalidDetails = (
    invalid: { index: number; error: { code: string; message: string } }[],
  ) =>
    invalid
      .map(
        ({ index, error }) =>
          `${index + 1}. ${items[index]?.getField("title") || items[index]?.key || ""}: ${error.code}: ${error.message}`,
      )
      .join("\n");
  try {
    openQueueWindow();
    if (items.length > 1) {
      // The shared module resolves each parent and admits the entire valid subset
      // atomically. Ambiguous parents are reported, never silently picked.
      const batch = await mineruService.submitBatch({
        requestID: crypto.randomUUID(),
        items: items.map((item) => ({
          requestID: crypto.randomUUID(),
          source: { libraryID: item.libraryID, itemKey: item.key },
        })),
      });
      win.alert(
        [
          getString("queue-batch-submitted", {
            args: { count: batch.taskIDs.length },
          }),
          invalidDetails(batch.invalid),
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } else {
      const source = await resolveSelectedPDF(items, (pdfs) =>
        choosePDF(win, pdfs),
      );
      let report: ReturnType<typeof createTaskWindow> | undefined;
      await mineruService.submit(
        {
          requestID: crypto.randomUUID(),
          source: { libraryID: source.libraryID, itemKey: source.key },
        },
        (view) => {
          // TaskView is execution-only. Do not show a misleading preparing log
          // while queued, or leave an empty log window after rejected admission.
          report ??= createTaskWindow();
          report(view);
        },
      );
    }
  } catch (value) {
    const error = value as {
      code?: string;
      message: string;
      details?: {
        remainingCapacity?: number;
        requiredCapacity?: number;
        invalid?: { index: number; error: { code: string; message: string } }[];
      };
    };
    const details = error.details;
    win.alert(
      [
        getString("queue-action-failed"),
        `${error.code ? `${error.code}: ` : ""}${error.message}`,
        error.code === "queue_full"
          ? getString("queue-full", {
              args: {
                remaining: details?.remainingCapacity ?? 0,
                required: details?.requiredCapacity ?? 1,
              },
            })
          : "",
        invalidDetails(details?.invalid || []),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function onStartup(): Promise<void> {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  initLocale();
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
  try {
    await mineruService.initialize();
  } catch (error) {
    Zotero.logError(error as Error);
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: getString("recovery-failed"), type: "fail" })
      .show();
  }
  unregisterAPI = registerLocalAPI();
  addon.api = mineruService;
  for (const win of Zotero.getMainWindows()) await onMainWindowLoad(win);
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
  ztoolkit.Menu.register(
    win.document.getElementById("menu_ToolsPopup") as XUL.MenuPopup,
    {
      tag: "menuitem",
      id: `zotero-toolsmenu-${addon.data.config.addonRef}-queue`,
      label: getString("queue-title"),
      commandListener: () => {
        openQueueWindow();
      },
    },
  );
  ztoolkit.Menu.register(
    win.document.getElementById("zotero-itemmenu") as XUL.MenuPopup,
    {
      tag: "menuitem",
      id: `zotero-itemmenu-${addon.data.config.addonRef}-run`,
      label: getString("run-mineru"),
      commandListener: () => {
        void runFromWindow(win);
      },
    },
  );
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  // Menu registration belongs to the plugin instance and is cleared on shutdown.
}

async function onShutdown(): Promise<void> {
  unregisterAPI?.();
  unregisterAPI = undefined;
  await mineruService.shutdown();
  closeQueueWindow();
  closeTaskWindows();
  addon.data.alive = false;
  ztoolkit.unregisterAll();
  // @ts-expect-error Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(
  type: string,
  data: { window: Window },
): Promise<void> {
  if (type === "load") await registerPrefsScripts(data.window);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
