/** Zotero 10.0.3 stored-attachment publication for a previously validated package. */

const MAIN_FILE = "markdown.md";
const SENTINEL = "zotero-mineru-generation:v1";
const JOURNAL_DIR = "mineru-publication-journal";

type FileRecord = { path: string; size: number; sha256: string };
type PackageRecord = { files: FileRecord[]; directories: string[] };
type Identity = {
  id: number;
  key: string;
  libraryID: number;
  dateAdded: string;
  title: string;
  sourceURI: string;
  parentID: number | false;
  collections: number[];
};
type Journal = {
  version: 1;
  token: string;
  phase: "staging" | "publishing" | "committed";
  package: PackageRecord;
  identity?: Identity;
};

export type PublicationRequest = {
  /** Root of a fully validated export, including provenance.json. */
  packageDirectory: string;
  /** The exact PDF attachment selected for this parse. */
  sourcePDF: Zotero.Item;
  /** Optional display title. The default is local creation time with UTC offset. */
  title?: string;
  /** Prevent a new publication after plugin shutdown. */
  signal?: AbortSignal;
};

export type RecoveryResult = { committed: number; rolledBack: number };

/** Cleanup could not finish; the journal must be retried at startup. */
export class PublicationRecoveryError extends AggregateError {
  constructor(
    publicationError: unknown,
    cleanupError: unknown,
    public readonly kind: "rollback" | "finalization" = "rollback",
  ) {
    super(
      [publicationError, cleanupError],
      "Publication failed; recovery journal retained",
    );
  }
}

let active = false;

function pathFor(...parts: string[]): string {
  return PathUtils.join(...parts);
}

function journalDirectory(): string {
  return pathFor(Zotero.DataDirectory.dir, JOURNAL_DIR);
}

function journalPath(token: string): string {
  return pathFor(journalDirectory(), `${token}.json`);
}

function storageDirectory(): string {
  return Zotero.getStorageDirectory().path;
}

function stagePath(token: string): string {
  return pathFor(storageDirectory(), `tmp-mineru-${token}`);
}

function finalPath(key: string): string {
  return pathFor(storageDirectory(), key);
}

async function saveJournal(journal: Journal): Promise<void> {
  await IOUtils.makeDirectory(journalDirectory(), {
    createAncestors: true,
    ignoreExisting: true,
    permissions: 0o700,
  });
  const path = journalPath(journal.token);
  await IOUtils.writeUTF8(path, JSON.stringify(journal), {
    tmpPath: `${path}.tmp`,
    flush: true,
  });
}

async function removeJournal(journal: Journal): Promise<void> {
  await IOUtils.remove(journalPath(journal.token), { ignoreAbsent: true });
}

function assertName(name: string): void {
  const validName = (
    Zotero.File as typeof Zotero.File & {
      getValidFileName(name: string): string;
    }
  ).getValidFileName(name);
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name !== validName
  ) {
    throw new Error(
      `Package path cannot round-trip through Zotero storage: ${name}`,
    );
  }
}

async function describeTree(root: string): Promise<PackageRecord> {
  const files: FileRecord[] = [];
  const directories: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const childPath of await IOUtils.getChildren(directory)) {
      const child = Zotero.File.pathToFile(childPath);
      const name = child.leafName;
      assertName(name);
      if (child.isSymlink()) throw new Error(`Package symlink: ${childPath}`);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (child.isDirectory()) {
        directories.push(relative);
        await walk(childPath, relative);
      } else if (child.isFile()) {
        const stat = await IOUtils.stat(childPath);
        files.push({
          path: relative,
          size: stat.size ?? -1,
          sha256: await IOUtils.computeHexDigest(childPath, "sha256"),
        });
      } else {
        throw new Error(`Package special file: ${childPath}`);
      }
    }
  };
  const rootFile = Zotero.File.pathToFile(root);
  if (!rootFile.exists() || !rootFile.isDirectory() || rootFile.isSymlink()) {
    throw new Error("Validated package directory is unavailable");
  }
  await walk(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  directories.sort();
  if (
    ![MAIN_FILE, "middle_json.json", "provenance.json"].every((name) =>
      files.some((file) => file.path === name),
    )
  ) {
    throw new Error("Validated package is missing a required root file");
  }
  for (const dir of directories) {
    if (!files.some((file) => file.path.startsWith(`${dir}/`))) {
      throw new Error(`Empty package directory cannot round-trip: ${dir}`);
    }
  }
  return { files, directories };
}

