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
  mtime?: number;
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

type StorageLocal = {
  SYNC_STATE_TO_UPLOAD: number;
  SYNC_STATE_IN_SYNC: number;
  checkFileModTime(item: Zotero.Item, local: number, remote: number): boolean;
};

function storageLocal(): StorageLocal {
  return (Zotero.Sync.Storage as unknown as { Local: StorageLocal }).Local;
}

function syncSettings() {
  const runner = Zotero.Sync.Runner;
  const data = Boolean(runner.enabled);
  return {
    active: runner.syncInProgress,
    data,
    files: data && Boolean(Zotero.Prefs.get("sync.storage.enabled")),
  };
}

function journalPath() {
  return PathUtils.join(
    Zotero.DataDirectory.dir,
    "mineru-markdown-rename.json",
  );
}

/** Startup repairs only the single move already journaled by an earlier run. */
export async function recoverLegacyMarkdownRename(): Promise<void> {
  const journal = journalPath();
  if (!occupied(journal)) return;
  if (!regularFile(journal)) throw new Error("Unsafe MinerU Markdown journal");
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
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    (record.mtime !== undefined && !Number.isSafeInteger(record.mtime))
  )
    throw new Error("Invalid MinerU Markdown rename journal");

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
    if (!directory) throw new Error("Missing MinerU Markdown directory");
    const original = PathUtils.join(directory, EXPORT_MARKDOWN);
    const target = PathUtils.join(directory, record.filename);
    if (!occupied(original)) {
      if (
        !regularFile(target) ||
        (await IOUtils.computeHexDigest(target, "sha256")) !== record.sha256
      )
        throw new Error(
          "Pending MinerU Markdown rename could not verify its file",
        );
      // Undo the disk-only move; keep Zotero's path and sync state as they were.
      if (record.mtime !== undefined)
        await IOUtils.setModificationTime(target, record.mtime);
      await IOUtils.move(target, original, { noOverwrite: true });
    }
  }
  await IOUtils.remove(journal);
}

type Candidate = Pick<Rename, "key" | "sourceURI" | "filename"> & {
  id: number;
};

async function candidate(item: Zotero.Item) {
  if (!item.isEditable()) return;
  const sources = item.getRelationsByPredicate("dc:relation");
  if (sources.length !== 1) return;
  const identity = Zotero.URI.getURIItemLibraryKey(sources[0]);
  if (!identity || !identity.key || identity.libraryID !== item.libraryID)
    return;
  const source = await Zotero.Items.getByLibraryAndKeyAsync(
    identity.libraryID,
    identity.key,
  );
  if (!source || source.deleted || !source.isPDFAttachment()) return;
  const sourcePath = await source.getFilePathAsync();
  if (!sourcePath) return;
  const filename = markdownFilename(PathUtils.filename(sourcePath));
  if (filename === EXPORT_MARKDOWN) return;
  const directory = resultDirectory(item);
  if (!directory) return;
  const original = PathUtils.join(directory, EXPORT_MARKDOWN);
  const target = PathUtils.join(directory, filename);
  if (!regularFile(original) || occupied(target)) return;
  return { source, original, target, filename, sourceURI: sources[0] };
}

async function syncPending(
  item: Zotero.Item,
  match: NonNullable<Awaited<ReturnType<typeof candidate>>>,
  sync: ReturnType<typeof syncSettings>,
): Promise<boolean> {
  const local = storageLocal();
  if (sync.data && (!item.synced || !match.source.synced)) return true;
  if (!sync.files)
    return ![local.SYNC_STATE_TO_UPLOAD, local.SYNC_STATE_IN_SYNC].includes(
      item.attachmentSyncState as number,
    );
  // Zotero's file watcher may not have marked a local edit for upload yet.
  return (
    item.attachmentSyncState !== local.SYNC_STATE_IN_SYNC ||
    (match.source.isStoredFileAttachment() &&
      match.source.attachmentSyncState !== local.SYNC_STATE_IN_SYNC) ||
    !item.attachmentSyncedHash ||
    !item.attachmentSyncedModificationTime ||
    (await item.attachmentHash) !== item.attachmentSyncedHash
  );
}

