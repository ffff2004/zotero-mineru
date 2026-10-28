/** Sole durable queue authority shared by the menu and local clients. */
import pkg from "../../../package.json";
import { MineruTaskController, type TaskView, type TaskSnapshot } from "./task";
import {
  currentTaskSettings,
  currentQueueLimit,
  explicitTaskOptions,
} from "./settings";
import { readCompatibleRuntime } from "./runtime";
import {
  findResults,
  inspectResult,
  describeSource,
  resolveSource,
  reusableResult,
  type ResultRecord,
  type SourceRecord,
} from "./results";
import {
  recoverIncompletePublications,
  type PublicationCompletion,
} from "./publication";
import { MineruTaskError } from "./parse";
import {
  MineruAPIError,
  identity,
  itemIdentity,
  type ItemIdentity,
} from "./apiError";
import type { ParseOptions } from "./package";
import { QueueStorage } from "./queueStorage";

export type TaskRecord = {
  taskID: string;
  state:
    | "queued"
    | "running"
    | "cancel_requested"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  phase: string;
  disposition: "created" | "reused_task" | "reused_result";
  source: ItemIdentity | SourceRecord;
  result?: ResultRecord;
  error?: { code: string; message: string; category?: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  execution?: {
    inputSha256: string;
    options: ParseOptions;
    runtime: { releaseID: string; profile: string };
    configurationSha256: string;
    environmentSha256: string;
  };
};
type Intent = {
  requestID: string;
  source: ItemIdentity;
  options: Partial<ParseOptions>;
  force: boolean;
};
type Entry = {
  record: TaskRecord;
  intent: Intent;
  requestKey: string;
  batchID?: string;
  attemptID?: string;
  completion?: PublicationCompletion & { reused?: boolean };
};
type InvalidItem = {
  index: number;
  error: { code: string; message: string; [key: string]: unknown };
};
type Batch = {
  batchID: string;
  requestID: string;
  requestKey: string;
  taskIDs: string[];
  invalid: InvalidItem[];
  createdAt: string;
};
type State = {
  version: 1;
  revision: number;
  paused: boolean;
  pending: string[];
  entries: Entry[];
  batches: Batch[];
};
export type BatchRecord = {
  batchID: string;
  createdAt: string;
  taskIDs: string[];
  tasks: TaskRecord[];
  expiredTaskIDs: string[];
  partialHistory: boolean;
  invalid: InvalidItem[];
};
export type QueueRecord = {
  paused: boolean;
  revision: number;
  limit: number;
  remainingCapacity: number;
  activeTaskID?: string;
  pending: TaskRecord[];
  recent: TaskRecord[];
  recoveryReady: boolean;
  storageReady: boolean;
};

const terminal = (state: TaskRecord["state"]) =>
  ["succeeded", "failed", "cancelled", "interrupted"].includes(state);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MineruAPIError(400, "invalid_request", "Expected a JSON object");
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value))
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, JSON.parse(canonical(child))]),
      ),
    );
  return JSON.stringify(value);
}
function digest(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hash = (Components.classes as any)[
    "@mozilla.org/security/hash;1"
  ].createInstance(Components.interfaces.nsICryptoHash) as nsICryptoHash;
  hash.initWithString("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), (character) =>
    character.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
}
function requestID(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
    throw new MineruAPIError(
      400,
      "invalid_request",
      "Provide a valid requestID",
    );
  return value;
}
function intent(value: unknown): Intent {
  const raw = object(value);
  if (
    Object.keys(raw).some(
      (key) => !["requestID", "source", "options", "force"].includes(key),
    ) ||
    (raw.force !== undefined && typeof raw.force !== "boolean")
  )
    throw new MineruAPIError(
      400,
      "invalid_request",
      "Provide requestID, source, supported options and optional force",
    );
  return {
    requestID: requestID(raw.requestID),
    source: identity(raw.source),
    options: explicitTaskOptions(raw.options ?? {}),
    force: raw.force === true,
  };
}
const intentKey = (value: Intent) =>
  canonical({
    source: value.source,
    options: value.options,
    force: value.force,
  });

/** No reset-on-error: malformed/unsupported snapshots leave every mutation blocked. */
function validatedState(value: unknown): State {
  const state = object(value) as unknown as State;
  const uuid = (id: unknown) =>
    typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    typeof state.paused !== "boolean" ||
    !Array.isArray(state.pending) ||
    !Array.isArray(state.entries) ||
    !Array.isArray(state.batches)
  )
    throw new Error("Unsupported or corrupt queue snapshot");
  const ids = new Set<string>();
  const requests = new Set<string>();
  let running = 0;
  for (const entry of state.entries) {
    const record = entry.record;
    if (
      !record ||
      !uuid(record.taskID) ||
      ids.has(record.taskID) ||
      ![
        "queued",
        "running",
        "cancel_requested",
        "succeeded",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(record.state) ||
      typeof record.phase !== "string" ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      (terminal(record.state) &&
        !Number.isFinite(Date.parse(record.completedAt || "")))
    )
      throw new Error("Invalid durable task");
    identity({
      libraryID: record.source.libraryID,
      itemKey: record.source.itemKey,
    });
    const requested = intent(entry.intent);
    if (
      requests.has(requested.requestID) ||
      intentKey(requested) !== entry.requestKey
    )
      throw new Error("Invalid durable request registration");
    if (["running", "cancel_requested"].includes(record.state)) {
      running++;
      if (!uuid(entry.attemptID))
        throw new Error("Missing durable execution identity");
    }
    if (entry.completion) {
      const receipt = entry.completion;
      if (
        receipt.taskID !== record.taskID ||
        receipt.attemptID !== entry.attemptID ||
        !uuid(receipt.token)
      )
        throw new Error("Invalid durable completion evidence");
      identity(receipt.result);
    }
    ids.add(record.taskID);
    requests.add(requested.requestID);
  }
  if (
    running > 1 ||
    new Set(state.pending).size !== state.pending.length ||
    state.pending.some(
      (id) =>
        !state.entries.some(
          (entry) =>
            entry.record.taskID === id && entry.record.state === "queued",
        ),
    ) ||
    state.entries.some(
      (entry) =>
        entry.record.state === "queued" &&
        !state.pending.includes(entry.record.taskID),
    )
  )
    throw new Error("Invalid durable queue order");
  const batches = new Set<string>();
  const batchRequests = new Set<string>();

  for (const batch of state.batches) {
    if (
      !uuid(batch.batchID) ||
      batches.has(batch.batchID) ||
      batchRequests.has(requestID(batch.requestID)) ||
      typeof batch.requestKey !== "string" ||
      !Array.isArray(batch.taskIDs) ||
      batch.taskIDs.length > 1000 ||
      batch.taskIDs.some((id) => !uuid(id)) ||
      !Array.isArray(batch.invalid) ||
      batch.invalid.length > 1000 ||
      !Number.isFinite(Date.parse(batch.createdAt))
    )
      throw new Error("Invalid durable batch");
    batches.add(batch.batchID);
    batchRequests.add(batch.requestID);
  }
  const owning = new Set(
    state.entries
      .filter((entry) => !terminal(entry.record.state) && entry.batchID)
      .map((entry) => entry.batchID),
  );
  if (state.batches.filter((batch) => !owning.has(batch.batchID)).length > 100)
    throw new Error("Unbounded batch metadata");
  for (const entry of state.entries) {
    if (
      entry.batchID &&
      !terminal(entry.record.state) &&
      !state.batches.some(
        (batch) =>
          batch.batchID === entry.batchID &&
          batch.taskIDs.includes(entry.record.taskID),
      )
    )
      throw new Error("Unfinished task lost its owning batch");
  }
  return state;
}

export class MineruTaskService {
  private controller = new MineruTaskController();
  private state: State = {
    version: 1,
    revision: 0,
    paused: true,
    pending: [],
    entries: [],
    batches: [],
  };
  private storage?: QueueStorage;
  private gate: Promise<unknown> = Promise.resolve();
  private ready = false;
  private recoveryReady = false;
  private storageReady = false;
  private loaded = false;
  private alive = true;
  private dispatching = false;
  private activeID?: string;
  private initialization?: Promise<void>;
  private views = new Map<string, TaskView>();
  private reports = new Map<string, (view: TaskView) => void>();

  constructor(private readonly options: { storageRoot?: string } = {}) {}

  /** Load durable state, recover publication first, reconcile exact owners, stay paused. */
  initialize(): Promise<void> {
    return (this.initialization ??= this.startup());
  }
  private async startup(): Promise<void> {
    this.storage = new QueueStorage(
      this.options.storageRoot ||
        PathUtils.join(
          Zotero.DataDirectory.dir,
          `${pkg.config.addonRef}-queue`,
        ),
    );
    try {
      const saved = await this.storage.read();
      if (saved !== undefined) this.state = validatedState(saved);
      this.loaded = true;
      this.storageReady = true;
      await this.mutate((candidate) => {
        candidate.paused = true;
      });
      // Recovery ACKs use the same durable commit gate, never a held execution lock.
      await recoverIncompletePublications((completion) =>
        this.acknowledge(completion),
      );
      await this.cleanOrphans();
      this.recoveryReady = true;
      await this.mutate(async (candidate) => {
        candidate.paused = true;
        for (const entry of candidate.entries) {
          if (!["running", "cancel_requested"].includes(entry.record.state))
            continue;
          // No running child survives this plugin instance. Clear only known owned paths.
          await this.removeScratch(entry);
          if (entry.completion) {
            const result = await Zotero.Items.getByLibraryAndKeyAsync(
              entry.completion.result.libraryID,
              entry.completion.result.itemKey,
            );
            if (!result)
              throw new Error(
                "Completion evidence references a missing attachment",
              );
            entry.record.result = await this.completedResult(entry, result);
            entry.record.state = "succeeded";
            entry.record.disposition = entry.completion.reused
              ? "reused_result"
              : "created";
            entry.record.phase = "done";
          } else {
            entry.record.state = "interrupted";
            entry.record.phase = "interrupted";
            entry.record.error = {
              code: "task_interrupted",
              message:
                "Execution outcome was not confirmed; retry explicitly with a fresh requestID",
            };
          }
          entry.record.updatedAt = entry.record.completedAt = now();
        }
      });
      this.ready = true;
    } catch (error) {
      this.recoveryReady = false;
      this.ready = true; // Status and retained records remain inspectable; mutations fail closed.
      throw error;
    }
  }

  get busy(): boolean {
    return !!this.activeID || this.controller.busy;
  }
  private requireReady(): void {
    if (!this.ready || !this.alive)
      throw new MineruAPIError(
        503,
        "plugin_not_ready",
        "Plugin startup is incomplete or stopped",
      );
    if (!this.storageReady)
      throw new MineruAPIError(
        503,
        "queue_storage_unavailable",
        "Queue storage requires inspection; no changes were acknowledged",
      );
    if (!this.recoveryReady)
      throw new MineruAPIError(
        503,
        "recovery_required",
        "Restart Zotero after resolving publication or cleanup recovery",
      );
  }
  private entry(state: State, id: string): Entry {
    const entry = state.entries.find((entry) => entry.record.taskID === id);
    if (!entry)
      throw new MineruAPIError(
        404,
        "task_not_found",
        "Task is unknown or its retained history expired",
      );
    return entry;
  }
  private mutate<T>(change: (candidate: State) => T | Promise<T>): Promise<T> {
    const operation = this.gate.then(async () => {
      if (!this.storageReady || !this.storage)
        throw new MineruAPIError(
          503,
          "queue_storage_unavailable",
          "Queue storage is unavailable",
        );
      const candidate = clone(this.state);
      const result = await change(candidate);
      const evicted = this.prune(candidate);
      candidate.revision++;
      try {
        await this.storage.write(candidate);
      } catch (error) {
        this.storageReady = false;
        throw new MineruAPIError(
          503,
          "queue_storage_unavailable",
          "Queue write could not be confirmed; restart after inspecting storage",
        );
      }
      this.state = candidate;
      // Retention never touches published attachments. Unsafe cleanup blocks dispatch.
      for (const id of evicted) {
        try {
          await IOUtils.remove(this.diagnosticsPath(id), {
            recursive: true,
            ignoreAbsent: true,
          });
        } catch (error) {
          this.recoveryReady = false;
          Zotero.logError(error as Error);
        }
        this.reports.delete(id);
      }
      return result;
    });
    this.gate = operation.catch(() => undefined);
    return operation;
  }
  private prune(candidate: State): string[] {
    const ended = candidate.entries
      .filter((entry) => terminal(entry.record.state))
      .sort((a, b) =>
        (b.record.completedAt || "").localeCompare(a.record.completedAt || ""),
      );
    const evicted = ended.slice(100).map((entry) => entry.record.taskID);
    candidate.entries = candidate.entries.filter(
      (entry) => !evicted.includes(entry.record.taskID),
    );
    const owning = new Set(
      candidate.entries
        .filter((entry) => !terminal(entry.record.state) && entry.batchID)
        .map((entry) => entry.batchID),
    );
    const retained = new Set(
      candidate.batches
        .filter((batch) => !owning.has(batch.batchID))
        .slice(-100)
        .map((batch) => batch.batchID),
    );
    candidate.batches = candidate.batches.filter(
      (batch) => owning.has(batch.batchID) || retained.has(batch.batchID),
    );
    return evicted;
  }
  private diagnosticsPath(id: string): string {
    return PathUtils.join(this.storage!.root, "diagnostics", id);
  }
  private scratchPath(entry: Entry): string {
    return PathUtils.join(
      this.storage!.root,
      "scratch",
      `${entry.record.taskID}-${entry.attemptID}`,
    );
  }
  private async removeScratch(entry: Entry): Promise<void> {
    if (!entry.attemptID) return;
    await IOUtils.remove(this.scratchPath(entry), {
      recursive: true,
      ignoreAbsent: true,
    });
  }

  private async cleanOrphans(): Promise<void> {
    for (const kind of ["scratch", "diagnostics"] as const) {
      const root = PathUtils.join(this.storage!.root, kind);
      if (!(await IOUtils.exists(root))) continue;
      for (const path of await IOUtils.getChildren(root)) {
        const name = PathUtils.filename(path);
        const expected =
          kind === "scratch"
            ? /^[0-9a-f-]{36}-[0-9a-f-]{36}$/
            : /^[0-9a-f-]{36}$/;
        if (!expected.test(name) || path !== PathUtils.join(root, name))
          throw new Error("Unexpected private queue cleanup path");
        if (
          kind === "scratch" ||
          !this.state.entries.some((entry) => entry.record.taskID === name)
        )
          await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
      }
    }
  }

  async status() {
    let runtime: {
      ready: boolean;
      releaseID?: string;
      profile?: string;
      error?: { code: string; message: string };
    };
    try {
      const settings = currentTaskSettings();
      const descriptor = await readCompatibleRuntime(
        settings.descriptorPath || undefined,
      );
      runtime = {
        ready: true,
        releaseID: descriptor.release_id,
        profile: descriptor.profile,
      };
    } catch {
      runtime = {
        ready: false,
        error: {
          code: "runtime_unavailable",
          message: "Check the companion runtime and plugin preferences",
        },
      };
    }
    return {
      protocolVersion: 2,
      plugin: {
        id: pkg.config.addonID,
        version: pkg.version,
        ready: this.ready && this.alive,
      },
      userLibraryID: Zotero.Libraries.userLibraryID,
      recoveryReady: this.recoveryReady,
      storageReady: this.storageReady,
      runtime,
      busy: this.busy,
      paused: this.state.paused,
    };
  }
  async results(source: unknown) {
    if (!this.ready)
      throw new MineruAPIError(
        503,
        "plugin_not_ready",
        "Plugin startup is incomplete",
      );
    return findResults(await resolveSource(source));
  }
  private requireLoaded(): void {
    if (!this.loaded)
      throw new MineruAPIError(
        503,
        "queue_storage_unavailable",
        "Queue history could not be loaded; inspect storage",
      );
  }
  get(taskID: string): TaskRecord {
    this.requireLoaded();
    const record = clone(this.entry(this.state, taskID).record);
    const view = this.views.get(taskID);
    if (view && !terminal(record.state)) record.phase = view.phase;
    return record;
  }
  getTask(taskID: string): TaskRecord {
    return this.get(taskID);
  }
  getQueue(): QueueRecord {
    this.requireLoaded();
    const limit = currentQueueLimit();
    return {
      paused: this.state.paused,
      revision: this.state.revision,
      limit,
      remainingCapacity: Math.max(0, limit - this.state.pending.length),
      activeTaskID:
        this.activeID ||
        this.state.entries.find((entry) =>
          ["running", "cancel_requested"].includes(entry.record.state),
        )?.record.taskID,
      pending: this.state.pending.map((id) => this.get(id)),
      recent: this.state.entries
        .filter((entry) => terminal(entry.record.state))
        .sort((a, b) =>
          (b.record.completedAt || "").localeCompare(
            a.record.completedAt || "",
          ),
        )
        .map((entry) => clone(entry.record)),
      recoveryReady: this.recoveryReady,
      storageReady: this.storageReady,
    };
  }
  getBatch(batchID: string): BatchRecord {
    this.requireLoaded();
    const batch = this.state.batches.find((batch) => batch.batchID === batchID);
    if (!batch)
      throw new MineruAPIError(
        404,
        "batch_not_found",
        "Batch is unknown or its retained manifest expired",
      );
    const tasks: TaskRecord[] = [];
    const expiredTaskIDs: string[] = [];
    for (const id of batch.taskIDs) {
      const entry = this.state.entries.find(
        (entry) => entry.record.taskID === id,
      );
      if (entry) tasks.push(clone(entry.record));
      else expiredTaskIDs.push(id);
    }
    return {
      batchID,
      createdAt: batch.createdAt,
      taskIDs: [...batch.taskIDs],
      tasks,
      expiredTaskIDs,
      partialHistory: !!expiredTaskIDs.length,
      invalid: clone(batch.invalid),
    };
  }
  private repeated(state: State, requested: Intent): TaskRecord | undefined {
    const existing = state.entries.find(
      (entry) => entry.intent.requestID === requested.requestID,
    );
    if (!existing) return undefined;
    if (existing.requestKey !== intentKey(requested))
      throw new MineruAPIError(
        409,
        "request_id_conflict",
        "This requestID was used with different inputs",
      );
    return {
      ...clone(existing.record),
      disposition:
        existing.record.disposition === "reused_result"
          ? "reused_result"
          : "reused_task",
    };
  }
  private async resolveRequested(
    requested: Intent,
    allowParent: boolean,
  ): Promise<ItemIdentity> {
    const source = await resolveSource(requested.source);
    if (!allowParent && source.key !== requested.source.itemKey)
      throw new MineruAPIError(
        400,
        "pdf_required",
        "Submit the selected PDF attachment key",
      );
    const library = Zotero.Libraries.get(source.libraryID);
    if (
      !library ||
      !library.editable ||
      !library.filesEditable ||
      !source.isEditable()
    )
      throw new MineruAPIError(
        403,
        "permission_denied",
        "Item and file editing permission is required",
      );
    return itemIdentity(source);
  }
  private add(
    candidate: State,
    requested: Intent,
    source: ItemIdentity,
  ): TaskRecord {
    const record: TaskRecord = {
      taskID: crypto.randomUUID(),
      state: "queued",
      phase: "queued",
      disposition: "created",
      source,
      createdAt: now(),
      updatedAt: now(),
    };
    candidate.entries.push({
      record,
      intent: requested,
      requestKey: intentKey(requested),
    });
    candidate.pending.push(record.taskID);
    return clone(record);
  }
  private capacity(
    candidate: State,
    count: number,
    invalid?: InvalidItem[],
  ): void {
    const remainingCapacity = Math.max(
      0,
      currentQueueLimit() - candidate.pending.length,
    );
    if (count > remainingCapacity)
      throw new MineruAPIError(
        409,
        "queue_full",
        "All new valid items must fit the remaining pending capacity",
        {
          remainingCapacity,
          requiredCapacity: count,
          ...(invalid ? { invalid } : {}),
        },
      );
  }
  async submit(
    value: unknown,
    report?: (view: TaskView) => void,
  ): Promise<TaskRecord> {
    this.requireReady();
    const requested = intent(value);
    const record = await this.mutate(async (candidate) => {
      const replay = this.repeated(candidate, requested);
      if (replay) return replay;
      const source = await this.resolveRequested(requested, false);
      this.capacity(candidate, 1);
      return this.add(candidate, requested, source);
    });
    if (report && !terminal(record.state))
      this.reports.set(record.taskID, report);
    this.kick();
    return record;
  }
  async submitBatch(value: unknown): Promise<BatchRecord> {
    this.requireReady();
    const raw = object(value);
    if (
      Object.keys(raw).some((key) => !["requestID", "items"].includes(key)) ||
      !Array.isArray(raw.items) ||
      !raw.items.length ||
      raw.items.length > 1000
    )
      throw new MineruAPIError(
        400,
        "invalid_request",
        "Provide requestID and 1–1000 task requests in items",
      );
    const id = requestID(raw.requestID);
    // Hash raw entries for bounded manifest replay without retaining invalid payloads.
    const key = digest(
      canonical(
        raw.items.map((value) => {
          try {
            return intent(value);
          } catch {
            return value;
          }
        }),
      ),
    );
    const batchID = await this.mutate(async (candidate) => {
      const replay = candidate.batches.find((batch) => batch.requestID === id);
      if (replay) {
        if (replay.requestKey !== key)
          throw new MineruAPIError(
            409,
            "request_id_conflict",
            "Batch requestID was used with different inputs",
          );
        return replay.batchID;
      }
      const valid: {
        requested: Intent;
        source?: ItemIdentity;
        replay?: TaskRecord;
      }[] = [];
      const invalid: InvalidItem[] = [];
      const planned = new Map<string, string>();
      for (const [index, value] of (raw.items as unknown[]).entries()) {
        try {
          const requested = intent(value);
          const existingKey = planned.get(requested.requestID);
          if (existingKey && existingKey !== intentKey(requested))
            throw new MineruAPIError(
              409,
              "request_id_conflict",
              "Batch repeats requestID with different inputs",
            );
          const replay = this.repeated(candidate, requested);
          const source = replay
            ? undefined
            : await this.resolveRequested(requested, true);
          valid.push({ requested, source, replay });
          planned.set(requested.requestID, intentKey(requested));
        } catch (error) {
          if (!(error instanceof MineruAPIError)) throw error;
          invalid.push({
            index,
            error: {
              code: error.code,
              message: error.message,
              ...error.details,
            },
          });
        }
      }
      const fresh = new Set(
        valid
          .filter((item) => !item.replay)
          .map((item) => item.requested.requestID),
      );
      this.capacity(candidate, fresh.size, invalid);
      const newBatchID = crypto.randomUUID();
      const taskIDs: string[] = [];
      for (const item of valid) {
        const record =
          this.repeated(candidate, item.requested) ||
          this.add(candidate, item.requested, item.source!);
        const member = this.entry(candidate, record.taskID);
        if (!item.replay && !member.batchID) member.batchID = newBatchID;
        taskIDs.push(record.taskID);
      }
      const batch: Batch = {
        batchID: newBatchID,
        requestID: id,
        requestKey: key,
        taskIDs,
        invalid,
        createdAt: now(),
      };
      candidate.batches.push(batch);
      return batch.batchID;
    });
    this.kick();
    return this.getBatch(batchID);
  }
  async pause(): Promise<QueueRecord> {
    this.requireReady();
    await this.mutate((candidate) => {
      candidate.paused = true;
    });
    return this.getQueue();
  }
  async resume(): Promise<QueueRecord> {
    this.requireReady();
    await this.mutate((candidate) => {
      candidate.paused = false;
    });
    const queue = this.getQueue();
    this.kick();
    return queue;
  }
  async move(
    taskID: string,
    position: { before?: string; after?: string },
  ): Promise<QueueRecord> {
    this.requireReady();
    if (
      !position ||
      Object.keys(position).some((key) => !["before", "after"].includes(key)) ||
      (typeof position.before === "string") ===
        (typeof position.after === "string")
    )
      throw new MineruAPIError(
        400,
        "invalid_request",
        "Provide exactly one before or after target taskID",
      );
    await this.mutate((candidate) => {
      const target = position.before ?? position.after!;
      if (
        !candidate.pending.includes(taskID) ||
        !candidate.pending.includes(target)
      )
        throw new MineruAPIError(
          409,
          "task_not_queued",
          "Both moved task and target must still be queued",
        );
      if (taskID === target) return;
      candidate.pending = candidate.pending.filter((id) => id !== taskID);
      candidate.pending.splice(
        candidate.pending.indexOf(target) + (position.after ? 1 : 0),
        0,
        taskID,
      );
    });
    return this.getQueue();
  }
  private cancelEntry(candidate: State, taskID: string): boolean {
    const entry = this.entry(candidate, taskID);
    if (entry.record.state === "queued") {
      candidate.pending = candidate.pending.filter((id) => id !== taskID);
      entry.record.state = "cancelled";
      entry.record.phase = "cancelled";
      entry.record.updatedAt = entry.record.completedAt = now();
    } else if (entry.record.state === "running") {
      entry.record.state = "cancel_requested";
      entry.record.updatedAt = now();
      return true;
    }
    return false;
  }
  async cancel(taskID: string): Promise<TaskRecord> {
    this.requireReady();
    const signal = await this.mutate((candidate) =>
      this.cancelEntry(candidate, taskID),
    );
    if (signal && this.activeID === taskID) this.controller.cancel();
    return this.get(taskID);
  }
  async cancelBatch(batchID: string): Promise<BatchRecord> {
    this.requireReady();
    const signalID = await this.mutate((candidate) => {
      const batch = candidate.batches.find(
        (batch) => batch.batchID === batchID,
      );
      if (!batch)
        throw new MineruAPIError(
          404,
          "batch_not_found",
          "Batch manifest expired or unknown",
        );
      let signalID: string | undefined;
      for (const id of batch.taskIDs)
        if (candidate.entries.some((entry) => entry.record.taskID === id))
          if (this.cancelEntry(candidate, id)) signalID = id;
      return signalID;
    });
    if (signalID && this.activeID === signalID) this.controller.cancel();
    return this.getBatch(batchID);
  }
  private kick(): void {
    if (
      this.dispatching ||
      !this.alive ||
      !this.ready ||
      !this.storageReady ||
      !this.recoveryReady ||
      this.state.paused
    )
      return;
    this.dispatching = true;
    void this.dispatch()
      .catch(async (error) => {
        this.recoveryReady = false;
        Zotero.logError(error as Error);
        if (this.storageReady)
          await this.mutate((candidate) => {
            candidate.paused = true;
          }).catch((error) => Zotero.logError(error as Error));
      })
      .finally(() => {
        this.dispatching = false;
        if (this.state.pending.length) this.kick();
      });
  }
  private async dispatch(): Promise<void> {
    while (
      this.alive &&
      this.storageReady &&
      this.recoveryReady &&
      !this.state.paused &&
      this.state.pending.length
    ) {
      const id = await this.mutate((candidate) => {
        if (!this.alive || candidate.paused || !candidate.pending.length)
          return undefined;
        const id = candidate.pending.shift()!;
        const entry = this.entry(candidate, id);
        entry.record.state = "running";
        entry.record.phase = "preparing";
        entry.record.updatedAt = now();
        entry.attemptID = crypto.randomUUID();
        return id;
      });
      if (!id) break;
      this.activeID = id;
      try {
        await this.execute(id);
      } finally {
        this.activeID = undefined;
        this.reports.delete(id);
        this.views.delete(id);
      }
    }
  }
  private async acknowledge(
    completion: PublicationCompletion,
    reused = false,
  ): Promise<void> {
    await this.mutate((candidate) => {
      const entry = this.entry(candidate, completion.taskID);
      if (
        entry.attemptID !== completion.attemptID ||
        (entry.completion &&
          canonical(entry.completion) !==
            canonical({ ...completion, ...(reused ? { reused: true } : {}) }))
      )
        throw new Error(
          "Publication owner does not match durable task attempt",
        );
      entry.completion = { ...completion, ...(reused ? { reused: true } : {}) };
    });
  }
  private async execute(id: string): Promise<void> {
    const entry = clone(this.entry(this.state, id));
    let finalView: TaskView | undefined;
    let result: Zotero.Item | undefined;
    let failure:
      | { code: string; message: string; category?: string }
      | undefined;
    let pause = false;
    try {
      // Bind exactly once at dequeue, not admission. Snapshot actual prepared bytes below.
      const settings = currentTaskSettings(entry.intent.options);
      const source = await resolveSource({
        libraryID: entry.record.source.libraryID,
        itemKey: entry.record.source.itemKey,
      });
      if (source.key !== entry.record.source.itemKey)
        throw new MineruAPIError(
          400,
          "pdf_required",
          "The exact queued PDF is unavailable",
        );
      if (this.entry(this.state, id).record.state === "cancel_requested") {
        finalView = { phase: "cancelled", state: "cancelled" };
      } else
        result = await this.controller.run(
          [source],
          async () => source,
          settings,
          (view) => {
            finalView = view;
            this.views.set(id, view);
            try {
              this.reports.get(id)?.(view);
            } catch (error) {
              Zotero.logError(error as Error);
            }
          },
          {
            owner: { taskID: id, attemptID: entry.attemptID! },
            acknowledgeCompletion: (completion) => this.acknowledge(completion),
            acknowledgeReuse: (item) =>
              this.acknowledge(
                {
                  taskID: id,
                  attemptID: entry.attemptID!,
                  token: crypto.randomUUID(),
                  result: itemIdentity(item),
                },
                true,
              ),
            findReusable: entry.intent.force ? undefined : reusableResult,
            scratchDirectory: this.scratchPath(entry),
            diagnosticsDirectory: this.diagnosticsPath(id),
            onSnapshot: (snapshot) => this.saveSnapshot(id, snapshot),
          },
        );
      if (finalView?.state === "failed") {
        failure = {
          code: finalView.errorCode?.toLowerCase() || "task_failed",
          message: finalView.message || "MinerU task failed",
          category: finalView.failureCategory,
        };
        pause = ["environment", "recovery", "cleanup"].includes(
          finalView.failureCategory || "",
        );
        if (
          finalView.failureCategory === "recovery" ||
          finalView.failureCategory === "cleanup"
        )
          this.recoveryReady = false;
      }
    } catch (error) {
      const category =
        error instanceof MineruTaskError ? error.category : undefined;
      pause = category === "cleanup" || !this.storageReady;
      if (category === "cleanup") this.recoveryReady = false;
      failure = {
        code: error instanceof MineruAPIError ? error.code : "task_failed",
        message:
          error instanceof MineruAPIError
            ? error.message
            : "Task could not complete; inspect the plugin log",
        category,
      };
    }
    // Controller has returned only after child wait + both drains + sensitive cleanup.
    await this.mutate(async (candidate) => {
      const current = this.entry(candidate, id);
      if (current.completion) {
        result ??=
          (await Zotero.Items.getByLibraryAndKeyAsync(
            current.completion.result.libraryID,
            current.completion.result.itemKey,
          )) || undefined;
        if (!result) throw new Error("Confirmed result identity is missing");
        current.record.state = "succeeded";
        current.record.phase = "done";
        current.record.disposition = current.completion.reused
          ? "reused_result"
          : "created";
        current.record.result = await this.completedResult(current, result);
        // A committed output remains success even if later cleanup requires intervention.
        if (failure) current.record.error = failure;
      } else if (finalView?.state === "cancelled") {
        current.record.state = "cancelled";
        current.record.phase = "cancelled";
      } else {
        current.record.state = "failed";
        current.record.phase = "failed";
        current.record.error = failure || {
          code: "task_failed",
          message: "Task stopped before completion was confirmed",
        };
      }
      current.record.updatedAt = current.record.completedAt = now();
      if (pause) candidate.paused = true;
    });
  }
  private async completedResult(
    entry: Entry,
    result: Zotero.Item,
  ): Promise<ResultRecord> {
    const source = await Zotero.Items.getByLibraryAndKeyAsync(
      entry.record.source.libraryID,
      entry.record.source.itemKey,
    );
    const current = source
      ? await describeSource(source).catch(() => undefined)
      : undefined;
    entry.record.source = {
      libraryID: entry.record.source.libraryID,
      itemKey: entry.record.source.itemKey,
      path: null,
      sha256: current?.sha256 || null,
    };
    const record = await inspectResult(result, current?.sha256 || null).catch(
      () => ({
        ...itemIdentity(result),
        title: String(result.getField("title")),
        dateAdded: result.dateAdded,
        availability: "partial" as const,
        paths: { markdown: null, middle: null, provenance: null },
        issues: ["inspection_failed"],
      }),
    );
    if (
      current?.sha256 &&
      entry.record.execution &&
      current.sha256 !== entry.record.execution.inputSha256
    )
      record.issues.push("source_changed_during_task");
    return record;
  }

  private async saveSnapshot(
    id: string,
    snapshot: TaskSnapshot,
  ): Promise<void> {
    await this.mutate((candidate) => {
      const entry = this.entry(candidate, id);
      entry.record.execution = {
        inputSha256: snapshot.inputSha256,
        options: snapshot.requestedOptions,
        runtime: {
          releaseID: snapshot.runtime.descriptor.release_id,
          profile: snapshot.runtime.descriptor.profile,
        },
        configurationSha256: snapshot.configurationSha256,
        environmentSha256: snapshot.environmentSha256,
      };
      entry.record.source = {
        ...itemIdentity(snapshot.source),
        path: null,
        sha256: snapshot.inputSha256,
      };
      entry.record.updatedAt = now();
    });
  }
  shutdown(): void {
    this.alive = false;
    this.ready = false;
    this.controller.shutdown();
  }
}

export const mineruService = new MineruTaskService();
