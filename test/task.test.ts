import { assert } from "chai";
import { config } from "../package.json";
import {
  resolveSelectedPDF,
  MineruTaskController,
} from "../src/modules/mineru/task";
import { createTaskWindow } from "../src/modules/mineru/ui";
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
  // Public UI modules run with the actual plugin toolkit/locale, never doubles.
  const globals = globalThis as unknown as {
    addon?: unknown;
    ztoolkit?: unknown;
  };
  let previousAddon: unknown;
  let previousToolkit: unknown;

  before(function () {
    previousAddon = globals.addon;
    previousToolkit = globals.ztoolkit;
    globals.addon = Zotero[config.addonInstance];
    globals.ztoolkit = (Zotero[config.addonInstance] as any).data.ztoolkit;
  });

  after(function () {
    globals.addon = previousAddon;
    globals.ztoolkit = previousToolkit;
  });

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
    const dir = directory();
    const runtime = await runtimeFixture(
      dir,
      "selection",
      "#!/bin/sh\nexit 99\n",
    );
    const controller = new MineruTaskController();
    let failure = "";
    const views: string[] = [];
    await controller.run(
      [],
      async () => undefined,
      {
        ...runtime,
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
    assert.deepEqual(views, ["preparing", "preparing", "failed"]);
    assert.match(failure, /exactly one/);
    assert.isFalse(controller.busy);
    dir.remove(true);
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
    const runtime = await runtimeFixture(
      dir,
      "lock-runtime",
      "#!/bin/sh\nexit 99\n",
    );
    let selected!: () => void;
    const selectionStarted = new Promise<void>((resolve) => {
      selected = resolve;
    });
    let release!: (item: Zotero.Item) => void;
    const chosen = new Promise<Zotero.Item>((resolve) => {
      release = resolve;
    });
    try {
      const running = controller.run(
        [parent],
        async () => {
          selected();
          return chosen;
        },
        {
          descriptorPath: runtime.descriptorPath,
          customConfigPath: runtime.configPath,
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
      await selectionStarted;
      const count = phases.length;
      controller.shutdown();
      release(second);
      assert.isUndefined(await running);
      assert.equal(phases.length, count);
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
          throw new Error("Upload ZIP failed; api_key=publication-secret", {
            cause: new Error("Native ZIP write refused"),
          });
        };
        if (retained) {
          (IOUtils as any).remove = async (
            path: string,
            options?: RemoveOptions,
          ) => {
            if (PathUtils.filename(path).startsWith("tmp-mineru-")) {
              throw new Error(
                "Staging directory cleanup refused; password=cleanup-secret",
              );
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
        assert.equal(await IOUtils.readUTF8(failed.logs!.stderr), "");
        const records = views.flatMap((view) =>
          view.record ? [view.record] : [],
        );
        const details = records
          .map((record) => record.details || "")
          .join("\n");
        assert.include(details, "Upload ZIP failed");
        assert.include(details, "Native ZIP write refused");
        assert.include(details, "Stack:");
        assert.notInclude(details, "publication-secret");
        assert.notInclude(details, "cleanup-secret");
        assert.equal(
          records.filter(
            (record) => record.stage === "saving" && record.event === "error",
          ).length,
          1,
        );
        assert.isFalse(
          records.some(
            (record) =>
              record.stage === "saving" && record.event === "complete",
          ),
        );
        assert.isFalse(records.some((record) => record.event === "success"));
        if (retained) {
          assert.match(failed.message!, /recovery journal was retained/);
          assert.include(details, "Staging directory cleanup refused");
          assert.equal(records.at(-2)!.stage, "recovery");
          assert.equal(records.at(-2)!.event, "error");
        } else {
          assert.notInclude(failed.message!, "recovery journal was retained");
          assert.equal(records.at(-2)!.stage, "recovery");
          assert.equal(records.at(-2)!.event, "complete");
          assert.include(records.at(-2)!.message, "rolled back");
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

  it("logs synchronously before runtime IO and keeps runtime precedence over zero PDFs", async function () {
    const parent = new Zotero.Item("journalArticle");
    await parent.saveTx();
    const views: TaskView[] = [];
    try {
      const running = new MineruTaskController().run(
        [parent],
        async () => undefined,
        { descriptorPath: "/missing/runtime.json", options: defaults() },
        (view) => views.push(view),
      );
      assert.equal(views[0].record!.stage, "preparing");
      assert.equal(views[0].record!.event, "start");
      await running;
      assert.equal(views.at(-1)!.failureCategory, "environment");
      assert.isUndefined(views.at(-1)!.logs);
      assert.include(views[1].record!.details!, "runtime is not installed");
      assert.isFalse(views.some((view) => view.record?.event === "complete"));
    } finally {
      await parent.eraseTx();
    }
  });

  for (const fault of [
    "download",
    "directory",
    "log",
    "start",
    "validation",
  ] as const) {
    const title = `keeps original safe diagnostics for early ${fault} failure`;

    it(title, async function () {
      const dir = directory();
      const source = await pdf(dir, "source.pdf");
      const runtime = await runtimeFixture(
        dir,
        "runtime",
        fault === "start"
          ? "#!/missing/mineru-interpreter\n"
          : "#!/bin/sh\nprintf 'cli only\\n' >&2\ncp /dev/null \"$4\"\n",
      );
      const originalGetPath = source.getFilePathAsync;
      const originalDownload = (Zotero.Sync.Runner as any).downloadFile;
      const originalTemp = Zotero.getTempDirectory;
      const originalWrite = IOUtils.write;
      const views: TaskView[] = [];
      try {
        if (fault === "download") {
          source.getFilePathAsync = async () => false;
          (Zotero.Sync.Runner as any).downloadFile = async () => {
            throw new Error("Native download refused; api_key=hidden-value", {
              cause: new Error("Safe network cause"),
            });
          };
        }
        if (fault === "directory")
          Zotero.getTempDirectory = () => {
            throw new Error("Temporary root access refused");
          };
        if (fault === "log")
          (IOUtils as any).write = async (
            path: string,
            bytes: Uint8Array,
            options?: WriteOptions,
          ) => {
            if (PathUtils.filename(path) === "stderr.log")
              throw new Error("Log file create refused");
            return originalWrite(path, bytes, options);
          };
        await new MineruTaskController().run(
          [source],
          async () => source,
          {
            descriptorPath: runtime.descriptorPath,
            customConfigPath: runtime.configPath,
            options: defaults(),
          },
          (view) => views.push(view),
        );
        const records = views.flatMap((view) =>
          view.record ? [view.record] : [],
        );
        const failedStage =
          fault === "start"
            ? "parsing"
            : fault === "validation"
              ? "validation"
              : "preparing";
        assert.equal(records.at(-2)!.stage, failedStage);
        assert.equal(records.at(-2)!.event, "error");
        assert.equal(records.at(-1)!.event, "failure");
        assert.isFalse(
          records.some(
            (record) =>
              record.stage === failedStage && record.event === "complete",
          ),
        );
        assert.isNotEmpty(records.at(-2)!.details);
        assert.notInclude(
          records.map((record) => record.details || "").join("\n"),
          "hidden-value",
        );
        if (fault === "download")
          assert.include(records.at(-2)!.details!, "Safe network cause");
        if (fault === "validation")
          assert.equal(
            await IOUtils.readUTF8(views.at(-1)!.logs!.stderr),
            "cli only\n",
          );
      } finally {
        source.getFilePathAsync = originalGetPath;
        (Zotero.Sync.Runner as any).downloadFile = originalDownload;
        Zotero.getTempDirectory = originalTemp;
        (IOUtils as any).write = originalWrite;
        await source.eraseTx();
        dir.remove(true);
      }
    });
  }

  it("logs real stage order through confirmed publication and keeps CLI streams pure", async function () {
    const dir = directory();
    const source = await pdf(dir, "source.pdf");
    const zip = await parseZIP(dir);
    const runtime = await runtimeFixture(
      dir,
      "runtime",
      `#!/bin/sh\nprintf 'CLI stdout\\n'\nprintf 'CLI stderr\\n' >&2\ncp '${zip}' "$4"\n`,
    );
    let result: Zotero.Item | undefined;
    const views: TaskView[] = [];
    try {
      result = await new MineruTaskController().run(
        [source],
        async () => source,
        {
          descriptorPath: runtime.descriptorPath,
          customConfigPath: runtime.configPath,
          options: defaults(),
        },
        (view) => views.push(view),
      );
      assert.isDefined(result);
      const records = views.flatMap((view) =>
        view.record ? [view.record] : [],
      );
      assert.deepEqual(
        records.map((record) => `${record.stage}:${record.event}`),
        [
          "preparing:start",
          "preparing:complete",
          "parsing:start",
          "parsing:complete",
          "validation:start",
          "validation:complete",
          "saving:start",
          "saving:complete",
          "task:success",
        ],
      );
      assert.isTrue(
        records.every((record) =>
          Number.isFinite(Date.parse(record.timestamp)),
        ),
      );
      assert.equal(
        await IOUtils.readUTF8(views.at(-1)!.logs!.stdout),
        "CLI stdout\n",
      );
      assert.equal(
        await IOUtils.readUTF8(views.at(-1)!.logs!.stderr),
        "CLI stderr\n",
      );
      assert.equal(views.at(-1)!.result!.id, result!.id);
    } finally {
      if (result) await result.eraseTx();
      await source.eraseTx();
      dir.remove(true);
    }
  });

  it("excludes config/environment payloads and arbitrary object fields from safe original causes", async function () {
    const dir = directory();
    const source = await pdf(dir, "source.pdf");
    const runtime = await runtimeFixture(
      dir,
      "runtime",
      "#!/bin/sh\nexit 99\n",
    );
    const originalPath = source.getFilePathAsync;
    const views: TaskView[] = [];
    try {
      source.getFilePathAsync = async () => {
        const cause = new Error(
          "Safe source IO cause\nllm: full-config-secret\nAPI_KEY=full-env-secret",
        );
        (cause as any).configuration = { key: "arbitrary-object-secret" };
        throw new Error(
          "Source lookup refused; api_key=inline-secret https://user:pass@example.org/check?token=url-secret",
          { cause },
        );
      };
      await new MineruTaskController().run(
        [source],
        async () => source,
        {
          descriptorPath: runtime.descriptorPath,
          customConfigPath: runtime.configPath,
          options: defaults(),
        },
        (view) => views.push(view),
      );
      const details = views
        .map((view) => view.record?.details || "")
        .join("\n");
      assert.include(details, "Source lookup refused");
      assert.include(details, "Safe source IO cause");
      for (const value of [
        "inline-secret",
        "url-secret",
        "user:pass",
        "full-config-secret",
        "full-env-secret",
        "arbitrary-object-secret",
      ])
        assert.notInclude(details, value);
    } finally {
      source.getFilePathAsync = originalPath;
      await source.eraseTx();
      dir.remove(true);
    }
  });

  it("stops the actual child and sends no late updates or publication after task shutdown", async function () {
    const dir = directory();
    const source = await pdf(dir, "source.pdf");
    const runtime = await runtimeFixture(
      dir,
      "runtime",
      "#!/bin/sh\nexec sleep 10\n",
    );
    const controller = new MineruTaskController();
    const views: TaskView[] = [];
    let started!: () => void;
    const parsing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const before = (await Zotero.Items.getAll(source.libraryID))
      .map((item) => item.id)
      .sort();
    try {
      const running = controller.run(
        [source],
        async () => source,
        {
          descriptorPath: runtime.descriptorPath,
          customConfigPath: runtime.configPath,
          options: defaults(),
        },
        (view) => {
          views.push(view);
          if (view.phase === "parsing") started();
        },
      );
      await parsing;
      await Zotero.Promise.delay(50);
      const count = views.length;
      controller.shutdown();
      assert.isUndefined(await running);
      assert.equal(views.length, count);
      assert.isFalse(controller.busy);
      assert.deepEqual(
        (await Zotero.Items.getAll(source.libraryID))
          .map((item) => item.id)
          .sort(),
        before,
      );
    } finally {
      await source.eraseTx();
      dir.remove(true);
    }
  });

  it("renders append-only selectable details, copies them, pauses/resumes scrolling and detaches on close", async function () {
    const before = new Set(Array.from(Services.wm.getEnumerator(null)));
    const report = createTaskWindow();
    let win: Window | undefined;
    const originalCopy = Zotero.Utilities.Internal.copyTextToClipboard;
    let copied = "";
    try {
      const deadline = Date.now() + 10000;
      while (!win && Date.now() < deadline) {
        win = Array.from(Services.wm.getEnumerator(null)).find(
          (candidate) =>
            !before.has(candidate) &&
            candidate.document.getElementById("mineru-plugin-log"),
        );
        if (!win) await Zotero.Promise.delay(30);
      }
      assert.isDefined(win);
      const log = win!.document.getElementById("mineru-plugin-log")!;
      const send = (index: number) =>
        report({
          phase: "failed",
          record: {
            timestamp: new Date().toISOString(),
            stage: "preparing",
            event: "error",
            message: `Safe exception ${index}`,
            details: "Safe original message\nCause: native failure",
          },
        });
      for (let index = 0; index < 35; index++) send(index);
      await Zotero.Promise.delay(100);
      assert.equal(log.children.length, 35);
      assert.equal((log as HTMLElement).style.userSelect, "text");
      assert.isAtMost(log.scrollHeight - log.clientHeight - log.scrollTop, 4);
      log.scrollTop = 0;
      log.dispatchEvent(new win!.Event("scroll"));
      send(35);
      assert.equal(log.scrollTop, 0);
      log.scrollTop = log.scrollHeight;
      log.dispatchEvent(new win!.Event("scroll"));
      send(36);
      assert.isAtMost(log.scrollHeight - log.clientHeight - log.scrollTop, 4);
      const details = log.querySelector("details") as HTMLDetailsElement;
      assert.isFalse(details.open);
      details.open = true;
      assert.include(details.textContent!, "Safe original message");
      details.open = false;
      Zotero.Utilities.Internal.copyTextToClipboard = (text: string) => {
        copied = text;
      };
      (win!.document.getElementById("copy") as HTMLButtonElement).click();
      assert.include(copied, "Safe exception 0");
      assert.include(copied, "Safe exception 36");
      assert.include(copied, "Cause: native failure");
      assert.isTrue(
        (win!.document.getElementById("result") as HTMLButtonElement).hidden,
      );
      win!.close();
      await Zotero.Promise.delay(100);
      assert.equal(
        log.children.length,
        0,
        "close releases details from the window DOM",
      );
      send(37);
      assert.equal(
        log.children.length,
        0,
        "late reports retain no closed-window history",
      );
    } finally {
      Zotero.Utilities.Internal.copyTextToClipboard = originalCopy;
      win?.close();
    }
  });

  it("continues publication after its active window closes without recreating it", async function () {
    const dir = directory();
    const source = await pdf(dir, "source.pdf");
    const zip = await parseZIP(dir);
    const runtime = await runtimeFixture(
      dir,
      "runtime",
      `#!/bin/sh\nsleep 1\ncp '${zip}' "$4"\n`,
    );
    const before = new Set(Array.from(Services.wm.getEnumerator(null)));
    const report = createTaskWindow();
    let result: Zotero.Item | undefined;
    let win: Window | undefined;
    let parsing!: () => void;
    const started = new Promise<void>((resolve) => {
      parsing = resolve;
    });
    try {
      const running = new MineruTaskController().run(
        [source],
        async () => source,
        {
          descriptorPath: runtime.descriptorPath,
          customConfigPath: runtime.configPath,
          options: defaults(),
        },
        (view) => {
          report(view);
          if (view.phase === "parsing") parsing();
        },
      );
      await started;
      const deadline = Date.now() + 10000;
      while (!win && Date.now() < deadline) {
        win = Array.from(Services.wm.getEnumerator(null)).find(
          (candidate) =>
            !before.has(candidate) &&
            candidate.document.getElementById("mineru-plugin-log"),
        );
        if (!win) await Zotero.Promise.delay(30);
      }
      assert.isDefined(win);
      win!.close();
      result = await running;
      assert.isDefined(result);
      assert.isFalse(
        Array.from(Services.wm.getEnumerator(null)).some(
          (candidate) =>
            !before.has(candidate) &&
            candidate.document.getElementById("mineru-plugin-log"),
        ),
      );
    } finally {
      win?.close();
      if (result) await result.eraseTx();
      await source.eraseTx();
      dir.remove(true);
    }
  });

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
          throw new Error("Journal flush failed; token=finalization-secret");
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
      assert.equal(await IOUtils.readUTF8(failed.logs!.stderr), "");
      const details = views
        .map((view) => view.record?.details || "")
        .join("\n");
      assert.include(details, "Journal flush failed");
      assert.notInclude(details, "finalization-secret");
      assert.isTrue(
        views.some((view) =>
          view.record?.message.includes("finalization is incomplete"),
        ),
      );

      assert.isFalse(views.some((view) => view.record?.event === "success"));
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
