import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("runs the installed plugin menu handler in its bootstrap sandbox", async function () {
    this.timeout(15000);
    const key = `${config.prefsPrefix}.runtimeDescriptor`;
    const previous = Zotero.Prefs.get(key, true);
    const win = Zotero.getMainWindow();
    let dialog: Window | undefined;
    try {
      Zotero.Prefs.set(key, "/nonexistent/mineru-runtime.json", true);
      const menu = win.document.getElementById(
        `zotero-itemmenu-${config.addonRef}-run`,
      );
      assert.isNotNull(menu);
      menu!.dispatchEvent(new win.Event("command"));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        for (const candidate of Services.wm.getEnumerator(null)) {
          const message = candidate.document?.getElementById(
            "mineru-task-message",
          );
          if (message?.textContent?.includes("companion installer")) {
            dialog = candidate;
            break;
          }
        }
        if (dialog) break;
        await Zotero.Promise.delay(50);
      }
      assert.isDefined(dialog, "menu reports the runtime failure to the user");
    } finally {
      if (previous === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, previous, true);
      dialog?.close();
    }
  });
});
