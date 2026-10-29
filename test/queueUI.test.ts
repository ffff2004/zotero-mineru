import { assert } from "chai";
import { config } from "../package.json";
import manifest from "../runtime/release.json";
import type { MineruTaskService } from "../src/modules/mineru/service";
import { registerLocalAPI, localAPIBase } from "../src/modules/mineru/localAPI";

async function waitFor(
  check: () => boolean,
  message = "UI operation completed",
) {
  const deadline = Date.now() + 15000;
  while (!check() && Date.now() < deadline) await Zotero.Promise.delay(20);
  assert.isTrue(check(), message);
}

function findQueue(): Window | undefined {
  return Array.from(Services.wm.getEnumerator(null)).find((win) =>
    win.document?.getElementById("mineru-queue"),
  );
}

/** Public menu/DOM + real singleton, database, durable storage and fixture process. */
describe("MinerU queue window", function () {
  this.timeout(60000);
  let main: _ZoteroTypes.MainWindow;
  let service: MineruTaskService;
  let dir: nsIFile;
  let parent: Zotero.Item;
  let missing: Zotero.Item;
  let ambiguous: Zotero.Item;
  let source: Zotero.Item;
  const saved = new Map<string, unknown>();
  let queue: Window | undefined;
  let unregister: (() => void) | undefined;
  const alerts: string[] = [];
  let originalAlert: typeof main.alert;
  const command = (suffix: string) => {
    const id =
      suffix === "queue"
        ? `zotero-toolsmenu-${config.addonRef}-queue`
        : `zotero-itemmenu-${config.addonRef}-run`;
    const menu = main.document.getElementById(id);
    assert.isNotNull(menu);
    menu!.dispatchEvent(new main.Event("command"));
  };
  const click = (id: string) => {
    const button = queue!.document.getElementById(id) as HTMLButtonElement;
    assert.isNotNull(button, id);
    assert.isFalse(button.disabled, id);
    button.click();
  };
  const taskButton = (id: string, action: string) =>
    `mineru-queue-task-${id}-${action}`;
  const order = () => service.getQueue().pending.map((task) => task.taskID);
  const displayed = () =>
    Array.from(
      queue!.document.querySelectorAll("#mineru-queue-pending > li"),
    ).map((node) => (node as HTMLElement).dataset.taskId);
  const synced = () =>
    waitFor(() => JSON.stringify(displayed()) === JSON.stringify(order()));
  const http = async (method: string, route: string, body?: unknown) => {
    const port = Zotero.Prefs.get("httpServer.port");
    const response = await Zotero.HTTP.request(
      method,
      `http://127.0.0.1:${port}${localAPIBase}/${route}`,
      {
        headers: {
          "Zotero-Allowed-Request": "1",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        successCodes: false,
      },
    );
    assert.isBelow(response.status, 300, response.responseText);
    return JSON.parse(response.responseText);
  };
  const submit = async (pdf = source) =>
    service.submit({
      requestID: crypto.randomUUID(),
      source: { libraryID: pdf.libraryID, itemKey: pdf.key },
      force: true,
    });
  const importPDF = (parentItemID?: number) =>
    Zotero.Attachments.importFromFile({
      file: Zotero.File.pathToFile(PathUtils.join(dir.path, "paper.pdf")),
      parentItemID,
      title: "Full text PDF",
      contentType: "application/pdf",
    });
  const openQueueFor = async (taskID: string) => {
    command("queue");
    await waitFor(
      () =>
        !!findQueue()?.document.getElementById(taskButton(taskID, "source")),
      "queued PDF has a source link",
    );
    queue = findQueue()!;
  };
  const sourceLink = (taskID: string) =>
    queue!.document.getElementById(
      taskButton(taskID, "source"),
    ) as HTMLAnchorElement;
  const assertSource = (
    taskID: string,
    pdf: Pick<Zotero.Item, "libraryID" | "key">,
    title: string,
  ) => {
    const label = queue!.document.getElementById(taskButton(taskID, "label"))!;
    const link = sourceLink(taskID);
    assert.equal(label.localName, "p");
    assert.equal(link.localName, "a");
    assert.strictEqual(link.parentElement, label);
    assert.equal(link.textContent, `${title} — ${pdf.libraryID}/${pdf.key}`);
    assert.equal(
      link.getAttribute("href"),
      `zotero://open-pdf/library/items/${pdf.key}`,
      "source URI targets the exact attachment, not its parent or a sibling",
    );
  };
  const withReaderSpy = async (check: (opened: number[]) => Promise<void>) => {
    const originalOpen = Zotero.Reader.open;
    const opened: number[] = [];
    // The fixture is intentionally not a readable PDF; only replace the
    // external reader boundary, not source lookup or filesystem validation.
    Zotero.Reader.open = async (itemID) => {
      opened.push(itemID);
    };
    try {
      await check(opened);
    } finally {
      Zotero.Reader.open = originalOpen;
    }
  };

  const unavailableSource = async (
    unavailable: "deleted" | "missing file" | "erased",
  ) => {
    const paper = new Zotero.Item("journalArticle");
    paper.setField("title", "Unavailable queue source");
    await paper.saveTx();
    try {
      const sibling = await importPDF(paper.id);
      const pdf = await importPDF(paper.id);
      const task = await submit(pdf);
      await openQueueFor(task.taskID);
      const originalPath = pdf.attachmentPath;
      const identity = { id: pdf.id, libraryID: pdf.libraryID, key: pdf.key };
      if (unavailable === "deleted") {
        pdf.deleted = true;
        await pdf.saveTx();
      } else if (unavailable === "missing file") {
        const path = await pdf.getFilePathAsync();
        assert.equal(
          path,
          PathUtils.join(
            Zotero.Attachments.getStorageDirectory(pdf).path,
            "paper.pdf",
          ),
          "only remove this disposable attachment's imported PDF",
        );
        await IOUtils.remove(path as string);
      } else {
        await pdf.eraseTx();
        await waitFor(
          () =>
            sourceLink(task.taskID)?.textContent ===
            `${identity.key} — ${identity.libraryID}/${identity.key}`,
          "an erased source falls back to its durable item key",
        );
        assertSource(task.taskID, identity, identity.key);
      }
      await withReaderSpy(async (opened) => {
        sourceLink(task.taskID).click();
        // Assert the en-US user-visible message, not a source-module locale
        // helper whose addon global belongs to a different test sandbox.
        const localized = "The source PDF is no longer available.";
        await waitFor(
          () =>
            !!queue!.document
              .getElementById("mineru-queue-error")!
              .textContent?.includes(localized),
          "missing source is reported in the queue's visible error region",
        );
        assert.isEmpty(opened, "never opens the missing PDF or its sibling");
        assert.equal(service.getTask(task.taskID).source.itemKey, identity.key);
        assert.equal(service.getTask(task.taskID).state, "queued");
        assert.isTrue(await sibling.fileExists());
        if (unavailable !== "erased") {
          const unchanged = await Zotero.Items.getByLibraryAndKeyAsync(
            pdf.libraryID,
            pdf.key,
          );
          assert.equal(unchanged.id, pdf.id);
          assert.equal(unchanged.attachmentPath, originalPath);
        }
      });
    } finally {
      await paper.eraseTx();
    }
  };

  before(async function () {
    main = Zotero.getMainWindow();
    service = (Zotero[config.addonInstance] as any).api;
    await service.pause();
    assert.isEmpty(service.getQueue().pending);
    originalAlert = main.alert;
    main.alert = (message?: unknown) => {
      alerts.push(String(message));
    };
    dir = Zotero.getTempDirectory();
    dir.append("mineru-queue-ui");
    dir.createUnique(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
    const contents = PathUtils.join(dir.path, "contents");
    await IOUtils.makeDirectory(contents);
    await IOUtils.writeUTF8(
      PathUtils.join(contents, "markdown.md"),
      "# Queue UI fixture\n",
    );
    await IOUtils.writeUTF8(
      PathUtils.join(contents, "middle_json.json"),
      JSON.stringify({
        schema: "docvortex.middle",
        schema_version: "2.0",
        metadata: {
          file_suffix: "pdf",
          producer: {
            name: "MinerU",
            version: manifest.packages.mineru.version,
          },
        },
        extensions: { mineru: { tier: "standard", parse_mode: "txt" } },
        pages: [],
        is_full_document: true,
      }),
    );
    const zip = PathUtils.join(dir.path, "result.zip");
    await Zotero.File.zipDirectory(contents, zip, null);
    const python = PathUtils.join(dir.path, "python");
    const cli = PathUtils.join(dir.path, "mineru-kit");
    await IOUtils.writeUTF8(python, "fixture");
    await IOUtils.writeUTF8(
      cli,
      `#!/bin/sh\nprintf 'started\\n' >> '${dir.path}/calls'\nwhile [ ! -f '${dir.path}/release' ]; do sleep 0.05; done\ncp '${zip}' "$4"\n`,
    );
    for (const file of [python, cli])
      Zotero.File.pathToFile(file).permissions = 0o755;
    const packages: Record<string, { version: string; metadata_path: string }> =
      {};
    for (const name of ["mineru", "docvortex"] as const) {
      const metadata_path = PathUtils.join(
        dir.path,
        `${name}.dist-info`,
        "METADATA",
      );
      await IOUtils.makeDirectory(PathUtils.parent(metadata_path)!);
      const version = manifest.packages[name].version;
      await IOUtils.writeUTF8(
        metadata_path,
        `Name: ${name}\nVersion: ${version}\n\n`,
      );
      packages[name] = { version, metadata_path };
    }
    const descriptor = PathUtils.join(dir.path, "runtime.json");
    await IOUtils.writeUTF8(
      descriptor,
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
    const configPath = PathUtils.join(dir.path, "config.yaml");
    await IOUtils.writeUTF8(configPath, "{}\n");
    for (const [key, value] of Object.entries({
      runtimeDescriptor: descriptor,
      configPath,
      queueLimit: 10,
      tier: "standard",
      ocrMode: "auto",
      imageAnalysis: true,
      pageRange: "all",
    })) {
      const full = `${config.prefsPrefix}.${key}`;
      saved.set(full, Zotero.Prefs.get(full, true));
      Zotero.Prefs.set(full, value, true);
    }
    const paper = PathUtils.join(dir.path, "paper.pdf");
    await IOUtils.writeUTF8(paper, "%PDF-1.4\n%%EOF\n");
    for (const title of ["Queue valid", "Queue missing", "Queue ambiguous"]) {
      const item = new Zotero.Item("journalArticle");
      item.setField("title", title);
      await item.saveTx();
      if (title === "Queue valid") parent = item;
      else if (title === "Queue missing") missing = item;
      else ambiguous = item;
    }
    for (const item of [parent, ambiguous, ambiguous]) {
      const pdf = await Zotero.Attachments.importFromFile({
        file: Zotero.File.pathToFile(paper),
        parentItemID: item.id,
        contentType: "application/pdf",
      });
      if (item === parent) source = pdf;
    }
    unregister = registerLocalAPI(service);
  });

  afterEach(async function () {
    await service.pause();
    for (const task of service.getQueue().pending)
      await service.cancel(task.taskID);
    const active = service.getQueue().activeTaskID;
    if (active) {
      await service.cancel(active);
      await waitFor(() => !service.getQueue().activeTaskID);
    }
    queue?.close();
    queue = undefined;
    for (const win of Services.wm.getEnumerator(null))
      if (win.document?.getElementById("mineru-plugin-log")) win.close();
  });

  after(async function () {
    unregister?.();
    main.alert = originalAlert;
    for (const [key, value] of saved) {
      if (value === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, value as string, true);
    }
    for (const item of [parent, missing, ambiguous]) await item.eraseTx();
    dir.remove(true);
  });

  it("preserves the single-parent PDF chooser and queues only the chosen child without a premature execution log", async function () {
    let choices: string[] = [];
    let chooserError: unknown;
    const observer = {
      observe(subject: nsISupports) {
        const win = subject as unknown as Window;
        try {
          const list = win.document.getElementById("list") as XUL.RichListBox;
          choices = Array.from(list.children).map(
            (node) => node.textContent || "",
          );
          list.selectedIndex = 1;
          list.children[1].dispatchEvent(
            new win.MouseEvent("dblclick", { bubbles: true }),
          );
        } catch (error) {
          chooserError = error;
          win.close();
        }
      },
    };
    Services.obs.addObserver(observer, "select-dialog-loaded");
    try {
      await main.ZoteroPane.selectItem(ambiguous.id);
      command("run");
      await waitFor(() => order().length === 1);
      assert.isUndefined(chooserError, String(chooserError));
      assert.lengthOf(choices, 2);
      const pdfs = (await Zotero.Items.getAsync(
        ambiguous.getAttachments(false),
      )) as Zotero.Item[];
      assert.equal(service.getQueue().pending[0].source.itemKey, pdfs[1].key);
      assert.isTrue(service.getQueue().paused);
      assert.isFalse(
        Array.from(Services.wm.getEnumerator(null)).some(
          (win) => !!win.document?.getElementById("mineru-plugin-log"),
        ),
        "queued work has no execution-only TaskView log yet",
      );
      queue = findQueue();
    } finally {
      Services.obs.removeObserver(observer, "select-dialog-loaded");
    }
  });

  it("labels a child PDF with its bibliographic parent title and opens that exact attachment after row replacement", async function () {
    const paper = new Zotero.Item("journalArticle");
    paper.setField("title", "Queue source <paper> & citation");
    await paper.saveTx();
    try {
      const sibling = await importPDF(paper.id);
      const pdf = await importPDF(paper.id);
      const task = await submit(pdf);
      await openQueueFor(task.taskID);
      assertSource(task.taskID, pdf, "Queue source <paper> & citation");
      assert.notEqual(pdf.id, sibling.id);
      assert.isNull(sourceLink(task.taskID).querySelector("paper"));
      await withReaderSpy(async (opened) => {
        const originalLink = sourceLink(task.taskID);
        originalLink.click();
        await waitFor(() => opened.length === 1);
        assert.deepEqual(opened, [pdf.id]);
        await waitFor(() => sourceLink(task.taskID) !== originalLink);
        sourceLink(task.taskID).click();
        await waitFor(() => opened.length === 2);
        assert.deepEqual(opened, [pdf.id, pdf.id]);
      });
    } finally {
      await paper.eraseTx();
    }
  });

  it("falls back to a standalone attachment title and then its filename", async function () {
    const pdf = await importPDF();
    try {
      pdf.setField("title", "Standalone source title");
      await pdf.saveTx();
      const task = await submit(pdf);
      await openQueueFor(task.taskID);
      assertSource(task.taskID, pdf, "Standalone source title");
      pdf.setField("title", "");
      await pdf.saveTx();
      await waitFor(
        () =>
          sourceLink(task.taskID)?.textContent ===
          `paper.pdf — ${pdf.libraryID}/${pdf.key}`,
        "an empty attachment title falls back to the actual filename",
      );
      assertSource(task.taskID, pdf, "paper.pdf");
    } finally {
      await pdf.eraseTx();
    }
  });

  it("uses the attachment title when its bibliographic parent title is empty", async function () {
    const paper = new Zotero.Item("journalArticle");
    await paper.saveTx();
    try {
      const pdf = await importPDF(paper.id);
      const task = await submit(pdf);
      await openQueueFor(task.taskID);
      assertSource(task.taskID, pdf, "Full text PDF");
    } finally {
      await paper.eraseTx();
    }
  });

  it("reports a localized error for a deleted PDF without opening or replacing it", async function () {
    await unavailableSource("deleted");
  });

  it("reports a localized error for a missing-file PDF without opening or replacing it", async function () {
    await unavailableSource("missing file");
  });

  it("falls back to an erased PDF key and reports an error without opening its sibling", async function () {
    await unavailableSource("erased");
  });

  it("opens with no selection, shares HTTP/menu order, exposes atomic batch errors and stale moves, detaches its interval", async function () {
    await main.ZoteroPane.selectItems([]);
    command("queue");
    await waitFor(
      () => !!findQueue()?.document.getElementById("mineru-queue-resume"),
    );
    queue = findQueue()!;
    command("queue");
    assert.strictEqual(findQueue(), queue, "one maintained window");
    assert.include(
      queue.document.getElementById("mineru-queue-status")!.textContent!,
      "Paused",
    );
    const a = await http("POST", "tasks", {
      requestID: crypto.randomUUID(),
      source: { libraryID: source.libraryID, itemKey: source.key },
    });
    await main.ZoteroPane.selectItems([parent.id, missing.id, ambiguous.id]);
    alerts.length = 0;
    command("run");
    await waitFor(() => alerts.length === 1);
    assert.include(alerts[0], "Submitted 1");
    assert.include(alerts[0], "missing_pdf");
    assert.include(alerts[0], "multiple_pdfs");
    assert.lengthOf(order(), 2);
    assert.isTrue(service.getQueue().paused);
    const b = order()[1];
    const c = (await submit()).taskID;
    await synced();
    click(taskButton(c, "up"));
    await waitFor(() => order().join() === [a.taskID, c, b].join());
    await synced();
    click(taskButton(c, "top"));
    await waitFor(() => order()[0] === c);
    await synced();
    click(taskButton(c, "down"));
    await waitFor(() => order()[1] === c);
    assert.deepEqual(
      (await http("GET", "queue")).pending.map(
        (t: { taskID: string }) => t.taskID,
      ),
      order(),
    );
    Zotero.Prefs.set(`${config.prefsPrefix}.queueLimit`, 2, true);
    assert.lengthOf(
      order(),
      3,
      "lowering the live limit never discards existing work",
    );
    alerts.length = 0;
    command("run");
    await waitFor(() => alerts.length === 1);
    assert.include(alerts[0], "queue_full");
    assert.include(alerts[0], "0 available");
    assert.include(alerts[0], "multiple_pdfs");
    assert.lengthOf(
      order(),
      3,
      "no partial valid-subset admission at capacity",
    );
    Zotero.Prefs.set(`${config.prefsPrefix}.queueLimit`, 10, true);
    await synced();
    // Queue both public mutations in this same JS turn, so no timer race or
    // wall-clock assumption determines whether the old target is still visible.
    const cancelling = service.cancel(b);
    click(taskButton(c, "down"));
    await cancelling;
    await waitFor(
      () =>
        !!queue!.document
          .getElementById("mineru-queue-error")!
          .textContent?.includes("task_not_queued"),
    );
    await synced();
    click(taskButton(c, "cancel"));
    await waitFor(() => service.getTask(c).state === "cancelled");
    await synced();
    let cleared = 0;
    const clear = queue.clearInterval.bind(queue);
    queue.clearInterval = (id?: number) => {
      cleared++;
      clear(id);
    };
    queue.close();
    assert.isAbove(cleared, 0, "explicitly clears the polling timer on close");
    assert.isTrue(service.getQueue().paused);
    assert.deepEqual(
      order(),
      [a.taskID],
      "closing does not cancel pending work",
    );
    command("queue");
    await waitFor(
      () => !!findQueue()?.document.getElementById("mineru-queue-resume"),
    );
    queue = findQueue()!;
    await synced();
    assert.deepEqual(displayed(), [a.taskID]);
  });

  it("pause preserves the active process, menu enqueues while busy, active cancel is separate, closing does not stop execution", async function () {
    const a = await submit();
    const b = await submit();
    command("queue");
    await waitFor(
      () => !!findQueue()?.document.getElementById("mineru-queue-resume"),
    );
    queue = findQueue()!;
    click("mineru-queue-resume");
    await waitFor(() => service.getTask(a.taskID).phase === "parsing");
    await waitFor(
      () => !!queue!.document.getElementById(taskButton(a.taskID, "cancel")),
    );
    click("mineru-queue-pause");
    await waitFor(() => service.getQueue().paused);
    assert.equal(
      service.getQueue().activeTaskID,
      a.taskID,
      "pause does not release the active slot",
    );
    await main.ZoteroPane.selectItem(source.id);
    command("run");
    await waitFor(() => order().length === 2);
    assert.equal(service.getTask(a.taskID).state, "running");
    assert.isTrue(service.getQueue().paused, "menu never implicitly resumes");
    const menuTask = order()[1];
    await synced();
    click(taskButton(menuTask, "cancel"));
    await waitFor(() => service.getTask(menuTask).state === "cancelled");
    assert.equal(service.getQueue().activeTaskID, a.taskID);
    click(taskButton(a.taskID, "cancel"));
    await waitFor(() => !service.getQueue().activeTaskID);
    assert.equal(service.getTask(a.taskID).state, "cancelled");
    assert.equal(service.getTask(b.taskID).state, "queued");
    await waitFor(
      () =>
        !(
          queue!.document.getElementById(
            "mineru-queue-resume",
          ) as HTMLButtonElement
        ).disabled,
    );
    click("mineru-queue-resume");
    await waitFor(() => service.getTask(b.taskID).phase === "parsing");
    queue.close();
    await IOUtils.writeUTF8(PathUtils.join(dir.path, "release"), "continue\n");
    await waitFor(
      () =>
        service.getTask(b.taskID).state === "succeeded" &&
        !service.getQueue().activeTaskID,
      "task succeeds with a closed queue view",
    );
    command("queue");
    await waitFor(
      () =>
        !!findQueue()?.document.getElementById(
          `mineru-queue-history-${b.taskID}-result`,
        ),
    );
    queue = findQueue()!;
    assert.include(
      queue.document.querySelector("#mineru-queue-recent")!.textContent!,
      b.taskID,
    );
    const runtimeKey = `${config.prefsPrefix}.runtimeDescriptor`;
    const descriptor = Zotero.Prefs.get(runtimeKey, true);
    Zotero.Prefs.set(runtimeKey, "/nonexistent/runtime.json", true);
    click(`mineru-queue-history-${b.taskID}-result`);
    await waitFor(
      () =>
        main.ZoteroPane.getSelectedItems()[0]?.key ===
        service.getTask(b.taskID).result!.itemKey,
    );
    Zotero.Prefs.set(runtimeKey, descriptor as string, true);
  });
});
