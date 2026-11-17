import { assert } from "chai";
import { previewLegacyMarkdownMigration } from "../src/modules/mineru/markdownMigration";
import { MineruTaskService } from "../src/modules/mineru/service";

describe("MinerU Markdown filename migration", function () {
  this.timeout(20000);

  it("rolls back an interrupted move at startup and only renames confirmed personal results with normal sync", async function () {
    const temp = Zotero.getTempDirectory();
    temp.append("mineru-rename-test");
    temp.createUnique(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
    const pdf = PathUtils.join(temp.path, "original.pdf");
    const contents = "# Legacy paper\n![figure](images/paper.png)\n";
    await IOUtils.writeUTF8(pdf, "%PDF-1.4\n%%EOF\n");
    const items: Zotero.Item[] = [];
    const group = new Zotero.Group({
      groupID: 812345,
      name: "Migration test",
      description: "",
      version: 1,
    });
    group.editable = true;
    group.filesEditable = true;
    await group.saveTx();
    const importPDF = async (libraryID: number) => {
      const source = await Zotero.Attachments.importFromFile({
        file: Zotero.File.pathToFile(pdf),
        libraryID,
        contentType: "application/pdf",
      });
      items.push(source);
      return source;
    };
    const oldAttachment = async (
      source: Zotero.Item,
      note = "zotero-mineru-generation:v1",
    ) => {
      const item = new Zotero.Item("attachment");
      item.libraryID = source.libraryID;
      item.setField("title", "Existing result title");
      item.attachmentLinkMode = Zotero.Attachments.LINK_MODE_IMPORTED_FILE;
      item.attachmentContentType = "text/markdown";
      item.attachmentPath = "storage:markdown.md";
      item.setNote(note);
      item.addRelation("dc:relation", Zotero.URI.getItemURI(source));
      await item.saveTx();
      items.push(item);
      await item.loadAllData(true);
      const dir = Zotero.Attachments.getStorageDirectory(item).path;
      await IOUtils.makeDirectory(dir);
      await IOUtils.makeDirectory(PathUtils.join(dir, "images"));
      await IOUtils.writeUTF8(PathUtils.join(dir, "markdown.md"), contents);
      await IOUtils.writeUTF8(
        PathUtils.join(dir, "images", "paper.png"),
        "image",
      );
      return { item, dir };
    };
    const journal = PathUtils.join(
      Zotero.DataDirectory.dir,
      "mineru-markdown-rename.json",
    );
    const service = new MineruTaskService({
      storageRoot: PathUtils.join(temp.path, "queue"),
    });
    const storagePref = "sync.storage.enabled";
    const previousStoragePref = Zotero.Prefs.get(storagePref);
    try {
      const source = await importPDF(Zotero.Libraries.userLibraryID);
      const legacy = await oldAttachment(source);
      const interrupted = await oldAttachment(source);
      const collision = await oldAttachment(source);
      const unrelated = await oldAttachment(source, "");
      const alreadyNamed = await oldAttachment(
        source,
        "zotero-mineru-generation:v2",
      );
      const groupLegacy = await oldAttachment(await importPDF(group.libraryID));
      const missingSource = await importPDF(Zotero.Libraries.userLibraryID);
      const unavailable = await oldAttachment(missingSource);
      await IOUtils.remove((await missingSource.getFilePathAsync()) as string);

      const oldPDF = (await source.getFilePathAsync()) as string;
      await IOUtils.move(
        oldPDF,
        PathUtils.join(PathUtils.parent(oldPDF)!, "Current.v2.PDF"),
      );
      source.attachmentFilename = "Current.v2.PDF";
      await source.saveTx({ skipNotifier: true });
      const filename = "Current.v2.md";
      const original = PathUtils.join(interrupted.dir, "markdown.md");
      const sha256 = await IOUtils.computeHexDigest(original, "sha256");
      await IOUtils.writeUTF8(
        journal,
        JSON.stringify({
          key: interrupted.item.key,
          sourceURI: Zotero.URI.getItemURI(source),
          filename,
          sha256,
        }),
      );
      await IOUtils.move(original, PathUtils.join(interrupted.dir, filename));
      await IOUtils.writeUTF8(
        PathUtils.join(collision.dir, filename),
        "existing",
      );

      await service.initialize();
      assert.isFalse(await IOUtils.exists(journal));
      for (const { item, dir } of [legacy, interrupted]) {
        assert.equal(
          await item.getFilePathAsync(),
          PathUtils.join(dir, "markdown.md"),
        );
        assert.isFalse(await IOUtils.exists(PathUtils.join(dir, filename)));
      }
      // Exercise the real sync state machine without supplying real credentials.
      Zotero.Sync.Runner.apiKey = "test-only-no-network";
      Zotero.Prefs.set(storagePref, true);
      source.synced = true;
      source.attachmentSyncState = "in_sync";
      await source.saveTx({ skipNotifier: true });
      const baseline = Date.now();
      for (const { item, dir } of [legacy, interrupted]) {
        const path = PathUtils.join(dir, "markdown.md");
        await IOUtils.setModificationTime(path, baseline);
        item.attachmentSyncedModificationTime = (
          await IOUtils.stat(path)
        ).lastModified;
        item.attachmentSyncedHash = (await item.attachmentHash)!;
        item.attachmentSyncState = "in_sync";
        item.synced = true;
        await item.saveTx({ skipNotifier: true });
      }
      const syncedHash = legacy.item.attachmentSyncedHash;
      const syncedTime = legacy.item.attachmentSyncedModificationTime;
      const originalPreview = await previewLegacyMarkdownMigration();
      assert.isFalse(originalPreview.blocked);
      assert.deepEqual(
        originalPreview.candidates.map(({ id }) => id).sort(),
        [legacy.item.id, interrupted.item.id].sort(),
      );
      assert.equal(originalPreview.skipped, 2);

      // A conflict arriving after the confirmation preview must prevent migration.
      legacy.item.attachmentSyncState = "in_conflict";
      await legacy.item.saveTx({ skipAll: true });
      assert.isTrue((await previewLegacyMarkdownMigration()).blocked);
      assert.deepEqual(await service.migrateMarkdown(originalPreview), {
        renamed: 0,
        skipped: 2,
        blocked: true,
        failed: false,
      });
      legacy.item.attachmentSyncState = "in_sync";
      await legacy.item.saveTx({ skipAll: true });

      const plan = await previewLegacyMarkdownMigration();
      const renamed = await service.migrateMarkdown(plan);
      assert.deepEqual(renamed, {
        renamed: 2,
        skipped: 2,
        blocked: false,
        failed: false,
      });
      assert.equal(legacy.item.attachmentSyncState, 0, "queued as to_upload");
      assert.equal(legacy.item.attachmentSyncedHash, syncedHash);
      assert.equal(legacy.item.attachmentSyncedModificationTime, syncedTime);
      const delta = Math.abs(
        Math.floor((await legacy.item.attachmentModificationTime)! / 1000) -
          Math.floor(syncedTime / 1000),
      );
      assert.notInclude(
        [0, 3600],
        delta,
        "Zotero must not treat the old ZIP as current",
      );
      assert.deepEqual((await previewLegacyMarkdownMigration()).candidates, []);

      for (const { item, dir } of [legacy, interrupted]) {
        assert.equal(
          await item.getFilePathAsync(),
          PathUtils.join(dir, filename),
        );
        assert.equal(item.getField("title"), "Existing result title");
        assert.deepEqual(item.getRelationsByPredicate("dc:relation"), [
          Zotero.URI.getItemURI(source),
        ]);
        assert.equal(
          await IOUtils.readUTF8(PathUtils.join(dir, filename)),
          contents,
        );
        assert.equal(
          await IOUtils.readUTF8(PathUtils.join(dir, "images", "paper.png")),
          "image",
        );
        assert.isFalse(
          await IOUtils.exists(PathUtils.join(dir, "markdown.md")),
        );
      }
      assert.isFalse(await IOUtils.exists(journal));
      for (const { item, dir } of [
        collision,
        unrelated,
        alreadyNamed,
        groupLegacy,
        unavailable,
      ]) {
        assert.equal(
          await item.getFilePathAsync(),
          PathUtils.join(dir, "markdown.md"),
        );
        assert.equal(
          await IOUtils.readUTF8(PathUtils.join(dir, "markdown.md")),
          contents,
        );
      }
      assert.equal(
        await IOUtils.readUTF8(PathUtils.join(collision.dir, filename)),
        "existing",
      );
    } finally {
      Zotero.Sync.Runner.apiKey = "";
      Zotero.Prefs.set(storagePref, previousStoragePref);
      await service.shutdown();
      await IOUtils.remove(journal, { ignoreAbsent: true });
      for (const item of items.reverse()) await item.eraseTx();
      await group.eraseTx();
      temp.remove(true);
    }
  });
});
