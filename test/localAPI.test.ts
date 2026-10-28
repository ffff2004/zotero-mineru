import { assert } from "chai";
import { config } from "../package.json";
import manifest from "../runtime/release.json";
import {
  MineruTaskService,
  type TaskRecord,
} from "../src/modules/mineru/service";
import { localAPIBase, registerLocalAPI } from "../src/modules/mineru/localAPI";
import { MineruAPIError } from "../src/modules/mineru/apiError";

async function fixture(scriptDelay = "", paused = false) {
  const dir = Zotero.getTempDirectory();
  dir.append("mineru-api-test");
  dir.createUnique(Components.interfaces.nsIFile.DIRECTORY_TYPE!, 0o700);
  const bin = PathUtils.join(dir.path, "bin");
  await IOUtils.makeDirectory(bin);
  const contents = PathUtils.join(dir.path, "contents");
  await IOUtils.makeDirectory(contents);
  await IOUtils.writeUTF8(
    PathUtils.join(contents, "markdown.md"),
    "# Test paper\n",
  );
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
  const zip = PathUtils.join(dir.path, "result.zip");
  await Zotero.File.zipDirectory(contents, zip, null);
  const python = PathUtils.join(bin, "python");
  const cli = PathUtils.join(bin, "mineru-kit");
  await IOUtils.writeUTF8(python, "fixture");
  await IOUtils.writeUTF8(
    cli,
    `#!/bin/sh\nprintf 'called\\n' >> '${dir.path}/calls'\n${scriptDelay}\ncp '${zip}' "$4"\n`,
  );
  Zotero.File.pathToFile(python).permissions = 0o755;
  Zotero.File.pathToFile(cli).permissions = 0o755;
  const packages: Record<string, { version: string; metadata_path: string }> =
    {};
  for (const name of ["mineru", "docvortex"] as const) {
    const metadata_path = PathUtils.join(
      dir.path,
      "site",
      `${name}.dist-info`,
      "METADATA",
    );
    await IOUtils.makeDirectory(PathUtils.parent(metadata_path)!, {
      createAncestors: true,
    });
    const version = manifest.packages[name].version;
    await IOUtils.writeUTF8(
      metadata_path,
      `Name: ${name}\nVersion: ${version}\n\n`,
    );
    packages[name] = { version, metadata_path };
  }
  const descriptorPath = PathUtils.join(dir.path, "runtime.json");
  const configPath = PathUtils.join(dir.path, "config.yaml");
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
  await IOUtils.writeUTF8(configPath, "{}\n");
  const parent = new Zotero.Item("journalArticle");
  parent.setField("title", "Local API test paper");
  await parent.saveTx();
  const path = PathUtils.join(dir.path, "paper.pdf");
  await IOUtils.writeUTF8(path, "%PDF-1.4\n%%EOF\n");
  const source = await Zotero.Attachments.importFromFile({
    file: Zotero.File.pathToFile(path),
    parentItemID: parent.id,
    contentType: "application/pdf",
  });
  const saved = new Map<string, unknown>();
  for (const [name, value] of Object.entries({
    runtimeDescriptor: descriptorPath,
    configPath,
    tier: "standard",
    ocrMode: "auto",
    imageAnalysis: true,
    pageRange: "all",
    queueLimit: 10,
  })) {
    const key = `${config.prefsPrefix}.${name}`;
    saved.set(key, Zotero.Prefs.get(key, true));
    Zotero.Prefs.set(key, value, true);
  }
  const storageRoot = PathUtils.join(dir.path, "queue");
  const service = new MineruTaskService({ storageRoot });
  await service.initialize();
  if (!paused) await service.resume();
  const sourceID = { libraryID: source.libraryID, itemKey: source.key };
  return {
    dir,
    storageRoot,
    descriptorPath,
    source,
    parent,
    service,
    sourceID,
    configPath,
    async clean() {
      if (
        (await service.status()).plugin.ready &&
        (await service.status()).recoveryReady &&
        (await service.status()).storageReady
      ) {
        await service.pause();
        for (const record of service.getQueue().pending)
          await service.cancel(record.taskID);
        const active = service.getQueue().activeTaskID;
        if (active) {
          await service.cancel(active);
          await terminal(service, active);
        }
      }
      service.shutdown();
      for (const [key, value] of saved) {
        if (value === undefined) Zotero.Prefs.clear(key, true);
        else Zotero.Prefs.set(key, value as string | boolean, true);
      }
      await parent.eraseTx();
      dir.remove(true);
    },
  };
}

async function terminal(
  service: MineruTaskService,
  taskID: string,
): Promise<TaskRecord> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const task = service.get(taskID);
    if (
      ["succeeded", "failed", "cancelled", "interrupted"].includes(task.state)
    ) {
      while (service.busy && Date.now() < deadline)
        await Zotero.Promise.delay(10);
      return service.get(taskID);
    }
    await Zotero.Promise.delay(20);
  }
  throw new Error(`Task did not finish: ${taskID}`);
}

