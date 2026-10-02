/** Shared UI/API task ownership, idempotency and published-result reuse. */
import pkg from "../../../package.json";
import { MineruTaskController, type TaskSettings, type TaskView } from "./task";
import { currentTaskSettings } from "./settings";
import { readCompatibleRuntime, freezeParseEnvironment } from "./runtime";
import {
  findResults,
  inspectResult,
  resolveSource,
  reusableResult,
  describeSource,
  type ResultRecord,
  type SourceRecord,
} from "./results";
import {
  MineruAPIError,
  identity,
  itemIdentity,
  type ItemIdentity,
} from "./apiError";

export type TaskRecord = {
  taskID: string;
  state: "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled";
  phase: string;
  disposition: "created" | "reused_task" | "reused_result";
  source: ItemIdentity | SourceRecord;
  result?: ResultRecord;
  error?: { code: string; message: string; category?: string };
  createdAt: string;
  updatedAt: string;
};
type Entry = {
  record: TaskRecord;
  settings: TaskSettings;
  view?: TaskView;
  report?: (view: TaskView) => void;
};

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

export class MineruTaskService {
  private controller = new MineruTaskController();
  private entries = new Map<string, Entry>();
  private requests = new Map<string, { taskID: string; request: string }>();
  private activeID?: string;
  private ready = false;
  private recoveryReady = false;

  get busy(): boolean {
    return !!this.activeID || this.controller.busy;
  }

