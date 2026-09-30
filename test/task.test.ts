import { assert } from "chai";
import {
  resolveSelectedPDF,
  MineruTaskController,
} from "../src/modules/mineru/task";
import { recoverIncompletePublications } from "../src/modules/mineru/publication";
import manifest from "../runtime/release.json";
import type { TaskSettings, TaskView } from "../src/modules/mineru/task";

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

async function runtimeFixture(root: nsIFile, name: string, script: string) {
  const base = PathUtils.join(root.path, name);
  const bin = PathUtils.join(base, "bin");
  const site = PathUtils.join(base, "lib", "site-packages");
  await IOUtils.makeDirectory(bin, { createAncestors: true });
  const python = PathUtils.join(bin, "python");
  const cli = PathUtils.join(bin, "mineru-kit");
  await IOUtils.writeUTF8(python, "fixture");
  await IOUtils.writeUTF8(cli, script);
  Zotero.File.pathToFile(python).permissions = 0o755;
  Zotero.File.pathToFile(cli).permissions = 0o755;
  const packages: Record<string, { version: string; metadata_path: string }> =
    {};
  for (const packageName of ["mineru", "docvortex"] as const) {
    const version = manifest.packages[packageName].version;
    const metadata_path = PathUtils.join(
      site,
      `${packageName}.dist-info`,
      "METADATA",
    );
    await IOUtils.makeDirectory(PathUtils.parent(metadata_path)!, {
      createAncestors: true,
    });
    await IOUtils.writeUTF8(
      metadata_path,
      `Name: ${packageName}\nVersion: ${version}\n\n`,
    );
    packages[packageName] = { version, metadata_path };
  }
  const descriptorPath = PathUtils.join(base, "runtime.json");
  await IOUtils.writeUTF8(
    descriptorPath,
    JSON.stringify({
      schema_version: 1,
      release_id: manifest.release_id,
      profile: "cpu",
      python,
      mineru_kit: cli,
      python_version: manifest.python_version,
      packages,
    }),
  );
  const configPath = PathUtils.join(base, "config.yaml");
  await IOUtils.writeUTF8(configPath, "{}\n");
  return { descriptorPath, configPath };
}

async function parseZIP(root: nsIFile): Promise<string> {
  const contents = PathUtils.join(root.path, "contents");
  await IOUtils.makeDirectory(contents);
  await IOUtils.writeUTF8(PathUtils.join(contents, "markdown.md"), "# A\n");
  await IOUtils.writeUTF8(
    PathUtils.join(contents, "middle_json.json"),
    JSON.stringify({
      schema: "docvortex.middle",
      schema_version: "2.0",
      metadata: {
        file_suffix: "pdf",
        producer: { name: "MinerU", version: manifest.packages.mineru.version },
      },
      extensions: { mineru: { tier: "standard", parse_mode: "txt" } },
      pages: [],
      is_full_document: true,
    }),
  );
  const zip = PathUtils.join(root.path, "fixture.zip");
  await Zotero.File.zipDirectory(contents, zip, null);
  return zip;
}

function defaults(): TaskSettings["options"] {
  return {
    tier: "standard",
    ocr_mode: "auto",
    image_analysis: true,
    page_range: "all",
  };
}

