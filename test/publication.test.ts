import { assert } from "chai";
import {
  publishValidatedPackage,
  recoverIncompletePublications,
} from "../src/modules/mineru/publication";

function temporaryDirectory(): nsIFile {
  const directory = Zotero.getTempDirectory();
  directory.append(`mineru-publication-test-${Date.now()}-${Math.random()}`);
  directory.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
  return directory;
}

async function write(
  root: nsIFile,
  relative: string,
  content: string,
): Promise<void> {
  const file = root.clone();
  for (const part of relative.split("/")) file.append(part);
  await Zotero.File.putContentsAsync(file, content);
}

describe("MinerU stored attachment publication", function () {
  this.timeout(120000);

  it("publishes and locally restores the complete multifile package", async function () {
    const temp = temporaryDirectory();
    const pdf = temp.clone();
    pdf.append("source.pdf");
    await Zotero.File.putContentsAsync(pdf, "%PDF-1.4\n%%EOF\n");
    const source = await Zotero.Attachments.importFromFile({
      file: pdf,
      contentType: "application/pdf",
    });
    const collection = new Zotero.Collection();
    collection.libraryID = source.libraryID;
    collection.name = "MinerU publication test";
    await collection.saveTx();
    source.setCollections([collection.id]);
    await source.saveTx();
    let result: Zotero.Item | undefined;
    try {
      const packageDir = temp.clone();
      packageDir.append("package");
      packageDir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
      const images = packageDir.clone();
      images.append("images");
      images.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
      await write(packageDir, "markdown.md", "# A\n![figure](images/x.png)\n");
      await write(packageDir, "middle_json.json", "{}\n");
      await write(
        packageDir,
        "provenance.json",
        '{"package_format_version":1}\n',
      );
      await write(packageDir, "images/x.png", "image bytes");
      result = await publishValidatedPackage({
        packageDirectory: packageDir.path,
        sourcePDF: source,
        title: "MinerU test result",
      });

      assert.notEqual(result.id, source.id);
      assert.equal(result.attachmentContentType, "text/markdown");
      assert.equal(result.attachmentPath, "storage:markdown.md");
      assert.deepEqual(result.getCollections(), [collection.id]);
      assert.equal(result.note, "zotero-mineru-generation:v1");
      assert.deepEqual(result.getRelationsByPredicate("dc:relation"), [
        Zotero.URI.getItemURI(source),
      ]);
      assert.equal(result.attachmentSyncState, 0);
      const uploadIDs = await (
        Zotero.Sync.Storage as any
      ).Local.getFilesToUpload(result.libraryID);
      assert.include(uploadIDs, result.id);
      const storage = Zotero.Attachments.getStorageDirectory(result);
      for (const path of [
        "markdown.md",
        "middle_json.json",
        "provenance.json",
        "images/x.png",
      ]) {
        const stored = storage.clone();
        for (const part of path.split("/")) stored.append(part);
        assert.isTrue(stored.exists(), `${path} is stored`);
      }

      // Exercise Zotero 10.0.3's ZIP writer and normal local download processor
      // without claiming a remote Storage or WebDAV round trip.
      const zip = temp.clone();
      zip.append("upload.zip");
      await Zotero.File.zipDirectory(storage.path, zip.path, null);
      const download = Zotero.getTempDirectory();
      download.append(`${result.key}.tmp`);
      if (download.exists()) download.remove(false);
      zip.copyTo(download.parent, download.leafName);
      storage.remove(true);
      await (Zotero.Sync.Storage as any).Local.processDownload({
        item: result,
        mtime: Date.now(),
        compressed: true,
      });
      const restoredImage = Zotero.Attachments.getStorageDirectory(result);
      restoredImage.append("images");
      restoredImage.append("x.png");
      assert.equal(
        await Zotero.File.getContentsAsync(restoredImage),
        "image bytes",
      );
      const restoredJSON = Zotero.Attachments.getStorageDirectory(result);
      restoredJSON.append("middle_json.json");
      assert.equal(await Zotero.File.getContentsAsync(restoredJSON), "{}\n");
      assert.deepEqual(await recoverIncompletePublications(), {
        committed: 0,
        rolledBack: 0,
      });
    } finally {
      if (result) await result.eraseTx();
      await source.eraseTx();
      await collection.eraseTx();
      temp.remove(true);
    }
  });

  it("rejects an unuploadable package without creating an attachment", async function () {
    const temp = temporaryDirectory();
    const pdf = temp.clone();
    pdf.append("source.pdf");
    await Zotero.File.putContentsAsync(pdf, "%PDF-1.4\n%%EOF\n");
    const source = await Zotero.Attachments.importFromFile({
      file: pdf,
      contentType: "application/pdf",
    });
    try {
      const packageDir = temp.clone();
      packageDir.append("package");
      packageDir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
      await write(packageDir, "markdown.md", "# A\n");
      await write(packageDir, "middle_json.json", "{}\n");
      await write(packageDir, "provenance.json", "{}\n");
      await write(packageDir, ".hidden.json", "{}\n");
      const before = (await Zotero.Items.getAll(source.libraryID)).length;
      let failure = "";
      try {
        await publishValidatedPackage({
          packageDirectory: packageDir.path,
          sourcePDF: source,
        });
      } catch (error) {
        failure = String(error);
      }
      assert.match(failure, /cannot round-trip/);
      assert.equal(
        (await Zotero.Items.getAll(source.libraryID)).length,
        before,
      );
    } finally {
      await source.eraseTx();
      temp.remove(true);
    }
  });

  it("recovers a journal-owned staging directory after cleanup failure", async function () {
    const temp = temporaryDirectory();
    const pdf = temp.clone();
    pdf.append("source.pdf");
    await Zotero.File.putContentsAsync(pdf, "%PDF-1.4\n%%EOF\n");
    const source = await Zotero.Attachments.importFromFile({
      file: pdf,
      contentType: "application/pdf",
    });
    const originalZip = Zotero.File.zipDirectory;
    const originalRemove = IOUtils.remove;
    try {
      const packageDir = temp.clone();
      packageDir.append("package");
      packageDir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
      await write(packageDir, "markdown.md", "# A\n");
      await write(packageDir, "middle_json.json", "{}\n");
      await write(packageDir, "provenance.json", "{}\n");
      (Zotero.File as any).zipDirectory = async () => {
        throw new Error("injected ZIP failure");
      };
      (IOUtils as any).remove = async (
        path: string,
        options?: RemoveOptions,
      ) => {
        if (PathUtils.filename(path).startsWith("tmp-mineru-")) {
          throw new Error("injected cleanup failure");
        }
        return originalRemove(path, options);
      };
      let failure = "";
      const before = (await Zotero.Items.getAll(source.libraryID)).length;
      try {
        await publishValidatedPackage({
          packageDirectory: packageDir.path,
          sourcePDF: source,
        });
      } catch (error) {
        failure = String(error);
      }
      assert.match(failure, /recovery journal retained/);
      assert.equal(
        (await Zotero.Items.getAll(source.libraryID)).length,
        before,
      );
    } finally {
      (Zotero.File as any).zipDirectory = originalZip;
      (IOUtils as any).remove = originalRemove;
      assert.deepEqual(await recoverIncompletePublications(), {
        committed: 0,
        rolledBack: 1,
      });
      await source.eraseTx();
      temp.remove(true);
    }
  });

  it("keeps a complete committed attachment when the final journal write fails", async function () {
    const temp = temporaryDirectory();
    const pdf = temp.clone();
    pdf.append("source.pdf");
    await Zotero.File.putContentsAsync(pdf, "%PDF-1.4\n%%EOF\n");
    const source = await Zotero.Attachments.importFromFile({
      file: pdf,
      contentType: "application/pdf",
    });
    const originalWrite = IOUtils.writeUTF8;
    let result: Zotero.Item | undefined;
    try {
      const packageDir = temp.clone();
      packageDir.append("package");
      packageDir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
      await write(packageDir, "markdown.md", "# A\n");
      await write(packageDir, "middle_json.json", "{}\n");
      await write(packageDir, "provenance.json", "{}\n");
      (IOUtils as any).writeUTF8 = async (
        path: string,
        content: string,
        options?: WriteOptions,
      ) => {
        if (content.includes('"phase":"committed"')) {
          throw new Error("injected journal write failure");
        }
        return originalWrite(path, content, options);
      };
      let failure = "";
      try {
        await publishValidatedPackage({
          packageDirectory: packageDir.path,
          sourcePDF: source,
          title: "recover committed result",
        });
      } catch (error) {
        failure = String(error);
      }
      assert.match(failure, /injected journal write failure/);
      result = (await Zotero.Items.getAll(source.libraryID)).find(
        (item) => item.getField("title") === "recover committed result",
      );
      assert.isDefined(result);
      (IOUtils as any).writeUTF8 = originalWrite;
      assert.deepEqual(await recoverIncompletePublications(), {
        committed: 1,
        rolledBack: 0,
      });
      assert.equal(
        (
          await Zotero.Items.getByLibraryAndKeyAsync(
            result!.libraryID,
            result!.key,
          )
        )?.id,
        result!.id,
      );
    } finally {
      (IOUtils as any).writeUTF8 = originalWrite;
      if (result) await result.eraseTx();
      await source.eraseTx();
      temp.remove(true);
    }
  });

  it("rolls back a new item when storage publication fails", async function () {
    const temp = temporaryDirectory();
    const pdf = temp.clone();
    pdf.append("source.pdf");
    await Zotero.File.putContentsAsync(pdf, "%PDF-1.4\n%%EOF\n");
    const source = await Zotero.Attachments.importFromFile({
      file: pdf,
      contentType: "application/pdf",
    });
    const originalMove = IOUtils.move;
    try {
      const packageDir = temp.clone();
      packageDir.append("package");
      packageDir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
      await write(packageDir, "markdown.md", "# A\n");
      await write(packageDir, "middle_json.json", "{}\n");
      await write(packageDir, "provenance.json", "{}\n");
      (IOUtils as any).move = async (
        from: string,
        to: string,
        options?: MoveOptions,
      ) => {
        if (PathUtils.filename(from).startsWith("tmp-mineru-")) {
          throw new Error("injected storage move failure");
        }
        return originalMove(from, to, options);
      };
      const before = (await Zotero.Items.getAll(source.libraryID)).length;
      let failure = "";
      try {
        await publishValidatedPackage({
          packageDirectory: packageDir.path,
          sourcePDF: source,
        });
      } catch (error) {
        failure = String(error);
      }
      assert.match(failure, /injected storage move failure/);
      assert.equal(
        (await Zotero.Items.getAll(source.libraryID)).length,
        before,
      );
      assert.isTrue(await source.fileExists());
      assert.deepEqual(await recoverIncompletePublications(), {
        committed: 0,
        rolledBack: 0,
      });
    } finally {
      (IOUtils as any).move = originalMove;
      await source.eraseTx();
      temp.remove(true);
    }
  });

  it("publishes next to the exact child PDF under its current parent", async function () {
    const temp = temporaryDirectory();
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Parent for MinerU test");
    await parent.saveTx();
    const pdf = temp.clone();
    pdf.append("source.pdf");
    await Zotero.File.putContentsAsync(pdf, "%PDF-1.4\n%%EOF\n");
    const source = await Zotero.Attachments.importFromFile({
      file: pdf,
      contentType: "application/pdf",
      parentItemID: parent.id,
    });
    let result: Zotero.Item | undefined;
    try {
      const packageDir = temp.clone();
      packageDir.append("package");
      packageDir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
      await write(packageDir, "markdown.md", "# A\n");
      await write(packageDir, "middle_json.json", "{}\n");
      await write(packageDir, "provenance.json", "{}\n");
      result = await publishValidatedPackage({
        packageDirectory: packageDir.path,
        sourcePDF: source,
      });
      assert.equal(result.parentItemID, parent.id);
      assert.deepEqual(result.getRelationsByPredicate("dc:relation"), [
        Zotero.URI.getItemURI(source),
      ]);
      assert.match(
        result.getField("title") as string,
        /^MinerU — \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/,
      );
    } finally {
      if (result) await result.eraseTx();
      await source.eraseTx();
      await parent.eraseTx();
      temp.remove(true);
    }
  });
});
