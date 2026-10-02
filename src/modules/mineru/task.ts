import { freezeRuntime } from "./runtime";
import { runMineruParse, MineruTaskError, type PreparedParse } from "./parse";
import {
  PublicationRecoveryError,
  publishValidatedPackage,
} from "./publication";
import {
  safeDiagnostic,
  type PluginLogRecord,
  type PluginLogStage,
} from "./pluginLog";
import type { ParseOptions } from "./package";

export type TaskPhase =
  | "preparing"
  | "parsing"
  | "validation"
  | "saving"
  | "done"
  | "cancelled"
  | "failed";
export type TaskState =
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled";
export type TaskSnapshot = PreparedParse & { source: Zotero.Item };
export type TaskLifecycle = {
  findReusable?: (snapshot: TaskSnapshot) => Promise<Zotero.Item | undefined>;
};
export type TaskView = {
  phase: TaskPhase;
  state?: TaskState;
  errorCode?: string;
  snapshot?: TaskSnapshot;
  reused?: boolean;
  message?: string;
  /** One append-only event; records belong only to the receiving window. */
  record?: PluginLogRecord;
  failureCategory?: MineruTaskError["category"] | "persistence" | "recovery";
  logs?: { stdout: string; stderr: string };
  result?: Zotero.Item;
  configPath?: string;
};
export type TaskSettings = {
  descriptorPath?: string;
  customConfigPath?: string;
  options: ParseOptions;
};
export type ChoosePDF = (
  pdfs: Zotero.Item[],
) => Promise<Zotero.Item | undefined>;

/** Resolve one menu selection. The returned attachment is always the exact source PDF. */
export async function resolveSelectedPDF(
  items: Zotero.Item[],
  choose: ChoosePDF,
): Promise<Zotero.Item> {
  if (items.length !== 1)
    throw new MineruTaskError("input", "Select exactly one item");
  const selected = items[0];
  if (selected.deleted)
    throw new MineruTaskError("input", "Selected item is deleted");
  let pdf: Zotero.Item;
  if (selected.isAttachment()) {
    if (!selected.isPDFAttachment())
      throw new MineruTaskError(
        "input",
        "Select a PDF attachment or an item with PDFs",
      );
    pdf = selected;
  } else if (selected.isRegularItem()) {
    const candidates = (await Zotero.Items.getAsync(
      selected.getAttachments(false),
    )) as Zotero.Item[];
    const pdfs = candidates.filter(
      (item) => item && !item.deleted && item.isPDFAttachment(),
    );
    if (!pdfs.length)
      throw new MineruTaskError("input", "This item has no PDF attachment");
    const choice = pdfs.length === 1 ? pdfs[0] : await choose(pdfs);
    if (!choice)
      throw new MineruTaskError("input", "PDF selection was cancelled");
    if (!pdfs.some((item) => item.id === choice.id))
      throw new MineruTaskError("input", "Invalid PDF selection");
    pdf = choice;
  } else {
    throw new MineruTaskError("input", "This item type is not supported");
  }
  const library = Zotero.Libraries.get(pdf.libraryID);
  if (
    !library ||
    !library.editable ||
    !library.filesEditable ||
    !pdf.isEditable()
  )
    throw new MineruTaskError(
      "input",
      "Item and file editing permission is required",
    );
  return pdf;
}

/** A plugin instance admits one task from input preparation through publication. */
export class MineruTaskController {
  private active = false;
  private alive = true;
  private abort?: AbortController;
  private reportCancellation?: () => void;

  get busy(): boolean {
    return this.active;
  }

  shutdown(): void {
    this.alive = false;
    this.abort?.abort();
  }

  /** Cancellation leaves this controller available for the next task. */
  cancel(): boolean {
    if (!this.abort || this.abort.signal.aborted) return false;
    this.abort.abort();
    this.reportCancellation?.();
    return true;
  }

