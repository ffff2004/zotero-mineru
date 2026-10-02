import { assert } from "chai";
import { config } from "../package.json";
import manifest from "../runtime/release.json";
import {
  MineruTaskService,
  type TaskRecord,
} from "../src/modules/mineru/service";
import { localAPIBase, registerLocalAPI } from "../src/modules/mineru/localAPI";
import { MineruAPIError } from "../src/modules/mineru/apiError";

async function fixture(scriptDelay = "") {
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
  })) {
    const key = `${config.prefsPrefix}.${name}`;
    saved.set(key, Zotero.Prefs.get(key, true));
    Zotero.Prefs.set(key, value, true);
  }
  const service = new MineruTaskService();
  service.setReady(true);
  const sourceID = { libraryID: source.libraryID, itemKey: source.key };
  return {
    dir,
    source,
    parent,
    service,
    sourceID,
    configPath,
    async clean() {
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
    if (["succeeded", "failed", "cancelled"].includes(task.state)) {
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
      assert.equal(f.service.cancel(forced.taskID).state, "succeeded");
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
        path.startsWith(`${localAPIBase}/`),
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
    ) => {
      let response;
      try {
        response = await Zotero.HTTP.request(method, `${base}/${route}`, {
          headers: {
            "Zotero-Allowed-Request": "1",
            "Content-Type": "application/json",
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          successCodes: false,
        });
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
      assert.equal((await http("GET", "status")).data.protocolVersion, 1);
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
        f.service.cancel(taskID);
        await terminal(f.service, taskID);
      }
      unregister();
      for (const [path, endpoint] of previous)
        Zotero.Server.Endpoints[path] = endpoint;
      await f.clean();
    }
  });

  it("joins matching active snapshots and keeps each request ID bound to its own inputs", async function () {
    const f = await fixture("sleep 1");
    let taskID: string | undefined;
    try {
      const original = await f.service.submit({
        requestID: "original",
        source: f.sourceID,
      });
      taskID = original.taskID;
      const deadline = Date.now() + 10000;
      while (f.service.get(taskID).phase !== "parsing" && Date.now() < deadline)
        await Zotero.Promise.delay(10);
      assert.equal(f.service.get(taskID).phase, "parsing");
      const request = {
        requestID: "alias",
        source: f.sourceID,
        options: { tier: "standard" },
      };
      const joined = await f.service.submit(request);
      assert.equal(joined.taskID, taskID);
      assert.equal(joined.disposition, "reused_task");
      assert.equal((await f.service.submit(request)).taskID, taskID);
      try {
        await f.service.submit({
          requestID: "different",
          source: f.sourceID,
          options: { ocr_mode: "ocr" },
        });
        assert.fail("Different inputs must not join an active task");
      } catch (error) {
        assert.instanceOf(error, MineruAPIError);
        assert.equal((error as MineruAPIError).code, "task_busy");
      }
      const completed = await terminal(f.service, taskID);
      assert.equal(completed.state, "succeeded");
      assert.equal(
        (await f.service.submit(request)).result!.itemKey,
        completed.result!.itemKey,
      );
    } finally {
      if (taskID && f.service.busy) {
        f.service.cancel(taskID);
        await terminal(f.service, taskID);
      }
      await f.clean();
    }
  });
});
