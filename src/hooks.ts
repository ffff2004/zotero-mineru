import { getString, initLocale } from "./utils/locale";
import { getPref } from "./utils/prefs";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { recoverIncompletePublications } from "./modules/mineru/publication";
import { MineruTaskController } from "./modules/mineru/task";
import { closeTaskWindows, createTaskWindow } from "./modules/mineru/ui";
import type { ParseOptions } from "./modules/mineru/package";

const task = new MineruTaskController();

function setting(
  key:
    | "runtimeDescriptor"
    | "configPath"
    | "tier"
    | "ocrMode"
    | "imageAnalysis"
    | "pageRange",
): string {
  return String(getPref(key) ?? "");
}

function taskOptions(): ParseOptions {
  return {
    tier: (setting("tier") || "standard") as ParseOptions["tier"],
    ocr_mode: (setting("ocrMode") || "auto") as ParseOptions["ocr_mode"],
    image_analysis: getPref("imageAnalysis") !== false,
    page_range: setting("pageRange") || "all",
  };
}

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
  if (task.busy) {
    win.alert(getString("already-running"));
    return;
  }
  const items = (win as any).ZoteroPane.getSelectedItems() as Zotero.Item[];
  const view = createTaskWindow();
  await task.run(
    items,
    (pdfs) => choosePDF(win, pdfs),
    {
      descriptorPath: setting("runtimeDescriptor"),
      customConfigPath: setting("configPath"),
      options: taskOptions(),
    },
    view,
  );
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
    await recoverIncompletePublications();
  } catch (error) {
    Zotero.logError(error as Error);
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({ text: getString("recovery-failed"), type: "fail" })
      .show();
  }
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
  task.shutdown();
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