describe("MinerU selection and task interface", function () {
  this.timeout(120000);

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

  it("freezes runtime, executable, options and effective config before PDF choice", async function () {
    const dir = directory();
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Freeze test");
    await parent.saveTx();
    const first = await pdf(dir, "first.pdf", parent.id);
    const second = await pdf(dir, "second.pdf", parent.id);
    const initial = await runtimeFixture(
      dir,
      "initial",
      "#!/bin/sh\nprintf '%s\\n' \"$@\"\nprintf 'config=%s\\n' \"$MINERU_CONFIG\" >&2\nexit 3\n",
    );
    const later = await runtimeFixture(
      dir,
      "later",
      "#!/bin/sh\nprintf 'wrong executable\\n'\nexit 3\n",
    );
    const oldConfig = Services.env.get("MINERU_CONFIG");
    const settings: TaskSettings = {
      descriptorPath: initial.descriptorPath,
      options: defaults(),
    };
    const views: TaskView[] = [];
    try {
      Services.env.set("MINERU_CONFIG", initial.configPath);
      await new MineruTaskController().run(
        [parent],
        async () => {
          settings.descriptorPath = later.descriptorPath;
          settings.options.tier = "flash";
          settings.options.page_range = "r1";
          Services.env.set("MINERU_CONFIG", later.configPath);
          return second;
        },
        settings,
        (view) => views.push(view),
      );
      const failed = views.at(-1)!;
      assert.equal(failed.phase, "failed");
      assert.equal(failed.failureCategory, "process");
      assert.equal(failed.configPath, initial.configPath);
      assert.match(
        await IOUtils.readUTF8(failed.logs!.stdout),
        /--tier\nstandard/,
      );
      assert.match(await IOUtils.readUTF8(failed.logs!.stdout), /--pages\nall/);
      assert.notInclude(
        await IOUtils.readUTF8(failed.logs!.stdout),
        "wrong executable",
      );
      assert.include(
        await IOUtils.readUTF8(failed.logs!.stderr),
        `config=${initial.configPath}`,
      );
    } finally {
      Services.env.set("MINERU_CONFIG", oldConfig);
      await second.eraseTx();
      await first.eraseTx();
      await parent.eraseTx();
      dir.remove(true);
    }
  });

  for (const retained of [false, true]) {
    const category = retained ? "recovery" : "persistence";

    it(`reports ${category} failure through the task interface`, async function () {
      const dir = directory();
      const source = await pdf(dir, "source.pdf");
      const zip = await parseZIP(dir);
      const runtime = await runtimeFixture(
        dir,
        "runtime",
        `#!/bin/sh\ncp '${zip}' "$4"\n`,
      );
      const originalZip = Zotero.File.zipDirectory;
      const originalRemove = IOUtils.remove;
      const views: TaskView[] = [];
      try {
        (Zotero.File as any).zipDirectory = async () => {
          throw new Error("injected secret publication detail");
        };
        if (retained) {
          (IOUtils as any).remove = async (
            path: string,
            options?: RemoveOptions,
          ) => {
            if (PathUtils.filename(path).startsWith("tmp-mineru-")) {
              throw new Error("injected secret cleanup detail");
            }
            return originalRemove(path, options);
          };
        }
        const result = await new MineruTaskController().run(
          [source],
          async () => source,
          {
            descriptorPath: runtime.descriptorPath,
            customConfigPath: runtime.configPath,
            options: defaults(),
          },
          (view) => views.push(view),
        );
        assert.isUndefined(result);
        const failed = views.at(-1)!;
        assert.equal(failed.phase, "failed");
        assert.equal(
          failed.failureCategory,
          retained ? "recovery" : "persistence",
        );
        assert.notInclude(failed.message!, "injected secret");
        assert.include(
          await IOUtils.readUTF8(failed.logs!.stderr),
          "injected secret publication detail",
        );
        if (retained) {
          assert.match(failed.message!, /recovery journal was retained/);
          assert.include(
            await IOUtils.readUTF8(failed.logs!.stderr),
            "injected secret cleanup detail",
          );
        } else {
          assert.notInclude(failed.message!, "recovery journal was retained");
        }
      } finally {
        (Zotero.File as any).zipDirectory = originalZip;
        (IOUtils as any).remove = originalRemove;
        assert.deepEqual(await recoverIncompletePublications(), {
          committed: 0,
          rolledBack: retained ? 1 : 0,
        });
        await source.eraseTx();
        dir.remove(true);
      }
    });
  }

  it("reports a retained journal when committed attachment finalization fails", async function () {
    const dir = directory();
    const source = await pdf(dir, "source.pdf");
    const zip = await parseZIP(dir);
    const runtime = await runtimeFixture(
      dir,
      "runtime",
      `#!/bin/sh\ncp '${zip}' "$4"\n`,
    );
    const originalWrite = IOUtils.writeUTF8;
    const before = new Set(
      (await Zotero.Items.getAll(source.libraryID)).map((item) => item.id),
    );
    const views: TaskView[] = [];
    try {
      (IOUtils as any).writeUTF8 = async (
        path: string,
        content: string,
        options?: WriteOptions,
      ) => {
        if (content.includes('"phase":"committed"')) {
          throw new Error("injected secret finalization detail");
        }
        return originalWrite(path, content, options);
      };
      const result = await new MineruTaskController().run(
        [source],
        async () => source,
        {
          descriptorPath: runtime.descriptorPath,
          customConfigPath: runtime.configPath,
          options: defaults(),
        },
        (view) => views.push(view),
      );
      assert.isUndefined(result);
      const failed = views.at(-1)!;
      assert.equal(failed.phase, "failed");
      assert.equal(failed.failureCategory, "recovery");
      assert.match(failed.message!, /completion could not be confirmed/);
      assert.match(failed.message!, /recovery journal was retained/);
      assert.notInclude(failed.message!, "injected secret");
      assert.include(
        await IOUtils.readUTF8(failed.logs!.stderr),
        "injected secret finalization detail",
      );
    } finally {
      (IOUtils as any).writeUTF8 = originalWrite;
      assert.deepEqual(await recoverIncompletePublications(), {
        committed: 1,
        rolledBack: 0,
      });
      const created = (await Zotero.Items.getAll(source.libraryID)).filter(
        (item) => !before.has(item.id),
      );
      for (const item of created) await item.eraseTx();
      await source.eraseTx();
      dir.remove(true);
    }
  });
});