function samePackage(a: PackageRecord, b: PackageRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function assertPackage(
  root: string,
  expected: PackageRecord,
): Promise<void> {
  if (!samePackage(await describeTree(root), expected)) {
    throw new Error(
      "Published attachment file tree differs from the validated package",
    );
  }
}

async function copyPackage(
  source: string,
  target: string,
  record: PackageRecord,
): Promise<void> {
  await IOUtils.makeDirectory(target, { permissions: 0o755 });
  for (const directory of record.directories) {
    await IOUtils.makeDirectory(pathFor(target, ...directory.split("/")), {
      permissions: 0o755,
    });
  }
  for (const file of record.files) {
    const parts = file.path.split("/");
    await IOUtils.copy(pathFor(source, ...parts), pathFor(target, ...parts), {
      noOverwrite: true,
    });
    await Zotero.File.setNormalFilePermissions(pathFor(target, ...parts));
  }
  await assertPackage(target, record);
}

/** Verify the exact file names Zotero's recursive ZIP exporter will upload. */
async function assertZipContents(
  root: string,
  record: PackageRecord,
  token: string,
): Promise<void> {
  const zipPath = pathFor(journalDirectory(), `${token}.zip`);
  try {
    if ((await Zotero.File.zipDirectory(root, zipPath, null)) === false) {
      throw new Error("Zotero could not create the attachment upload ZIP");
    }
    const zip = Zotero.File.pathToFile(zipPath);
    const reader = (Components.classes as any)[
      "@mozilla.org/libjar/zip-reader;1"
    ].createInstance(Components.interfaces.nsIZipReader);
    try {
      reader.open(zip);
      reader.test(null);
      const actual: string[] = [];
      const entries = reader.findEntries(null);
      while (entries.hasMore()) {
        const name = entries.getNext();
        if (!reader.getEntry(name).isDirectory) actual.push(name);
      }
      actual.sort();
      const expected = record.files.map((file) => file.path).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error("Zotero upload ZIP omits or renames a package file");
      }
    } finally {
      reader.close();
    }
  } finally {
    await IOUtils.remove(zipPath, { ignoreAbsent: true });
  }
}

