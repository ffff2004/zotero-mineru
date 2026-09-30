import { assert } from "chai";
import {
  resolveSelectedPDF,
  MineruTaskController,
} from "../src/modules/mineru/task";

function directory(): nsIFile {
  const dir = Zotero.getTempDirectory();
  dir.append(`mineru-task-test-${Date.now()}-${Math.random()}`);
  dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
  return dir;
}

async function pdf(
  dir: nsIFile,
  name: string,
  parentItemID?: number,
): Promise<Zotero.Item> {
  const file = dir.clone();
  file.append(name);
  await Zotero.File.putContentsAsync(file, "%PDF-1.4\n%%EOF\n");
  return Zotero.Attachments.importFromFile({
    file,
    contentType: "application/pdf",
    parentItemID,
  });
}

describe("MinerU selection and task interface", function () {
  it("chooses one child, an exact child, and a standalone PDF", async function () {
    const dir = directory();
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Selection test");
    await parent.saveTx();
    const first = await pdf(dir, "first.pdf", parent.id);
    let second: Zotero.Item | undefined;
    let standalone: Zotero.Item | undefined;
    try {
      assert.equal(
        (await resolveSelectedPDF([parent], async () => undefined)).id,
        first.id,
      );
      second = await pdf(dir, "second.pdf", parent.id);
      const found = await resolveSelectedPDF([parent], async (choices) => {
        assert.deepEqual(
          choices.map((item) => item.id),
          [first.id, second!.id],
        );
        return second;
      });
      assert.equal(found.id, second.id);
      assert.equal(
        (await resolveSelectedPDF([first], async () => undefined)).id,
        first.id,
      );
      standalone = await pdf(dir, "standalone.pdf");
      assert.equal(
        (await resolveSelectedPDF([standalone], async () => undefined)).id,
        standalone.id,
      );
    } finally {
      if (standalone) await standalone.eraseTx();
      if (second) await second.eraseTx();
      await first.eraseTx();
      await parent.eraseTx();
      dir.remove(true);
    }
  });

  it("rejects multi-selection and unsupported items without starting a task", async function () {
    const controller = new MineruTaskController();
    let failure = "";
    const views: string[] = [];
    await controller.run(
      [],
      async () => undefined,
      {
        options: {
          tier: "standard",
          ocr_mode: "auto",
          image_analysis: true,
          page_range: "all",
        },
      },
      (view) => {
        views.push(view.phase);
        failure = view.message || "";
      },
    );
    assert.deepEqual(views, ["preparing", "failed"]);
    assert.match(failure, /exactly one/);
    assert.isFalse(controller.busy);
  });

  it("holds the single-task lock during selection and suppresses callbacks after shutdown", async function () {
    const dir = directory();
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Task lock test");
    await parent.saveTx();
    const first = await pdf(dir, "one.pdf", parent.id);
    const second = await pdf(dir, "two.pdf", parent.id);
    const controller = new MineruTaskController();
    const phases: string[] = [];
    let release!: (item: Zotero.Item) => void;
    const chosen = new Promise<Zotero.Item>((resolve) => {
      release = resolve;
    });
    try {
      const running = controller.run(
        [parent],
        async () => chosen,
        {
          options: {
            tier: "standard",
            ocr_mode: "auto",
            image_analysis: true,
            page_range: "all",
          },
        },
        (view) => phases.push(view.phase),
      );
      assert.isTrue(controller.busy);
      let blocked = "";
      try {
        await controller.run(
          [first],
          async () => first,
          {
            options: {
              tier: "standard",
              ocr_mode: "auto",
              image_analysis: true,
              page_range: "all",
            },
          },
          () => undefined,
        );
      } catch (error) {
        blocked = String(error);
      }
      assert.match(blocked, /already running/);
      controller.shutdown();
      release(second);
      assert.isUndefined(await running);
      assert.deepEqual(phases, ["preparing"]);
      assert.isFalse(controller.busy);
    } finally {
      await second.eraseTx();
      await first.eraseTx();
      await parent.eraseTx();
      dir.remove(true);
    }
  });
});
