import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  for (const locale of ["en-US", "zh-CN"]) {
    const title = `uses the configured identity in built ${locale} Preferences and task titles`;

    it(title, async function () {
      const { AddonManager } = ChromeUtils.importESModule(
        "resource://gre/modules/AddonManager.sys.mjs",
      );
      const installed = await AddonManager.getAddonByID(config.addonID);
      assert.isDefined(installed);
      const win = Zotero.getMainWindow();
      const bundle = new win.FluentBundle(locale);
      for (const resource of ["addon", "preferences"]) {
        const uri = installed.getResourceURI(
          `locale/${locale}/${config.addonRef}-${resource}.ftl`,
        ).spec;
        const text = await Zotero.File.getContentsFromURLAsync(uri);
        assert.notInclude(text, "__addonName__");
        bundle.addResource(new win.FluentResource(text));
      }
      for (const key of ["prefs-title", "task-title", "pref-title"]) {
        const message = bundle.getMessage(`${config.addonRef}-${key}`);
        assert.isNotNull(message);
        assert.equal(bundle.formatPattern(message!.value!), config.addonName);
      }
    });
  }

  it("queues from the installed menu despite a bad runtime, without implicit resume; dequeue failure pauses", async function () {
    this.timeout(20000);
    const service = (Zotero[config.addonInstance] as any)
      .api as import("../src/modules/mineru/service").MineruTaskService;
    const key = `${config.prefsPrefix}.runtimeDescriptor`;
    const previous = Zotero.Prefs.get(key, true);
    const win = Zotero.getMainWindow();
    const dir = Zotero.getTempDirectory();
    dir.append(`mineru-startup-${Date.now()}`);
    dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
    const path = PathUtils.join(dir.path, "paper.pdf");
    await IOUtils.writeUTF8(path, "%PDF-1.4\n%%EOF\n");
    const source = await Zotero.Attachments.importFromFile({
      file: Zotero.File.pathToFile(path),
      contentType: "application/pdf",
    });
    const waitFor = async (check: () => boolean) => {
      const deadline = Date.now() + 10000;
      while (!check() && Date.now() < deadline) await Zotero.Promise.delay(20);
      assert.isTrue(check());
    };
    let taskID: string | undefined;
    try {
      await service.pause();
      Zotero.Prefs.set(key, "/nonexistent/mineru-runtime.json", true);
      await win.ZoteroPane.selectItem(source.id);
      const menu = win.document.getElementById(
        `zotero-itemmenu-${config.addonRef}-run`,
      );
      assert.isNotNull(menu);
      menu!.dispatchEvent(new win.Event("command"));
      await waitFor(() => service.getQueue().pending.length === 1);
      const task = service.getQueue().pending[0];
      taskID = task.taskID;
      assert.equal(task.state, "queued");
      assert.isTrue(service.getQueue().paused);
      assert.isUndefined(service.getQueue().activeTaskID);
      await service.resume();
      await waitFor(
        () =>
          service.getTask(task.taskID).state === "failed" &&
          !service.getQueue().activeTaskID,
      );
      assert.isTrue(
        service.getQueue().paused,
        "environment failure pauses dispatch",
      );
      assert.include(service.getTask(task.taskID).error!.message, "runtime");
    } finally {
      await service.pause();
      if (taskID) await service.cancel(taskID);
      if (previous === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, previous, true);
      for (const candidate of Services.wm.getEnumerator(null)) {
        if (
          candidate.document?.getElementById("mineru-queue") ||
          candidate.document?.getElementById("mineru-plugin-log")
        )
          candidate.close();
      }
      await source.eraseTx();
      dir.remove(true);
    }
  });
});