export async function previewLegacyMarkdownMigration() {
  const library = Zotero.Libraries.userLibrary;
  const sync = syncSettings();
  const candidates: Candidate[] = [];
  let skipped = 0;
  let skippedSync = 0;
  if (!sync.active && library.editable && library.filesEditable) {
    const ids = await Zotero.DB.columnQueryAsync<number>(
      `SELECT itemID FROM itemAttachments JOIN items USING (itemID)
       WHERE libraryID = ? AND contentType = 'text/markdown' AND path = ?`,
      [library.libraryID, legacyPath],
    );
    for (const id of ids) {
      const item = await Zotero.Items.getAsync(id);
      if (!item) continue;
      await item.loadAllData();
      if (!isLegacyResult(item)) continue;
      const match = await candidate(item);
      if (!match) {
        skipped++;
        continue;
      }
      if (await syncPending(item, match, sync)) {
        skippedSync++;
        continue;
      }
      candidates.push({
        id,
        key: item.key,
        sourceURI: match.sourceURI,
        filename: match.filename,
      });
    }
  }
  return {
    candidates,
    skipped,
    skippedSync,
    blocked: sync.active || syncChanged(sync),
    sync,
  };
}

export type MarkdownMigrationPreview = Awaited<
  ReturnType<typeof previewLegacyMarkdownMigration>
>;

function syncChanged(previous: ReturnType<typeof syncSettings>) {
  const sync = syncSettings();
  return (
    sync.active || sync.data !== previous.data || sync.files !== previous.files
  );
}

// Zotero's WebDAV comparison treats equal hashes and matching mtimes as
// already uploaded. Keep the remote baseline intact for conflict detection,
// and give the renamed file a distinguishable local mtime instead.
async function markFileForUpload(item: Zotero.Item, target: string) {
  const remote = item.attachmentSyncedModificationTime;
  if (remote) {
    const local = storageLocal();
    let mtime = Date.now();
    while (!local.checkFileModTime(item, mtime, remote)) mtime -= 4000;
    await IOUtils.setModificationTime(target, mtime);
    const actual = (await IOUtils.stat(target)).lastModified;
    if (actual === undefined || !local.checkFileModTime(item, actual, remote))
      throw new Error("Could not distinguish renamed Markdown for file sync");
  }
  item.attachmentSyncState = "to_upload";
}

export async function migrateLegacyMarkdown(preview: MarkdownMigrationPreview) {
  let renamed = 0;
  let skipped = preview.skipped;
  let skippedSync = preview.skippedSync;
  let blocked = preview.blocked || syncChanged(preview.sync);
  let failed = false;
  const journal = journalPath();
  if (!blocked && occupied(journal)) {
    // An earlier attempt in this session may have stopped after its disk move.
    await recoverLegacyMarkdownRename();
  }
  for (const entry of preview.candidates) {
    if (blocked || syncChanged(preview.sync)) {
      blocked = true;
      break;
    }
    const item = await Zotero.Items.getAsync(entry.id);
    if (item) await item.loadAllData();
    const match =
      item && item.key === entry.key && isLegacyResult(item)
        ? await candidate(item)
        : undefined;
    if (
      !item ||
      !match ||
      match.filename !== entry.filename ||
      match.sourceURI !== entry.sourceURI
    ) {
      skipped++;
      continue;
    }
    try {
      const record: Rename = {
        key: entry.key,
        sourceURI: entry.sourceURI,
        filename: entry.filename,
        sha256: await IOUtils.computeHexDigest(match.original, "sha256"),
        mtime: (await IOUtils.stat(match.original)).lastModified,
      };
      // The transaction serializes the Zotero path update against incoming
      // data sync. Never start a move while the native sync runner is active.
      const outcome = await Zotero.DB.executeTransaction(async () => {
        if (syncChanged(preview.sync)) return "blocked";
        const pending = await syncPending(item, match, preview.sync);
        if (syncChanged(preview.sync)) return "blocked";
        if (pending) return "skipped-sync";
        await IOUtils.writeUTF8(journal, JSON.stringify(record), {
          tmpPath: `${journal}.tmp`,
          flush: true,
        });
        if (
          (await IOUtils.computeHexDigest(match.original, "sha256")) !==
          record.sha256
        )
          throw new Error("Markdown changed before rename");
        if (syncChanged(preview.sync)) return "blocked";
        await IOUtils.move(match.original, match.target, { noOverwrite: true });
        await markFileForUpload(item, match.target);
        item.attachmentFilename = entry.filename;
        await item.save({
          skipDateModifiedUpdate: true,
          notifierData: { skipAutoSync: true },
        });
        return "renamed";
      });
      if (outcome === "renamed") renamed++;
      if (outcome === "skipped-sync") {
        skippedSync++;
        continue;
      }
      await IOUtils.remove(journal, { ignoreAbsent: true });
      if (outcome === "blocked") {
        blocked = true;
        break;
      }
    } catch (error) {
      Zotero.logError(error as Error);
      await recoverLegacyMarkdownRename().catch((recoveryError) =>
        Zotero.logError(recoveryError as Error),
      );
      failed = true;
      break;
    }
  }
  return { renamed, skipped, skippedSync, blocked, failed };
}
