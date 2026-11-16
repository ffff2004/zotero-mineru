import { assert } from "chai";
import { MineruTaskService } from "../src/modules/mineru/service";

describe("MinerU Markdown filename migration", function () {
  this.timeout(20000);

  it("recovers an interrupted move and renames only eligible personal results", async function () {
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
      await service.shutdown();
      await IOUtils.remove(journal, { ignoreAbsent: true });
      for (const item of items.reverse()) await item.eraseTx();
      await group.eraseTx();
      temp.remove(true);
    }
  });
});