function titleAt(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `MinerU — ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

async function currentSource(source: Zotero.Item): Promise<{
  item: Zotero.Item;
  parentID: number | false;
  collections: number[];
  sourceURI: string;
}> {
  const item = await Zotero.Items.getAsync(source.id);
  if (
    !item ||
    item.key !== source.key ||
    item.libraryID !== source.libraryID ||
    !item.isAttachment() ||
    item.deleted ||
    !item.isPDFAttachment()
  ) {
    throw new Error("Source PDF changed or is unavailable before publication");
  }
  const library = Zotero.Libraries.get(item.libraryID);
  if (
    !library ||
    !library.editable ||
    !library.filesEditable ||
    !item.isEditable()
  ) {
    throw new Error("Library does not permit item and file editing");
  }
  const parentID = item.parentItemID || false;
  if (parentID) {
    const parent = await Zotero.Items.getAsync(parentID);
    if (
      !parent ||
      parent.deleted ||
      parent.libraryID !== item.libraryID ||
      !parent.isEditable()
    ) {
      throw new Error("Source PDF parent changed or is not editable");
    }
  }
  return {
    item,
    parentID,
    collections: parentID ? [] : item.getCollections(),
    sourceURI: Zotero.URI.getItemURI(item),
  };
}

function identityMatches(item: Zotero.Item, identity: Identity): boolean {
  return (
    item.id === identity.id &&
    item.key === identity.key &&
    item.libraryID === identity.libraryID &&
    item.dateAdded === identity.dateAdded &&
    item.isStoredFileAttachment() &&
    item.attachmentPath === `storage:${MAIN_FILE}` &&
    item.attachmentContentType === "text/markdown" &&
    item.getField("title") === identity.title &&
    item.note === SENTINEL &&
    item.getRelationsByPredicate("dc:relation").length === 1 &&
    item.hasRelation("dc:relation", identity.sourceURI) &&
    (item.parentItemID || false) === identity.parentID &&
    JSON.stringify([...item.getCollections()].sort()) ===
      JSON.stringify([...identity.collections].sort())
  );
}

async function uploadEligible(item: Zotero.Item): Promise<boolean> {
  const local = (
    Zotero.Sync.Storage as typeof Zotero.Sync.Storage & {
      Local: {
        SYNC_STATE_TO_UPLOAD: number;
        SYNC_STATE_FORCE_UPLOAD: number;
        getFilesToUpload(libraryID: number): Promise<number[]>;
      };
    }
  ).Local;
  return (
    (item.attachmentSyncState === local.SYNC_STATE_TO_UPLOAD ||
      item.attachmentSyncState === local.SYNC_STATE_FORCE_UPLOAD) &&
    (await local.getFilesToUpload(item.libraryID)).includes(item.id)
  );
}

async function verifyCommitted(
  journal: Journal,
  item: Zotero.Item,
  requireUpload: boolean,
): Promise<boolean> {
  const identity = journal.identity;
  if (!identity || !identityMatches(item, identity)) return false;
  if (!(await IOUtils.exists(finalPath(identity.key)))) return false;
  const current = await describeTree(finalPath(identity.key));
  if (!samePackage(current, journal.package)) return false;
  // Once Zotero sync has run, a completed attachment may be in_sync. Recovery
  // must keep it even when it is no longer queued for upload.
  if (!requireUpload || (await uploadEligible(item))) return true;
  // Metadata sync may have already consumed the upload queue after the DB
  // transaction committed. In that case the item is no longer upload-eligible.
  await item.loadAllData(true);
  return (
    item.attachmentSyncState ===
    (
      Zotero.Sync.Storage as typeof Zotero.Sync.Storage & {
        Local: { SYNC_STATE_IN_SYNC: number };
      }
    ).Local.SYNC_STATE_IN_SYNC
  );
}

async function recoverOne(
  journal: Journal,
): Promise<"committed" | "rolledBack"> {
  const identity = journal.identity;
  if (journal.phase === "committed") {
    await IOUtils.remove(stagePath(journal.token), {
      recursive: true,
      ignoreAbsent: true,
    });
    await removeJournal(journal);
    return "committed";
  }
  if (!identity) {
    await IOUtils.remove(stagePath(journal.token), {
      recursive: true,
      ignoreAbsent: true,
    });
    await removeJournal(journal);
    return "rolledBack";
  }
  if (
    !/^[A-Z0-9]{8}$/.test(identity.key) ||
    !Number.isSafeInteger(identity.id) ||
    identity.id <= 0 ||
    !Number.isSafeInteger(identity.libraryID)
  ) {
    throw new Error("Recovery journal contains an invalid attachment identity");
  }
  const item = await Zotero.Items.getByLibraryAndKeyAsync(
    identity.libraryID,
    identity.key,
  );
  if (item) {
    if (!identityMatches(item, identity)) {
      throw new Error(
        `Recovery identity mismatch for new attachment ${identity.key}`,
      );
    }
    try {
      if (await verifyCommitted(journal, item, false)) {
        journal.phase = "committed";
        await saveJournal(journal);
        await IOUtils.remove(stagePath(journal.token), {
          recursive: true,
          ignoreAbsent: true,
        });
        await removeJournal(journal);
        return "committed";
      }
    } catch (error) {
      // Unknown I/O errors cannot establish incompleteness. Keep the item and
      // journal for a later retry instead of deleting a potentially synced item.
      if (
        !(error instanceof Error) ||
        !/Validated package directory is unavailable|Validated package is missing a required root file|Empty package directory cannot round-trip/.test(
          error.message,
        )
      ) {
        throw error;
      }
    }
    await item.eraseTx();
    if (
      await Zotero.Items.getByLibraryAndKeyAsync(
        identity.libraryID,
        identity.key,
      )
    ) {
      throw new Error(`New attachment ${identity.key} could not be erased`);
    }
  }
  // Item erase can swallow file-removal errors in Zotero 10. Check separately.
  await IOUtils.remove(finalPath(identity.key), {
    recursive: true,
    ignoreAbsent: true,
  });
  await IOUtils.remove(stagePath(journal.token), {
    recursive: true,
    ignoreAbsent: true,
  });
  await removeJournal(journal);
  return "rolledBack";
}

/** Resolve only this plugin's journal entries; never scan or delete old results. */
export async function recoverIncompletePublications(): Promise<RecoveryResult> {
  if (active) throw new Error("Publication or recovery is already running");
  active = true;
  const result = { committed: 0, rolledBack: 0 };
  const failures: Error[] = [];
  try {
    if (!(await IOUtils.exists(journalDirectory()))) return result;
    for (const path of await IOUtils.getChildren(journalDirectory())) {
      if (!/^[0-9a-f-]{36}\.json$/.test(PathUtils.filename(path))) continue;
      try {
        const journal = JSON.parse(await IOUtils.readUTF8(path)) as Journal;
        if (
          journal.version !== 1 ||
          journalPath(journal.token) !== path ||
          !["staging", "publishing", "committed"].includes(journal.phase)
        ) {
          throw new Error(`Invalid publication journal ${path}`);
        }
        const outcome = await recoverOne(journal);
        result[outcome]++;
      } catch (error) {
        failures.push(new Error(`Could not recover ${path}: ${String(error)}`));
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Publication recovery incomplete");
    return result;
  } finally {
    active = false;
  }
}

/** Publish one already validated package as a new stored attachment. */
export async function publishValidatedPackage(
  request: PublicationRequest,
): Promise<Zotero.Item> {
  if (active) throw new Error("Publication or recovery is already running");
  active = true;
  let journal: Journal | undefined;
  try {
    if (request.signal?.aborted) throw new Error("MinerU task stopped");
    const packageRecord = await describeTree(request.packageDirectory);
    await currentSource(request.sourcePDF);
    const token = crypto.randomUUID();
    journal = { version: 1, token, phase: "staging", package: packageRecord };
    await saveJournal(journal);
    await copyPackage(
      request.packageDirectory,
      stagePath(token),
      packageRecord,
    );
    await assertZipContents(stagePath(token), packageRecord, token);

    let created: Zotero.Item | undefined;
    await Zotero.DB.executeTransaction(async () => {
      if (request.signal?.aborted) throw new Error("MinerU task stopped");
      const source = await currentSource(request.sourcePDF);
      const item = new Zotero.Item("attachment");
      item.libraryID = source.item.libraryID;
      item.parentItemID = source.parentID;
      if (!source.parentID) item.setCollections(source.collections);
      const title = request.title ?? titleAt(new Date());
      item.setField("title", title);
      item.attachmentLinkMode = Zotero.Attachments.LINK_MODE_IMPORTED_FILE;
      item.attachmentContentType = "text/markdown";
      item.attachmentPath = `storage:${MAIN_FILE}`;
      item.attachmentSyncState = "to_upload";
      item.setNote(SENTINEL);
      item.addRelation("dc:relation", source.sourceURI);
      await item.save({ skipSelect: true });
      const dest = finalPath(item.key);
      if (await IOUtils.exists(dest))
        throw new Error("New attachment storage key already exists");
      journal!.phase = "publishing";
      journal!.identity = {
        id: item.id,
        key: item.key,
        libraryID: item.libraryID,
        dateAdded: item.dateAdded,
        title,
        sourceURI: source.sourceURI,
        parentID: source.parentID,
        collections: source.collections,
      };
      await saveJournal(journal!);
      await IOUtils.move(stagePath(token), dest, { noOverwrite: true });
      await assertPackage(dest, packageRecord);
      if (
        !identityMatches(item, journal!.identity) ||
        !(await uploadEligible(item))
      ) {
        throw new Error(
          "New attachment metadata or upload state is incomplete",
        );
      }
      if (request.signal?.aborted) throw new Error("MinerU task stopped");
      created = item;
    });
    if (!created || !(await verifyCommitted(journal, created, true))) {
      throw new Error("Published attachment failed post-commit verification");
    }
    journal.phase = "committed";
    await saveJournal(journal);
    await removeJournal(journal);
    return created;
  } catch (error) {
    if (journal?.phase === "committed") {
      if (await IOUtils.exists(journalPath(journal.token)).catch(() => true)) {
        throw new PublicationRecoveryError(
          error,
          new Error("Committed attachment journal finalization incomplete"),
          "finalization",
        );
      }
    } else {
      try {
        if (journal) await recoverOne(journal);
      } catch (cleanupError) {
        throw new PublicationRecoveryError(error, cleanupError);
      }
    }
    throw error;
  } finally {
    active = false;
  }
}
