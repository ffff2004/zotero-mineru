import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { recoverIncompletePublications } from "./modules/mineru/publication";
import { resolveSelectedPDF } from "./modules/mineru/task";
import { mineruService } from "./modules/mineru/service";
import { registerLocalAPI } from "./modules/mineru/localAPI";
import { currentTaskSettings } from "./modules/mineru/settings";
import { readCompatibleRuntime } from "./modules/mineru/runtime";
import { safeDiagnostic } from "./modules/mineru/pluginLog";
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
  if (mineruService.busy) {
    win.alert(getString("already-running"));
    return;
  }
  const items = (win as any).ZoteroPane.getSelectedItems() as Zotero.Item[];
  const view = createTaskWindow();
  try {
    // Preserve the menu's runtime-first readiness check before opening a chooser.
    const settings = currentTaskSettings();
    try {
      await readCompatibleRuntime(settings.descriptorPath || undefined);
    } catch (error) {
      throw new Error(
        "MinerU runtime is missing or incompatible; run the companion installer",
        { cause: error },
      );
    }
    const source = await resolveSelectedPDF(items, (pdfs) =>
      choosePDF(win, pdfs),
    );
    await mineruService.submit(
      {
        requestID: crypto.randomUUID(),
        source: { libraryID: source.libraryID, itemKey: source.key },
      },
      view,
    );
  } catch (error) {
    view({
      phase: "failed",
      state: "failed",
      message: (error as Error).message,
      record: {
        timestamp: new Date().toISOString(),
        stage: "task",
        event: "failure",
        message: (error as Error).message,
        details: safeDiagnostic(error),
      },
    });
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
  let recoveryReady = true;
  try {
    await recoverIncompletePublications();
  } catch (error) {
    recoveryReady = false;
    Zotero.logError(error as Error);
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: getString("recovery-failed"), type: "fail" })
      .show();
  }
  mineruService.setReady(recoveryReady);
  unregisterAPI = registerLocalAPI();
  addon.api = mineruService;
  for (const win of Zotero.getMainWindows()) await onMainWindowLoad(win);
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: `zotero-itemmenu-${addon.data.config.addonRef}-run`,
    label: getString("run-mineru"),
    commandListener: () => {
      void runFromWindow(win);
    },
  });
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  // Menu registration belongs to the plugin instance and is cleared on shutdown.
}

function onShutdown(): void {
  unregisterAPI?.();
  unregisterAPI = undefined;
  mineruService.shutdown();
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
