/** Rename legacy results in the personal library without recreating attachments. */
import {
  EXPORT_MARKDOWN,
  LEGACY_GENERATION_MARKER,
  isMarkdownFilename,
  matchesGenerationMarker,
  markdownFilename,
} from "./markdownFilename";

const legacyPath = `storage:${EXPORT_MARKDOWN}`;
type Rename = {
  key: string;
  sourceURI: string;
  filename: string;
  sha256: string;
};

function isLegacyResult(item: Zotero.Item): boolean {
  return (
    item.libraryID === Zotero.Libraries.userLibraryID &&
    !item.deleted &&
    item.isStoredFileAttachment() &&
    item.attachmentContentType === "text/markdown" &&
    item.attachmentPath === legacyPath &&
    matchesGenerationMarker(item.note, LEGACY_GENERATION_MARKER)
  );
}

function resultDirectory(item: Zotero.Item): string | undefined {
  const directory = Zotero.Attachments.getStorageDirectory(item);
  if (!directory.isDirectory() || directory.isSymlink()) return;
  const resolved = directory.clone();
  resolved.normalize();
  if (resolved.path === directory.path) return directory.path;
}

function regularFile(path: string): boolean {
  const file = Zotero.File.pathToFile(path);
  return file.exists() && !file.isSymlink() && file.isFile();
}

function occupied(path: string): boolean {
  const file = Zotero.File.pathToFile(path);
  try {
    // Check the directory entry as well as its referent, including broken links.
    return file.isSymlink() || file.exists();
  } catch (error) {
    if (
      (error as { result?: number }).result ===
      Components.results.NS_ERROR_FILE_NOT_FOUND
    )
      return false;
    throw error;
  }
}

function uploadAllowed(item: Zotero.Item): boolean {
  const local = (
    Zotero.Sync.Storage as typeof Zotero.Sync.Storage & {
      Local: {
        SYNC_STATE_TO_UPLOAD: number;
        SYNC_STATE_IN_SYNC: number;
        SYNC_STATE_FORCE_UPLOAD: number;
      };
    }
  ).Local;
  return [
    local.SYNC_STATE_TO_UPLOAD,
    local.SYNC_STATE_IN_SYNC,
    local.SYNC_STATE_FORCE_UPLOAD,
  ].includes(item.attachmentSyncState as number);
}

async function finishRename(record: Rename, journal: string): Promise<void> {
  const item = await Zotero.Items.getByLibraryAndKeyAsync(
    Zotero.Libraries.userLibraryID,
    record.key,
  );
  if (item) await item.loadAllData();
  if (
    item &&
    isLegacyResult(item) &&
    item.hasRelation("dc:relation", record.sourceURI)
  ) {
    const directory = resultDirectory(item);
    if (!directory || !item.isEditable() || !uploadAllowed(item))
      throw new Error("Cannot finish the pending MinerU Markdown rename");
    const original = PathUtils.join(directory, EXPORT_MARKDOWN);
    const target = PathUtils.join(directory, record.filename);
    if (occupied(original)) {
      // If a second file has appeared, leave both untouched and keep using the
      // path Zotero already knows about.
      if (occupied(target)) {
        await IOUtils.remove(journal);
        return;
      }
      if (
        !regularFile(original) ||
        (await IOUtils.computeHexDigest(original, "sha256")) !== record.sha256
      ) {
        // The original is still in place, but it changed since we planned the move.
        await IOUtils.remove(journal);
        return;
      }
      await IOUtils.move(original, target, { noOverwrite: true });
    }

    // An interruption after the move leaves Zotero pointing to the old path.
    // Only adopt the destination if it is the file we journaled.
    if (
      !regularFile(target) ||
      (await IOUtils.computeHexDigest(target, "sha256")) !== record.sha256
    ) {
      throw new Error(
        "Pending MinerU Markdown rename could not verify its file",
      );
    }
    item.attachmentFilename = record.filename;
    // The file bytes are unchanged, but the multifile upload ZIP must be rebuilt.
    item.attachmentSyncState = "force_upload";
    await item.saveTx({ skipDateModifiedUpdate: true });
  }
  await IOUtils.remove(journal);
}

export async function migrateLegacyMarkdown(): Promise<void> {
  const library = Zotero.Libraries.userLibrary;
  if (!library.editable || !library.filesEditable) return;
  const journal = PathUtils.join(
    Zotero.DataDirectory.dir,
    "mineru-markdown-rename.json",
  );
  if (occupied(journal)) {
    if (!regularFile(journal))
      throw new Error("Unsafe MinerU Markdown journal");
    const record = JSON.parse(await IOUtils.readUTF8(journal)) as Rename;
    if (
      !record ||
      typeof record.key !== "string" ||
      !/^[A-Z0-9]{8}$/.test(record.key) ||
      typeof record.sourceURI !== "string" ||
      typeof record.filename !== "string" ||
      !isMarkdownFilename(record.filename) ||
      record.filename === EXPORT_MARKDOWN ||
      typeof record.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    ) {
      throw new Error("Invalid MinerU Markdown rename journal");
    }
    await finishRename(record, journal);
  }

  // Query only legacy stored paths in the personal library, then check the
  // plugin marker and exact PDF relation before touching a file.
  const ids = await Zotero.DB.columnQueryAsync<number>(
    `SELECT itemID FROM itemAttachments JOIN items USING (itemID)
     WHERE libraryID = ? AND contentType = 'text/markdown' AND path = ?`,
    [library.libraryID, legacyPath],
  );
  for (const id of ids) {
    const item = await Zotero.Items.getAsync(id);
    if (!item) continue;
    await item.loadAllData();
    if (!isLegacyResult(item) || !item.isEditable() || !uploadAllowed(item))
      continue;
    const sources = item.getRelationsByPredicate("dc:relation");
    if (sources.length !== 1) continue;
    const identity = Zotero.URI.getURIItemLibraryKey(sources[0]);
    if (!identity || !identity.key || identity.libraryID !== library.libraryID)
      continue;
    const source = await Zotero.Items.getByLibraryAndKeyAsync(
      identity.libraryID,
      identity.key,
    );
    if (
      !source ||
      source.deleted ||
      source.libraryID !== item.libraryID ||
      !source.isPDFAttachment()
    ) {
      continue;
    }
    const sourcePath = await source.getFilePathAsync();
    if (!sourcePath) continue;
    const filename = markdownFilename(PathUtils.filename(sourcePath));
    if (filename === EXPORT_MARKDOWN) continue;
    const directory = resultDirectory(item);
    if (!directory) continue;
    const original = PathUtils.join(directory, EXPORT_MARKDOWN);
    if (
      !regularFile(original) ||
      occupied(PathUtils.join(directory, filename))
    ) {
      continue;
    }

    const record: Rename = {
      key: item.key,
      sourceURI: sources[0],
      filename,
      sha256: await IOUtils.computeHexDigest(original, "sha256"),
    };
    await IOUtils.writeUTF8(journal, JSON.stringify(record), {
      tmpPath: `${journal}.tmp`,
      flush: true,
    });
    await finishRename(record, journal);
  }
}