  async run(
    items: Zotero.Item[],
    choose: ChoosePDF,
    settings: TaskSettings,
    report: (view: TaskView) => void,
    lifecycle: TaskLifecycle = {},
  ): Promise<Zotero.Item | undefined> {
    if (!this.alive) throw new Error("MinerU plugin has stopped");
    if (this.active)
      throw new MineruTaskError("input", "A MinerU task is already running");
    this.active = true;
    const abort = new AbortController();
    this.abort = abort;
    let stage: Exclude<PluginLogStage, "recovery" | "task"> = "preparing";
    let phase: TaskPhase = "preparing";
    let state: TaskState = "running";
    let snapshot: TaskSnapshot | undefined;
    let logs: TaskView["logs"];
    let configPath: string | undefined;
    let publicationErrorReported = false;
    const emit = (record?: PluginLogRecord, extra?: Partial<TaskView>) => {
      if (this.alive)
        report({ phase, state, snapshot, logs, configPath, record, ...extra });
    };
    this.reportCancellation = () => {
      state = "cancel_requested";
      emit();
    };
    const checkCancelled = () => {
      if (abort.signal.aborted)
        throw new MineruTaskError("cancelled", "MinerU task stopped");
    };
    const log = (
      logStage: PluginLogStage,
      event: PluginLogRecord["event"],
      message: string,
      error?: unknown,
    ) => {
      emit({
        timestamp: new Date().toISOString(),
        stage: logStage,
        event,
        message,
        details: safeDiagnostic(error),
      });
    };
    // The first record precedes every asynchronous operation under the lock.
    log(stage, "start", "Checking runtime and preparing PDF");
    try {
      const frozenSettings = {
        descriptorPath: settings.descriptorPath,
        customConfigPath: settings.customConfigPath,
        options: { ...settings.options },
      };
      let runtime;
      try {
        runtime = await freezeRuntime({
          descriptorPath: frozenSettings.descriptorPath || undefined,
          customConfigPath: frozenSettings.customConfigPath,
        });
      } catch (error) {
        throw new MineruTaskError(
          "environment",
          "MinerU runtime is missing or incompatible; run the companion installer",
          undefined,
          error,
        );
      }
      configPath = runtime.configPath;
      checkCancelled();
      const source = await resolveSelectedPDF(items, choose);
      checkCancelled();
      let path = await source.getFilePathAsync();
      if (!path && source.isStoredFileAttachment()) {
        try {
          await (Zotero.Sync.Runner as any).downloadFile(source);
        } catch (error) {
          throw new MineruTaskError(
            "input",
            "Stored PDF download failed; retry Zotero file sync",
            undefined,
            error,
          );
        }
        checkCancelled();
        path = await source.getFilePathAsync();
      }
      if (!path) {
        throw new MineruTaskError(
          "input",
          source.isStoredFileAttachment()
            ? "Stored PDF download failed; retry Zotero file sync"
            : "Linked PDF file is missing; restore or relink the PDF",
        );
      }
      checkCancelled();
      let reused: Zotero.Item | undefined;
      const parsed = await runMineruParse({
        pdfPath: path,
        runtime,
        options: frozenSettings.options,
        signal: abort.signal,
        onPreparedSnapshot: async (prepared) => {
          snapshot = { ...prepared, source };
          reused = await lifecycle.findReusable?.(snapshot);
          return !!reused;
        },
        onPrepared: () =>
          log(
            "preparing",
            "complete",
            "PDF snapshot and CLI log files are ready",
          ),
        onParseStart: () => {
          stage = "parsing";
          phase = "parsing";
          log(stage, "start", "Starting MinerU parsing and export");
        },
        onValidation: () => {
          log(
            "parsing",
            "complete",
            "MinerU process exited with status 0; export still requires validation",
          );
          stage = "validation";
          phase = "validation";
          log(stage, "start", "Checking ZIP and result package");
        },
        onLogs: (files) => {
          logs = files;
          emit();
        },
      });
      if ("skipped" in parsed) {
        checkCancelled();
        phase = "done";
        state = "succeeded";
        logs = undefined;
        emit(
          {
            timestamp: new Date().toISOString(),
            stage: "task",
            event: "success",
            message: "Reused a complete attachment for this PDF snapshot",
          },
          { result: reused, reused: true },
        );
        return reused;
      }
      logs = { stdout: parsed.stdoutLog, stderr: parsed.stderrLog };
      checkCancelled();
      log("validation", "complete", "Result package validated");
      stage = "saving";
      phase = "saving";
      log(stage, "start", "Publishing the complete attachment");
      const result = await publishValidatedPackage({
        packageDirectory: parsed.packageDirectory,
        sourcePDF: source,
        signal: abort.signal,
        onRecovery: (event) => {
          if (!publicationErrorReported) {
            publicationErrorReported = true;
            log(
              "saving",
              "error",
              event.kind === "finalization"
                ? "Attachment journal finalization could not be confirmed"
                : "Could not confirm attachment publication",
              event.publicationError,
            );
          }
          log(
            "recovery",
            event.event,
            event.event === "start"
              ? "Checking rollback and cleanup of this new attachment"
              : event.event === "error"
                ? event.kind === "finalization"
                  ? "Attachment journal finalization is incomplete; a recovery journal was retained. Restart Zotero to retry recovery"
                  : "Recovery could not finish; a recovery journal was retained. Restart Zotero to retry recovery"
                : event.outcome === "committed"
                  ? "Confirmed complete attachment; recovery journal removed"
                  : "New attachment rolled back and temporary publication files cleaned; recovery journal removed",
            event.error,
          );
        },
      });
      // Publication has committed and completed recovery/finalization. A late
      // cancellation cannot turn an already saved attachment into cancellation.
      log("saving", "complete", "Complete attachment publication confirmed");
      phase = "done";
      state = "succeeded";
      emit(
        {
          timestamp: new Date().toISOString(),
          stage: "task",
          event: "success",
          message: "Task completed",
        },
        { result, reused: false },
      );
      return result;
    } catch (error) {
      if (error instanceof MineruTaskError && error.logs) logs = error.logs;
      const cancelled =
        (error instanceof MineruTaskError && error.category === "cancelled") ||
        (abort.signal.aborted &&
          error instanceof Error &&
          error.message === "MinerU task stopped" &&
          !(error instanceof PublicationRecoveryError));
      if (cancelled) {
        phase = "cancelled";
        state = "cancelled";
        emit(
          {
            timestamp: new Date().toISOString(),
            stage: "task",
            event: "complete",
            message: "Task cancelled; no new result was published",
          },
          { message: "MinerU task cancelled", errorCode: "CANCELLED" },
        );
      } else {
        const category =
          error instanceof PublicationRecoveryError
            ? "recovery"
            : stage === "saving"
              ? "persistence"
              : error instanceof MineruTaskError
                ? error.category
                : undefined;
        const message =
          error instanceof PublicationRecoveryError
            ? error.kind === "finalization"
              ? "Result completion could not be confirmed; a recovery journal was retained. Restart Zotero to retry recovery"
              : "Could not save result; rollback or cleanup failed and a recovery journal was retained. Restart Zotero to retry recovery"
            : stage === "saving"
              ? "Could not save result; check source and library permissions and diagnostic details"
              : error instanceof MineruTaskError
                ? error.message
                : "MinerU task failed; check diagnostic details";
        if (!publicationErrorReported) {
          log(
            stage,
            "error",
            error instanceof MineruTaskError && error.exitCode !== undefined
              ? `${message}. Observed MinerU process exit status: ${error.exitCode}. Inspect Open stdout / Open stderr`
              : message,
            error,
          );
        }
        if (error instanceof MineruTaskError) {
          for (const cleanupError of error.cleanupErrors || [])
            log(
              "recovery",
              "error",
              "Could not stop the MinerU child process; no result will be published",
              cleanupError,
            );
        }
        phase = "failed";
        state = "failed";
        emit(
          {
            timestamp: new Date().toISOString(),
            stage: "task",
            event: "failure",
            message: "Task failed",
          },
          {
            message,
            failureCategory: category,
            errorCode:
              category === "recovery"
                ? "RECOVERY_FAILED"
                : category === "persistence"
                  ? "PUBLICATION_FAILED"
                  : category === "input"
                    ? "INPUT_INVALID"
                    : category === "environment"
                      ? "RUNTIME_UNAVAILABLE"
                      : category === "process"
                        ? "PARSE_FAILED"
                        : category === "validation"
                          ? "VALIDATION_FAILED"
                          : "TASK_FAILED",
          },
        );
      }
      return undefined;
    } finally {
      this.active = false;
      this.abort = undefined;
      this.reportCancellation = undefined;
    }
  }
}