describe("MinerU shared task service and local HTTP API", function () {
  this.timeout(120000);

  it("publishes once, replays requests, reuses valid results, and retains superseded results", async function () {
    const f = await fixture();
    try {
      const request = { requestID: "first", source: f.sourceID };
      const submitted = await f.service.submit(request);
      const repeated = await f.service.submit(request);
      assert.equal(repeated.taskID, submitted.taskID);
      const first = await terminal(f.service, submitted.taskID);
      assert.equal(first.state, "succeeded", JSON.stringify(first.error));
      assert.equal(first.result!.availability, "valid");
      assert.equal(first.result!.libraryID, f.source.libraryID);
      const found = await f.service.results({
        libraryID: f.parent.libraryID,
        itemKey: f.parent.key,
      });
      assert.equal(found.source.itemKey, f.source.key);
      assert.equal(found.results[0].itemKey, first.result!.itemKey);
      const reused = await terminal(
        f.service,
        (await f.service.submit({ ...request, requestID: "reuse" })).taskID,
      );
      assert.equal(reused.disposition, "reused_result");
      assert.equal(reused.result!.itemKey, first.result!.itemKey);
      assert.equal(
        (await IOUtils.readUTF8(PathUtils.join(f.dir.path, "calls"))).trim(),
        "called",
      );

      // Different PDF bytes produce a new bundle and leave the older one identifiable.
      await IOUtils.writeUTF8(
        (await f.source.getFilePathAsync()) as string,
        "%PDF-1.4\nchanged\n%%EOF\n",
      );
      const changed = await terminal(
        f.service,
        (await f.service.submit({ ...request, requestID: "changed" })).taskID,
      );
      assert.equal(changed.state, "succeeded");
      assert.notEqual(changed.result!.itemKey, first.result!.itemKey);
      const updated = await f.service.results(f.sourceID);
      assert.equal(updated.results.length, 2);
      assert.equal(
        updated.results.find((item) => item.itemKey === first.result!.itemKey)!
          .availability,
        "stale",
      );

      // Config changes matter even when PDF and CLI options are identical.
      await IOUtils.writeUTF8(f.configPath, "# changed config\n{}\n");
      const configured = await terminal(
        f.service,
        (await f.service.submit({ ...request, requestID: "config-change" }))
          .taskID,
      );
      assert.notEqual(configured.result!.itemKey, changed.result!.itemKey);
      const forced = await terminal(
        f.service,
        (
          await f.service.submit({
            ...request,
            requestID: "forced",
            force: true,
          })
        ).taskID,
      );
      assert.notEqual(forced.result!.itemKey, configured.result!.itemKey);
      assert.equal(
        (
          await f.service.submit({
            ...request,
            requestID: "forced",
            force: true,
          })
        ).taskID,
        forced.taskID,
      );
      assert.equal((await f.service.cancel(forced.taskID)).state, "succeeded");
    } finally {
      await f.clean();
    }
  });

  it("keeps result identity tied to the exact PDF and reports multiple PDF candidates", async function () {
    const f = await fixture();
    let movedParent: Zotero.Item | undefined;
    try {
      const first = await terminal(
        f.service,
        (await f.service.submit({ requestID: "parse", source: f.sourceID }))
          .taskID,
      );
      const second = await Zotero.Attachments.importFromFile({
        file: Zotero.File.pathToFile(
          (await f.source.getFilePathAsync()) as string,
        ),
        parentItemID: f.parent.id,
        contentType: "application/pdf",
      });
      assert.isEmpty(
        (
          await f.service.results({
            libraryID: second.libraryID,
            itemKey: second.key,
          })
        ).results,
      );
      try {
        await f.service.results({
          libraryID: f.parent.libraryID,
          itemKey: f.parent.key,
        });
        assert.fail("Multiple PDFs must require a selection");
      } catch (error) {
        assert.instanceOf(error, MineruAPIError);
        assert.equal((error as MineruAPIError).code, "multiple_pdfs");
        assert.lengthOf(
          (error as MineruAPIError).details.candidates as unknown[],
          2,
        );
      }
      const markdown = first.result!.paths.markdown!;
      const images = PathUtils.join(PathUtils.parent(markdown)!, "images");
      await IOUtils.makeDirectory(images);
      const image = PathUtils.join(images, "only-in-markdown.png");
      await IOUtils.writeUTF8(image, "fixture image");
      await IOUtils.writeUTF8(
        markdown,
        "![image](images/only-in-markdown.png)\n",
      );
      assert.equal(
        (await f.service.results(f.sourceID)).results[0].availability,
        "valid",
      );
      await IOUtils.remove(image);
      assert.equal(
        (await f.service.results(f.sourceID)).results[0].availability,
        "partial",
      );
      await IOUtils.remove(first.result!.paths.middle!);
      const partial = (await f.service.results(f.sourceID)).results[0];
      assert.equal(partial.availability, "partial");
      assert.isString(partial.paths.markdown);
      const repaired = await terminal(
        f.service,
        (await f.service.submit({ requestID: "repair", source: f.sourceID }))
          .taskID,
      );
      assert.notEqual(repaired.result!.itemKey, partial.itemKey);
      // Relations remain authoritative when the source moves to another parent.
      movedParent = new Zotero.Item("journalArticle");
      movedParent.setField("title", "New parent");
      await movedParent.saveTx();
      f.source.parentItemID = movedParent.id;
      await f.source.saveTx();
      assert.includeMembers(
        (await f.service.results(f.sourceID)).results.map(
          (result) => result.itemKey,
        ),
        [first.result!.itemKey, repaired.result!.itemKey],
      );
    } finally {
      if (movedParent) await movedParent.eraseTx();
      await f.clean();
    }
  });

  it("serves native HTTP requests, structured errors, origin rejection and endpoint cleanup", async function () {
    const f = await fixture("sleep 1");
    const previous = new Map(
      Object.entries(Zotero.Server.Endpoints).filter(([path]) =>
        path.startsWith(`/${config.addonRef}/`),
      ),
    );
    const unregister = registerLocalAPI(f.service);
    const port = (Zotero.Server as unknown as { port: number }).port;
    const base = `http://127.0.0.1:${port}${localAPIBase}`;
    const http = async (
      method: string,
      route: string,
      body?: unknown,
      headers: Record<string, string> = {},
      apiBase = localAPIBase,
    ) => {
      let response;
      try {
        response = await Zotero.HTTP.request(
          method,
          `${base.replace(localAPIBase, apiBase)}/${route}`,
          {
            headers: {
              "Zotero-Allowed-Request": "1",
              "Content-Type": "application/json",
              ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            successCodes: false,
          },
        );
      } catch (error) {
        const failure = error as {
          status?: number;
          message?: string;
          responseText?: string;
        };
        throw new Error(
          `HTTP ${method} ${route}: ${failure.message || String(error)} status=${failure.status} response=${failure.responseText || ""}`,
        );
      }
      return {
        status: response.status,
        data: response
          .getResponseHeader("Content-Type")
          ?.includes("application/json")
          ? JSON.parse(response.responseText)
          : null,
      };
    };
    let taskID: string | undefined;
    try {
      assert.equal((await http("GET", "status")).data.protocolVersion, 2);
      const legacy = `/${config.addonRef}/v1`;
      for (const [method, route, payload] of [
        ["GET", "tasks?taskID=old", undefined],
        ["POST", "tasks", { requestID: "v1", source: f.sourceID }],
        ["POST", "tasks/cancel", { taskID: "old" }],
      ] as const) {
        const response = await http(method, route, payload, {}, legacy);
        assert.equal(response.status, 409);
        assert.equal(response.data.error.code, "upgrade_required");
      }
      assert.equal(
        (await http("GET", "status", undefined, {}, legacy)).status,
        200,
      );
      assert.equal(
        (await http("GET", "status")).data.userLibraryID,
        Zotero.Libraries.userLibraryID,
      );
      const denied = await http(
        "POST",
        "tasks",
        { requestID: "browser", source: f.sourceID },
        {
          Origin: "https://example.org",
          "X-Zotero-Connector-API-Version": "3",
        },
      );
      assert.equal(denied.status, 403);
      assert.equal(denied.data.error.code, "browser_origin_denied");
      assert.equal(
        (
          await http("POST", "tasks", {
            requestID: "invalid",
            source: f.sourceID,
            arbitraryPath: "/tmp/a.pdf",
          })
        ).status,
        400,
      );
      const created = await http("POST", "tasks", {
        requestID: "http",
        source: f.sourceID,
      });
      assert.equal(created.status, 201);
      taskID = created.data.taskID;
      const replay = await http("POST", "tasks", {
        requestID: "http",
        source: f.sourceID,
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.data.taskID, taskID);
      assert.equal(
        (await http("GET", `tasks?taskID=${taskID}`)).data.taskID,
        taskID,
      );
      const clash = await http("POST", "tasks", {
        requestID: "http",
        source: f.sourceID,
        force: true,
      });
      assert.equal(clash.status, 409);
      assert.equal(clash.data.error.code, "request_id_conflict");
      await http("POST", "tasks/cancel", { taskID });
      assert.equal((await terminal(f.service, taskID!)).state, "cancelled");
      assert.equal(
        (await http("GET", "tasks?taskID=unknown")).data.error.code,
        "task_not_found",
      );
      const found = await http(
        "GET",
        `results?libraryID=${f.source.libraryID}&itemKey=${f.source.key}`,
      );
      assert.equal(found.status, 200);
      assert.equal(found.data.source.itemKey, f.source.key);
      assert.equal((await http("POST", "queue/pause", {})).data.paused, true);
      const batch = await http("POST", "batches", {
        requestID: "http-batch",
        items: [
          { requestID: "http-batch-1", source: f.sourceID },
          { requestID: "http-batch-2", source: f.sourceID },
        ],
      });
      assert.equal(batch.status, 200);
      const ids = batch.data.taskIDs;
      assert.equal(
        (await http("GET", `batches?batchID=${batch.data.batchID}`)).data.tasks
          .length,
        2,
      );
      const moved = await http("POST", "queue/move", {
        taskID: ids[1],
        before: ids[0],
      });
      assert.deepEqual(
        moved.data.pending.map((task: TaskRecord) => task.taskID),
        [ids[1], ids[0]],
      );
      assert.equal((await http("GET", "queue")).data.remainingCapacity, 8);
      const cancelledBatch = await http("POST", "batches/cancel", {
        batchID: batch.data.batchID,
      });
      assert.isTrue(
        cancelledBatch.data.tasks.every(
          (task: TaskRecord) => task.state === "cancelled",
        ),
      );
      assert.equal((await http("POST", "queue/resume", {})).data.paused, false);
      assert.equal(
        (
          await http(
            "GET",
            `results?libraryID=${f.source.libraryID}&itemKey=${f.source.key}`,
            undefined,
            {},
            legacy,
          )
        ).status,
        200,
      );
      unregister();
      assert.equal((await http("GET", "status")).status, 404);
    } catch (error) {
      // The installed scaffold serializes raw Errors without their message.
      Object.defineProperty(error, "message", {
        value: String(error),
        enumerable: true,
        configurable: true,
      });
      throw error;
    } finally {
      if (taskID && f.service.busy) {
        await f.service.cancel(taskID);
        await terminal(f.service, taskID);
      }
      unregister();
      for (const [path, endpoint] of previous)
        Zotero.Server.Endpoints[path] = endpoint;
      await f.clean();
    }
  });

  it("keeps distinct callers independent, queues FIFO, and replays only retained request identity", async function () {
    const f = await fixture("sleep 1");
    try {
      const original = await f.service.submit({
        requestID: "original",
        source: f.sourceID,
      });
      const deadline = Date.now() + 10000;
      while (
        f.service.get(original.taskID).phase !== "parsing" &&
        Date.now() < deadline
      )
        await Zotero.Promise.delay(10);
      assert.equal(f.service.get(original.taskID).phase, "parsing");
      const request = {
        requestID: "independent",
        source: f.sourceID,
        options: { tier: "standard" },
      };
      const queued = await f.service.submit(request);
      assert.notEqual(queued.taskID, original.taskID);
      assert.equal(queued.state, "queued");
      assert.equal((await f.service.submit(request)).taskID, queued.taskID);
      await f.service.cancel(queued.taskID);
      assert.equal(
        f.service.get(original.taskID).state,
        "running",
        "cancelling queued work cannot signal another caller",
      );
      assert.equal(
        (await terminal(f.service, original.taskID)).state,
        "succeeded",
      );
      assert.equal(
        (await f.service.submit(request)).state,
        "cancelled",
        "replay does not retry cancelled work",
      );
      const fresh = await f.service.submit({ ...request, requestID: "fresh" });
      assert.equal(
        (await terminal(f.service, fresh.taskID)).disposition,
        "reused_result",
      );
    } finally {
      await f.clean();
    }
  });

  it("persists paused FIFO order, atomic capacity admission, batch errors and queued cancellation", async function () {
    const f = await fixture("", true);
    let recovered: MineruTaskService | undefined;
    try {
      const submitted = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          f.service.submit({
            requestID: `pending-${index}`,
            source: f.sourceID,
          }),
        ),
      );
      assert.isTrue(f.service.getQueue().paused);
      assert.isFalse(f.service.busy);
      assert.equal(f.service.getQueue().remainingCapacity, 0);
      const replay = await f.service.submit({
        requestID: "pending-0",
        source: f.sourceID,
      });
      assert.equal(replay.taskID, submitted[0].taskID);
      try {
        await f.service.submit({ requestID: "overflow", source: f.sourceID });
        assert.fail("capacity must reject");
      } catch (error) {
        assert.equal((error as MineruAPIError).code, "queue_full");
      }
      await f.service.move(submitted[9].taskID, {
        before: submitted[0].taskID,
      });
      await f.service.cancel(submitted[3].taskID);
      Zotero.Prefs.set(`${config.prefsPrefix}.queueLimit`, 2, true);
      assert.equal(
        f.service.getQueue().pending.length,
        9,
        "lowering cap does not evict work",
      );
      assert.equal(f.service.getQueue().remainingCapacity, 0);
      f.service.shutdown();
      recovered = new MineruTaskService({ storageRoot: f.storageRoot });
      await recovered.initialize();
      assert.isTrue(recovered.getQueue().paused);
      assert.deepEqual(
        recovered.getQueue().pending.map((task) => task.taskID),
        [
          submitted[9],
          ...submitted
            .slice(0, 9)
            .filter((task) => task.taskID !== submitted[3].taskID),
        ].map((task) => task.taskID),
      );
      assert.equal(
        (await recovered.submit({ requestID: "pending-3", source: f.sourceID }))
          .state,
        "cancelled",
      );
      const ordered = recovered.getQueue().pending;
      for (const task of ordered) await recovered.cancel(task.taskID);
      const batch = await recovered.submitBatch({
        requestID: "mixed",
        items: [
          {
            requestID: "valid-1",
            source: { libraryID: f.parent.libraryID, itemKey: f.parent.key },
          },
          {
            requestID: "invalid-1",
            source: { libraryID: f.source.libraryID, itemKey: "AAAAAAAA" },
          },
          { requestID: "valid-2", source: f.sourceID },
        ],
      });
      assert.lengthOf(batch.tasks, 2);
      assert.equal(batch.invalid[0].index, 1);
      assert.equal(batch.invalid[0].error.code, "item_not_found");
      const snapshot = await IOUtils.readUTF8(
        PathUtils.join(f.storageRoot, "queue.json"),
      );
      assert.notInclude(
        snapshot,
        f.configPath,
        "queue intent stores no configuration path snapshot",
      );
      const cancelled = await recovered.cancelBatch(batch.batchID);
      assert.isTrue(
        cancelled.tasks.every((task) => task.state === "cancelled"),
      );
      assert.deepEqual(recovered.getQueue().pending, []);
    } finally {
      recovered?.shutdown();
      await f.clean();
    }
  });

  it("rejects the whole new valid batch subset when it cannot fit, without choosing among PDFs", async function () {
    const f = await fixture("", true);
    try {
      Zotero.Prefs.set(`${config.prefsPrefix}.queueLimit`, 1, true);
      try {
        await f.service.submitBatch({
          requestID: "too-large",
          items: [
            { requestID: "a", source: f.sourceID },
            { requestID: "b", source: f.sourceID },
            { requestID: "bad", source: {} },
          ],
        });
        assert.fail("valid subset exceeds capacity");
      } catch (error) {
        assert.equal((error as MineruAPIError).code, "queue_full");
        assert.equal((error as MineruAPIError).details.remainingCapacity, 1);
        assert.lengthOf(
          (error as MineruAPIError).details.invalid as unknown[],
          1,
        );
      }
      assert.isEmpty(f.service.getQueue().pending);
      await Zotero.Attachments.importFromFile({
        file: Zotero.File.pathToFile(
          (await f.source.getFilePathAsync()) as string,
        ),
        parentItemID: f.parent.id,
        contentType: "application/pdf",
      });
      const mixed = await f.service.submitBatch({
        requestID: "ambiguous",
        items: [
          {
            requestID: "ambiguous-parent",
            source: { libraryID: f.parent.libraryID, itemKey: f.parent.key },
          },
          { requestID: "exact", source: f.sourceID },
        ],
      });
      assert.lengthOf(mixed.tasks, 1);
      assert.equal(mixed.invalid[0].error.code, "multiple_pdfs");
      assert.deepEqual(
        await f.service.submitBatch({
          requestID: "ambiguous",
          items: [
            {
              requestID: "ambiguous-parent",
              source: { libraryID: f.parent.libraryID, itemKey: f.parent.key },
            },
            { requestID: "exact", source: f.sourceID },
          ],
        }),
        mixed,
      );
    } finally {
      await f.clean();
    }
  });

  it("binds latest settings only at dequeue, keeps explicit overrides, and removes sensitive scratch before terminal", async function () {
    const f = await fixture("", true);
    try {
      const inherited = await f.service.submit({
        requestID: "inherit",
        source: f.sourceID,
      });
      const explicit = await f.service.submit({
        requestID: "explicit",
        source: f.sourceID,
        options: { image_analysis: true },
      });
      Zotero.Prefs.set(`${config.prefsPrefix}.imageAnalysis`, false, true);
      await IOUtils.writeUTF8(
        f.configPath,
        "private_test_secret: do-not-store-me\n",
      );
      assert.equal(
        (await f.service.submit({ requestID: "inherit", source: f.sourceID }))
          .taskID,
        inherited.taskID,
      );
      await f.service.resume();
      const first = await terminal(f.service, inherited.taskID);
      const second = await terminal(f.service, explicit.taskID);
      assert.equal(first.state, "succeeded", JSON.stringify(first.error));
      assert.isFalse(first.execution!.options.image_analysis);
      assert.isTrue(second.execution!.options.image_analysis);
      assert.equal(
        first.execution!.configurationSha256,
        await IOUtils.computeHexDigest(f.configPath, "sha256"),
      );
      const snapshot = await IOUtils.readUTF8(
        PathUtils.join(f.storageRoot, "queue.json"),
      );
      assert.notInclude(snapshot, "do-not-store-me");
      assert.notInclude(snapshot, "childEnvironment");
      assert.isEmpty(
        await IOUtils.getChildren(PathUtils.join(f.storageRoot, "scratch")),
      );
      assert.isTrue(
        await IOUtils.exists(
          PathUtils.join(
            f.storageRoot,
            "diagnostics",
            first.taskID,
            "stdout.log",
          ),
        ),
      );
    } finally {
      await f.clean();
    }
  });

  it("continues after an individual input failure but pauses after an observed shared runtime failure", async function () {
    const f = await fixture("", true);
    try {
      const missing = await f.service.submit({
        requestID: "missing-input",
        source: f.sourceID,
      });
      const good = await f.service.submit({
        requestID: "next-input",
        source: f.sourceID,
      });
      // The first failure is a disappeared item, not an unavailable shared environment.
      const other = await Zotero.Attachments.importFromFile({
        file: Zotero.File.pathToFile(
          (await f.source.getFilePathAsync()) as string,
        ),
        parentItemID: f.parent.id,
        contentType: "application/pdf",
      });
      const third = await f.service.submit({
        requestID: "good-other",
        source: { libraryID: other.libraryID, itemKey: other.key },
      });
      await f.source.eraseTx();
      await f.service.resume();
      assert.equal((await terminal(f.service, missing.taskID)).state, "failed");
      assert.equal((await terminal(f.service, good.taskID)).state, "failed");
      assert.equal(
        (await terminal(f.service, third.taskID)).state,
        "succeeded",
      );
      await f.service.pause();
      const badRuntime = await f.service.submit({
        requestID: "runtime-fails",
        source: { libraryID: other.libraryID, itemKey: other.key },
      });
      const pending = await f.service.submit({
        requestID: "untouched",
        source: { libraryID: other.libraryID, itemKey: other.key },
      });
      Zotero.Prefs.set(
        `${config.prefsPrefix}.runtimeDescriptor`,
        "/missing/runtime.json",
        true,
      );
      await f.service.resume();
      const failed = await terminal(f.service, badRuntime.taskID);
      assert.equal(failed.state, "failed");
      assert.equal(failed.error!.category, "environment");
      assert.isTrue(f.service.getQueue().paused);
      assert.equal(f.service.get(pending.taskID).state, "queued");
    } finally {
      await f.clean();
    }
  });

  it("reconciles durable exact completion evidence and never certifies a forced task from historical matching results", async function () {
    const f = await fixture();
    let restarted: MineruTaskService | undefined;
    try {
      const first = await terminal(
        f.service,
        (await f.service.submit({ requestID: "complete", source: f.sourceID }))
          .taskID,
      );
      await f.service.pause();
      f.service.shutdown();
      const path = PathUtils.join(f.storageRoot, "queue.json");
      const saved = JSON.parse(await IOUtils.readUTF8(path));
      const entry = saved.entries.find(
        (item: any) => item.record.taskID === first.taskID,
      );
      entry.record.state = "running";
      delete entry.record.completedAt;
      delete entry.record.result;
      await IOUtils.writeUTF8(path, JSON.stringify(saved));
      restarted = new MineruTaskService({ storageRoot: f.storageRoot });
      await restarted.initialize();
      assert.equal(restarted.get(first.taskID).state, "succeeded");
      assert.equal(
        restarted.get(first.taskID).result!.itemKey,
        first.result!.itemKey,
      );
      const forced = await restarted.submit({
        requestID: "unknown-forced",
        source: f.sourceID,
        force: true,
      });
      restarted.shutdown();
      const unknown = JSON.parse(await IOUtils.readUTF8(path));
      const active = unknown.entries.find(
        (item: any) => item.record.taskID === forced.taskID,
      );
      active.record.state = "running";
      active.attemptID = crypto.randomUUID();
      unknown.pending = unknown.pending.filter(
        (id: string) => id !== forced.taskID,
      );
      await IOUtils.writeUTF8(path, JSON.stringify(unknown));
      restarted = new MineruTaskService({ storageRoot: f.storageRoot });
      await restarted.initialize();
      assert.equal(restarted.get(forced.taskID).state, "interrupted");
      assert.isTrue(restarted.getQueue().paused);
      assert.equal(
        (
          await restarted.submit({
            requestID: "unknown-forced",
            source: f.sourceID,
            force: true,
          })
        ).state,
        "interrupted",
      );
      assert.equal(
        (await restarted.results(f.sourceID)).results[0].itemKey,
        first.result!.itemKey,
      );
    } finally {
      restarted?.shutdown();
      await f.clean();
    }
  });

  it("fails closed on corrupt storage and on an unacknowledged admission write", async function () {
    const f = await fixture("", true);
    const original = IOUtils.writeUTF8;
    let broken: MineruTaskService | undefined;
    try {
      const path = PathUtils.join(f.storageRoot, "queue.json");
      IOUtils.writeUTF8 = async (target, ...args) => {
        if (target === path) throw new Error("external disk fault");
        return original.call(IOUtils, target, ...args);
      };
      try {
        await f.service.submit({
          requestID: "unconfirmed",
          source: f.sourceID,
        });
        assert.fail("write must fail");
      } catch (error) {
        assert.equal(
          (error as MineruAPIError).code,
          "queue_storage_unavailable",
        );
      }
      assert.isEmpty(
        f.service.getQueue().pending,
        "candidate is not published before its durable commit",
      );
      assert.isFalse((await f.service.status()).storageReady);
      IOUtils.writeUTF8 = original;
      f.service.shutdown();
      await IOUtils.writeUTF8(path, "{corrupt");
      broken = new MineruTaskService({ storageRoot: f.storageRoot });
      try {
        await broken.initialize();
        assert.fail("corrupt state cannot silently reset");
      } catch {
        /* expected */
      }
      try {
        await broken.submit({ requestID: "blocked", source: f.sourceID });
        assert.fail("must remain blocked");
      } catch (error) {
        assert.equal(
          (error as MineruAPIError).code,
          "queue_storage_unavailable",
        );
      }
      assert.equal(await IOUtils.readUTF8(path), "{corrupt");
    } finally {
      IOUtils.writeUTF8 = original;
      broken?.shutdown();
      await f.clean();
    }
  });

  it("holds the serial slot through terminal notification and blocked cleanup, while durable late cancellation preserves committed success", async function () {
    const f = await fixture("", true);
    const original = IOUtils.remove;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let notified = false;
    try {
      const first = await f.service.submit(
        { requestID: "cleanup-first", source: f.sourceID, force: true },
        (view) => {
          if (view.state === "succeeded") notified = true;
        },
      );
      const second = await f.service.submit({
        requestID: "cleanup-next",
        source: f.sourceID,
        force: true,
      });
      IOUtils.remove = async (path, ...args) => {
        if (
          path.startsWith(
            PathUtils.join(f.storageRoot, "scratch", first.taskID),
          )
        ) {
          entered();
          await blocked;
        }
        return original.call(IOUtils, path, ...args);
      };
      await f.service.resume();
      await cleanup;
      assert.isTrue(notified, "progress success precedes final cleanup");
      assert.isTrue(f.service.busy);
      assert.equal(
        f.service.get(first.taskID).state,
        "running",
        "progress does not publish terminal durable state",
      );
      assert.equal(f.service.get(second.taskID).state, "queued");
      await f.service.pause();
      assert.equal(
        (await f.service.cancel(first.taskID)).state,
        "cancel_requested",
      );
      const saved = JSON.parse(
        await IOUtils.readUTF8(PathUtils.join(f.storageRoot, "queue.json")),
      );
      assert.equal(
        saved.entries.find((entry: any) => entry.record.taskID === first.taskID)
          .record.state,
        "cancel_requested",
      );
      release();
      assert.equal(
        (await terminal(f.service, first.taskID)).state,
        "succeeded",
      );
      assert.equal(
        f.service.get(second.taskID).state,
        "queued",
        "pause blocks only the next dispatch",
      );
      await f.service.resume();
      assert.equal(
        (await terminal(f.service, second.taskID)).state,
        "succeeded",
      );
      assert.equal(
        (await IOUtils.readUTF8(PathUtils.join(f.dir.path, "calls")))
          .trim()
          .split("\n").length,
        2,
      );
    } finally {
      release();
      IOUtils.remove = original;
      await f.clean();
    }
  });

  for (const window of ["receipt", "terminal"] as const) {
    const title = `recovers committed output across a failed ${window} queue flush without rerunning the forced task`;

    it(title, async function () {
      const f = await fixture("", true);
      const original = IOUtils.writeUTF8;
      let recovered: MineruTaskService | undefined;
      try {
        const first = await f.service.submit({
          requestID: `crash-${window}`,
          source: f.sourceID,
          force: true,
        });
        const second = await f.service.submit({
          requestID: "preserve-pending",
          source: f.sourceID,
        });
        const path = PathUtils.join(f.storageRoot, "queue.json");
        IOUtils.writeUTF8 = async (target, content, ...args) => {
          if (target === path) {
            const state = JSON.parse(content);
            const entry = state.entries.find(
              (entry: any) => entry.record.taskID === first.taskID,
            );
            if (
              window === "receipt"
                ? !!entry.completion
                : entry.record.state === "succeeded"
            )
              throw new Error("external crash-window disk failure");
          }
          return original.call(IOUtils, target, content, ...args);
        };
        await f.service.resume();
        const deadline = Date.now() + 10000;
        while (
          ((await f.service.status()).storageReady || f.service.busy) &&
          Date.now() < deadline
        )
          await Zotero.Promise.delay(10);
        assert.isFalse((await f.service.status()).storageReady);
        assert.equal(f.service.get(second.taskID).state, "queued");
        IOUtils.writeUTF8 = original;
        f.service.shutdown();
        recovered = new MineruTaskService({ storageRoot: f.storageRoot });
        await recovered.initialize();
        assert.equal(recovered.get(first.taskID).state, "succeeded");
        assert.isTrue(recovered.getQueue().paused);
        assert.equal(recovered.get(second.taskID).state, "queued");
        assert.equal(
          (await IOUtils.readUTF8(PathUtils.join(f.dir.path, "calls"))).trim(),
          "called",
          "restart never launches a forced rerun",
        );
        assert.lengthOf((await recovered.results(f.sourceID)).results, 1);
      } finally {
        IOUtils.writeUTF8 = original;
        recovered?.shutdown();
        await f.clean();
      }
    });
  }

  for (const category of ["process", "validation"] as const) {
    const title = `continues after a settled individual ${category} failure`;

    it(title, async function () {
      const f = await fixture("", true);
      try {
        // A stable marker outside per-attempt sensitive scratch lets the next real child succeed.
        await IOUtils.writeUTF8(
          PathUtils.join(f.dir.path, "bin", "mineru-kit"),
          `#!/bin/sh\nif [ ! -f '${f.dir.path}/failed-once' ]; then touch '${f.dir.path}/failed-once'; exit ${category === "process" ? 7 : 0}; fi\ncp '${f.dir.path}/result.zip' "$4"\n`,
        );
        const first = await f.service.submit({
          requestID: "fails-once",
          source: f.sourceID,
          force: true,
        });
        const next = await f.service.submit({
          requestID: "after-failure",
          source: f.sourceID,
          force: true,
        });
        await f.service.resume();
        const failed = await terminal(f.service, first.taskID);
        assert.equal(failed.state, "failed");
        assert.equal(failed.error!.category, category);
        assert.equal(
          (await terminal(f.service, next.taskID)).state,
          "succeeded",
        );
        assert.isFalse(f.service.getQueue().paused);
      } finally {
        await f.clean();
      }
    });
  }

  it("pauses on sensitive cleanup failure, retains committed success, and retries owned orphan cleanup at startup", async function () {
    const f = await fixture("", true);
    const original = IOUtils.remove;
    let recovered: MineruTaskService | undefined;
    try {
      const first = await f.service.submit({
        requestID: "cleanup-failure",
        source: f.sourceID,
        force: true,
      });
      const next = await f.service.submit({
        requestID: "blocked-next",
        source: f.sourceID,
      });
      IOUtils.remove = async (path, ...args) => {
        if (
          path.startsWith(
            PathUtils.join(f.storageRoot, "scratch", first.taskID),
          )
        )
          throw new Error("external scratch removal fault");
        return original.call(IOUtils, path, ...args);
      };
      await f.service.resume();
      const done = await terminal(f.service, first.taskID);
      assert.equal(
        done.state,
        "succeeded",
        "saved attachment cannot become failed/cancelled after commit",
      );
      assert.equal(done.error!.category, "cleanup");
      assert.isTrue(f.service.getQueue().paused);
      assert.isFalse((await f.service.status()).recoveryReady);
      assert.equal(f.service.get(next.taskID).state, "queued");
      IOUtils.remove = original;
      f.service.shutdown();
      recovered = new MineruTaskService({ storageRoot: f.storageRoot });
      await recovered.initialize();
      assert.isEmpty(
        await IOUtils.getChildren(PathUtils.join(f.storageRoot, "scratch")),
      );
      assert.isTrue((await recovered.status()).recoveryReady);
      assert.equal(recovered.get(first.taskID).state, "succeeded");
      assert.equal(recovered.get(next.taskID).state, "queued");
    } finally {
      IOUtils.remove = original;
      recovered?.shutdown();
      await f.clean();
    }
  });

  it("persists active batch cancellation before signalling its actual child, without aborting unrelated queued work", async function () {
    const f = await fixture("exec sleep 10", true);
    const original = IOUtils.writeUTF8;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const batch = await f.service.submitBatch({
        requestID: "cancel-active-batch",
        items: [
          { requestID: "active-member", source: f.sourceID },
          { requestID: "queued-member", source: f.sourceID },
        ],
      });
      const unrelated = await f.service.submit({
        requestID: "unrelated",
        source: f.sourceID,
      });
      await f.service.resume();
      const deadline = Date.now() + 10000;
      while (
        !(await IOUtils.exists(PathUtils.join(f.dir.path, "calls"))) &&
        Date.now() < deadline
      )
        await Zotero.Promise.delay(10);
      assert.equal(f.service.get(batch.taskIDs[0]).phase, "parsing");
      await f.service.pause();
      const path = PathUtils.join(f.storageRoot, "queue.json");
      IOUtils.writeUTF8 = async (target, content, ...args) => {
        if (
          target === path &&
          JSON.parse(content).entries.some(
            (entry: any) => entry.record.state === "cancel_requested",
          )
        ) {
          entered();
          await blocked;
        }
        return original.call(IOUtils, target, content, ...args);
      };
      const cancelling = f.service.cancelBatch(batch.batchID);
      await writing;
      assert.equal(
        f.service.get(batch.taskIDs[0]).state,
        "running",
        "candidate cancellation is not published before flush",
      );
      assert.equal(f.service.get(batch.taskIDs[1]).state, "queued");
      assert.isTrue(f.service.busy);
      release();
      await cancelling;
      assert.equal(
        (await terminal(f.service, batch.taskIDs[0])).state,
        "cancelled",
      );
      assert.equal(f.service.get(batch.taskIDs[1]).state, "cancelled");
      assert.equal(f.service.get(unrelated.taskID).state, "queued");
      IOUtils.writeUTF8 = original;
      await IOUtils.writeUTF8(
        PathUtils.join(f.dir.path, "bin", "mineru-kit"),
        `#!/bin/sh\ncp '${f.dir.path}/result.zip' "$4"\n`,
      );
      await f.service.resume();
      assert.equal(
        (await terminal(f.service, unrelated.taskID)).state,
        "succeeded",
      );
    } finally {
      release();
      IOUtils.writeUTF8 = original;
      await f.clean();
    }
  });

  it("executes restart-restored pending intent using current preferences while retaining replay identity", async function () {
    const f = await fixture("", true);
    let recovered: MineruTaskService | undefined;
    try {
      const request = { requestID: "restart-late", source: f.sourceID };
      const queued = await f.service.submit(request);
      f.service.shutdown();
      Zotero.Prefs.set(`${config.prefsPrefix}.imageAnalysis`, false, true);
      recovered = new MineruTaskService({ storageRoot: f.storageRoot });
      await recovered.initialize();
      assert.equal((await recovered.submit(request)).taskID, queued.taskID);
      assert.isTrue(recovered.getQueue().paused);
      await recovered.resume();
      const done = await terminal(recovered, queued.taskID);
      assert.equal(done.state, "succeeded");
      assert.isFalse(done.execution!.options.image_analysis);
      Zotero.Prefs.set(`${config.prefsPrefix}.imageAnalysis`, true, true);
      assert.isFalse(
        (await recovered.submit(request)).execution!.options.image_analysis,
        "replay never refreshes a completed execution",
      );
    } finally {
      recovered?.shutdown();
      await f.clean();
    }
  });

  it("bounds terminal history and batch manifests, expires replay registrations, and preserves unfinished work", async function () {
    const f = await fixture();
    try {
      const publishedRequest = {
        requestID: "history-result",
        source: f.sourceID,
      };
      const published = await terminal(
        f.service,
        (await f.service.submit(publishedRequest)).taskID,
      );
      assert.equal(
        published.state,
        "succeeded",
        JSON.stringify(published.error),
      );
      await f.service.pause();
      const sourcePath = (await f.source.getFilePathAsync()) as string;
      const sourceContents = await IOUtils.readUTF8(sourcePath);
      const resultPath = published.result!.paths.markdown!;
      const resultContents = await IOUtils.readUTF8(resultPath);

      const requests = new Map([[published.taskID, publishedRequest]]);
      const diagnostics = (taskID: string) =>
        PathUtils.join(f.storageRoot, "diagnostics", taskID);
      const seedDiagnostics = async (taskID: string) => {
        await IOUtils.makeDirectory(diagnostics(taskID), {
          createAncestors: true,
        });
        await IOUtils.writeUTF8(
          PathUtils.join(diagnostics(taskID), "retention-fixture.log"),
          "raw diagnostic fixture",
        );
      };
      await seedDiagnostics(published.taskID);
      const owning = await f.service.submitBatch({
        requestID: "unfinished-owner",
        items: [{ requestID: "unfinished", source: f.sourceID }],
      });
      const unfinished = owning.tasks[0];
      const completed = [];
      for (let index = 0; index < 100; index++) {
        // Cancel the first pair together to allow equal completion timestamps.
        // Neither public retention nor queue ordering specifies a tie victim.
        const items = (
          index === 0
            ? ["history-task-0", "history-task-pair"]
            : [`history-task-${index}`]
        ).map((requestID) => ({ requestID, source: f.sourceID }));
        const batch = await f.service.submitBatch({
          requestID: `history-${index}`,
          items,
        });
        for (const [itemIndex, taskID] of batch.taskIDs.entries()) {
          requests.set(taskID, items[itemIndex]);
          await seedDiagnostics(taskID);
        }
        await f.service.cancelBatch(batch.batchID);
        completed.push(batch);
      }
      // A replay-only wrapper counts toward the separate manifest bound without
      // adding another terminal task that would force both early pair members out.
      const wrapper = await f.service.submitBatch({
        requestID: "history-wrapper",
        items: [requests.get(completed.at(-1)!.taskIDs[0])!],
      });
      assert.deepEqual(wrapper.taskIDs, completed.at(-1)!.taskIDs);
      completed.push(wrapper);
      const recent = f.service.getQueue().recent;
      assert.lengthOf(recent, 100);
      const retained = new Set(recent.map((task) => task.taskID));
      const evicted = [...requests.keys()].filter((id) => !retained.has(id));
      assert.lengthOf(evicted, requests.size - 100);
      assert.include(
        evicted,
        published.taskID,
        "exercise successful-task history eviction before checking its attachment",
      );
      // Cancellation acknowledges the durable mutation and its diagnostic cleanup;
      // no separate timer or cleanup grace period is part of this contract.
      for (const taskID of requests.keys()) {
        if (retained.has(taskID)) {
          assert.include(
            ["succeeded", "cancelled"],
            f.service.get(taskID).state,
          );
          assert.equal(
            await IOUtils.readUTF8(
              PathUtils.join(diagnostics(taskID), "retention-fixture.log"),
            ),
            "raw diagnostic fixture",
            `retained task keeps diagnostics: ${taskID}`,
          );
        } else {
          assert.propertyVal(
            assert.throws(() => f.service.get(taskID), MineruAPIError),
            "code",
            "task_not_found",
          );
          assert.isFalse(
            await IOUtils.exists(diagnostics(taskID)),
            `evicted task loses diagnostics: ${taskID}`,
          );
        }
      }
      assert.equal(f.service.get(unfinished.taskID).state, "queued");
      assert.deepEqual(
        f.service.getQueue().pending.map((task) => task.taskID),
        owning.taskIDs,
      );
      assert.equal(
        f.service.getBatch(owning.batchID).tasks[0].state,
        "queued",
        "owning unfinished manifests outlive bounded wrappers",
      );
      assert.propertyVal(
        assert.throws(
          () => f.service.getBatch(completed[0].batchID),
          MineruAPIError,
        ),
        "code",
        "batch_not_found",
      );
      for (const batch of completed.slice(-100))
        assert.equal(f.service.getBatch(batch.batchID).batchID, batch.batchID);

      const expiredID = evicted.find((id) => id !== published.taskID)!;
      const fresh = await f.service.submit(requests.get(expiredID)!);
      assert.notEqual(
        fresh.taskID,
        expiredID,
        "eviction expires task replay registration",
      );
      assert.equal(fresh.state, "queued");
      // Index every retained task, not a predicted oldest tie member. Observe which
      // member actually expires on the next terminal-history eviction.
      const indexed = await f.service.submitBatch({
        requestID: "partial",
        items: recent.map((task) => requests.get(task.taskID)!),
      });
      assert.sameMembers(indexed.taskIDs, [...retained]);
      assert.isFalse(indexed.partialHistory);
      await f.service.cancel(fresh.taskID);
      const remaining = new Set(
        f.service.getQueue().recent.map((task) => task.taskID),
      );
      assert.equal(remaining.size, 100);
      const expiredMembers = indexed.taskIDs.filter((id) => !remaining.has(id));
      assert.lengthOf(expiredMembers, 1);
      const partial = f.service.getBatch(indexed.batchID);
      assert.isTrue(partial.partialHistory);
      assert.sameMembers(partial.expiredTaskIDs, expiredMembers);
      assert.sameMembers(
        partial.tasks.map((task) => task.taskID),
        indexed.taskIDs.filter((id) => remaining.has(id)),
      );
      for (const taskID of expiredMembers) {
        assert.propertyVal(
          assert.throws(() => f.service.get(taskID), MineruAPIError),
          "code",
          "task_not_found",
        );
        assert.isFalse(await IOUtils.exists(diagnostics(taskID)));
      }

      const source = await Zotero.Items.getByLibraryAndKeyAsync(
        f.source.libraryID,
        f.source.key,
      );
      assert.isOk(
        source,
        "history eviction preserves the source attachment item",
      );
      assert.isFalse(source.deleted);
      assert.equal(await source.getFilePathAsync(), sourcePath);
      assert.equal(await IOUtils.readUTF8(sourcePath), sourceContents);
      const result = await Zotero.Items.getByLibraryAndKeyAsync(
        published.result!.libraryID,
        published.result!.itemKey,
      );
      assert.isOk(
        result,
        "history eviction preserves the published attachment item",
      );
      assert.isFalse(result.deleted);
      assert.equal(await result.getFilePathAsync(), resultPath);
      assert.equal(await IOUtils.readUTF8(resultPath), resultContents);
      const found = await f.service.results(f.sourceID);
      assert.equal(
        found.results.find(
          (item) => item.itemKey === published.result!.itemKey,
        )!.availability,
        "valid",
      );
    } finally {
      await f.clean();
    }
  });
});