  setReady(recoveryReady: boolean): void {
    this.ready = true;
    this.recoveryReady = recoveryReady;
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
      protocolVersion: 1,
      plugin: {
        id: pkg.config.addonID,
        version: pkg.version,
        ready: this.ready,
      },
      userLibraryID: Zotero.Libraries.userLibraryID,
      recoveryReady: this.recoveryReady,
      runtime,
      busy: this.busy,
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

  get(taskID: string): TaskRecord {
    const entry = this.entries.get(taskID);
    if (!entry)
      throw new MineruAPIError(
        404,
        "task_not_found",
        "Task is unknown in this plugin session; look for a published result before resubmitting",
      );
    return JSON.parse(JSON.stringify(entry.record)) as TaskRecord;
  }

  cancel(taskID: string): TaskRecord {
    const entry = this.entries.get(taskID);
    if (!entry) return this.get(taskID);
    if (entry.record.state === "running" && this.activeID === taskID) {
      entry.record.state = "cancel_requested";
      entry.record.updatedAt = new Date().toISOString();
      this.controller.cancel();
    }
    return this.get(taskID);
  }

  async submit(
    value: unknown,
    report?: (view: TaskView) => void,
  ): Promise<TaskRecord> {
    if (!this.ready)
      throw new MineruAPIError(
        503,
        "plugin_not_ready",
        "Plugin startup is incomplete",
      );
    if (!this.recoveryReady)
      throw new MineruAPIError(
        503,
        "recovery_required",
        "Restart Zotero to finish attachment recovery",
      );
    const request = object(value);
    if (
      Object.keys(request).some(
        (key) => !["requestID", "source", "options", "force"].includes(key),
      ) ||
      typeof request.requestID !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.requestID) ||
      (request.force !== undefined && typeof request.force !== "boolean")
    )
      throw new MineruAPIError(
        400,
        "invalid_request",
        "Provide requestID, source, supported options and optional force",
      );
    const sourceID = identity(request.source);
    const requestKey = canonical({
      source: sourceID,
      options: request.options ?? {},
      force: request.force ?? false,
    });
    const repeated = () => {
      const registered = this.requests.get(request.requestID as string);
      if (!registered) return undefined;
      if (registered.request !== requestKey)
        throw new MineruAPIError(
          409,
          "request_id_conflict",
          "This requestID was used with different inputs",
        );
      const record = this.get(registered.taskID);
      return {
        ...record,
        disposition:
          record.disposition === "reused_result"
            ? ("reused_result" as const)
            : ("reused_task" as const),
      };
    };
    const existing = repeated();
    if (existing) return existing;
    const settings = currentTaskSettings(request.options ?? {});
    const source = await resolveSource(sourceID);
    if (source.key !== sourceID.itemKey)
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
    const raced = repeated();
    if (raced) return raced;
    if (this.activeID) {
      const active = this.entries.get(this.activeID)!;
      const snapshot = active.view?.snapshot;
      if (
        !request.force &&
        snapshot &&
        source.id === snapshot.source.id &&
        canonical(settings) === canonical(active.settings)
      ) {
        const current = await describeSource(source);
        const configHash = await IOUtils.computeHexDigest(
          snapshot.runtime.configPath,
          "sha256",
        ).catch(() => "");
        const environmentHash = await freezeParseEnvironment(
          snapshot.runtime.configPath,
        )
          .then((frozen) => frozen.sha256)
          .catch(() => "");
        // Recheck ownership after asynchronous file reads.
        if (
          this.activeID === active.record.taskID &&
          current.sha256 === snapshot.inputSha256 &&
          configHash === snapshot.configurationSha256 &&
          environmentHash === snapshot.environmentSha256
        ) {
          this.requests.set(request.requestID as string, {
            taskID: active.record.taskID,
            request: requestKey,
          });
          return {
            ...this.get(active.record.taskID),
            disposition: "reused_task",
          };
        }
      }
      throw new MineruAPIError(
        409,
        "task_busy",
        "A different MinerU task is running",
        { taskID: this.activeID },
      );
    }
    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskID: crypto.randomUUID(),
      state: "running",
      phase: "preparing",
      disposition: "created",
      source: itemIdentity(source),
      createdAt: now,
      updatedAt: now,
    };
    const entry: Entry = { record, settings, report };
    this.entries.set(record.taskID, entry);
    this.requests.set(request.requestID as string, {
      taskID: record.taskID,
      request: requestKey,
    });
    this.activeID = record.taskID;
    // The task resource is returned before any parsing; failures are queried via get().
    void this.execute(entry, source, request.force === true);
    this.prune();
    return this.get(record.taskID);
  }

  private async execute(
    entry: Entry,
    source: Zotero.Item,
    force: boolean,
  ): Promise<void> {
    try {
      const result = await this.controller.run(
        [source],
        async () => source,
        entry.settings,
        (view) => {
          entry.view = view;
          entry.record.phase = view.phase;
          entry.record.updatedAt = new Date().toISOString();
          if (view.state) entry.record.state = view.state;
          if (view.snapshot)
            entry.record.source = {
              ...itemIdentity(source),
              path: null,
              sha256: view.snapshot.inputSha256,
            };
          if (view.reused) entry.record.disposition = "reused_result";
          if (view.state === "failed") {
            entry.record.error = {
              code: view.errorCode?.toLowerCase() || "task_failed",
              message: view.message || "MinerU task failed",
              category: view.failureCategory,
            };
            if (view.failureCategory === "recovery") this.recoveryReady = false;
          }
          // A succeeded record is published only after its bundle is described below.
          if (view.state === "succeeded") entry.record.state = "running";
          try {
            entry.report?.(view);
          } catch (error) {
            Zotero.logError(error as Error);
          }
        },
        { findReusable: force ? undefined : reusableResult },
      );
      if (result) {
        // The controller confirmed publication. Subsequent inspection failures
        // describe usability; they cannot undo that committed outcome.
        entry.record.state = "succeeded";
        entry.record.phase = "done";
        const snapshot = entry.view?.snapshot;
        const current = await describeSource(source).catch(() => ({
          ...itemIdentity(source),
          path: null,
          sha256: null,
        }));
        entry.record.source = current;
        entry.record.result = await inspectResult(result, current.sha256).catch(
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
          snapshot &&
          current.sha256 &&
          current.sha256 !== snapshot.inputSha256
        )
          entry.record.result.issues.push("source_changed_during_task");
      } else if (!["failed", "cancelled"].includes(entry.record.state)) {
        entry.record.state = "failed";
        entry.record.error = {
          code: "task_interrupted",
          message: "Task stopped before a result was confirmed",
        };
      }
    } catch (error) {
      entry.record.state = "failed";
      entry.record.error = {
        code: error instanceof MineruAPIError ? error.code : "task_failed",
        message:
          error instanceof MineruAPIError
            ? error.message
            : "Task could not complete; inspect the plugin log",
      };
    } finally {
      entry.record.updatedAt = new Date().toISOString();
      if (this.activeID === entry.record.taskID) this.activeID = undefined;
      entry.report = undefined;
    }
  }

  private prune(): void {
    // Keep bounded terminal records; active tasks are never evicted.
    while (this.entries.size > 100) {
      const id = [...this.entries.keys()].find(
        (key) =>
          key !== this.activeID &&
          ["succeeded", "failed", "cancelled"].includes(
            this.entries.get(key)!.record.state,
          ),
      );
      if (!id) break;
      this.entries.delete(id);
      for (const [request, registration] of this.requests)
        if (registration.taskID === id) this.requests.delete(request);
    }
  }

  shutdown(): void {
    this.ready = false;
    this.controller.shutdown();
  }
}

export const mineruService = new MineruTaskService();
