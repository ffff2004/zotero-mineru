import { freezeRuntime } from "./runtime";
import { runMineruParse, MineruTaskError } from "./parse";
import { publishValidatedPackage } from "./publication";
import type { ParseOptions } from "./package";

export type TaskPhase =
  | "preparing"
  | "parsing"
  | "validation"
  | "saving"
  | "done"
  | "failed";
export type TaskView = {
  phase: TaskPhase;
  message?: string;
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

  get busy(): boolean {
    return this.active;
  }

  shutdown(): void {
    this.alive = false;
    this.abort?.abort();
  }

  async run(
    items: Zotero.Item[],
    choose: ChoosePDF,
    settings: TaskSettings,
    report: (view: TaskView) => void,
  ): Promise<Zotero.Item | undefined> {
    if (!this.alive) throw new Error("MinerU plugin has stopped");
    if (this.active)
      throw new MineruTaskError("input", "A MinerU task is already running");
    this.active = true;
    const abort = new AbortController();
    this.abort = abort;
    const emit = (view: TaskView) => {
      if (this.alive) report(view);
    };
    let logs: TaskView["logs"];
    let configPath: string | undefined;
    try {
      emit({ phase: "preparing" });
      const source = await resolveSelectedPDF(items, choose);
      let path = await source.getFilePathAsync();
      if (!path && source.isStoredFileAttachment()) {
        try {
          await (Zotero.Sync.Runner as any).downloadFile(source);
        } catch {
          throw new MineruTaskError("input", "Stored PDF download failed");
        }
        path = await source.getFilePathAsync();
      }
      if (!path) {
        throw new MineruTaskError(
          "input",
          source.isStoredFileAttachment()
            ? "Stored PDF download failed"
            : "Linked PDF file is missing",
        );
      }
      if (abort.signal.aborted) return;
      let runtime;
      try {
        runtime = await freezeRuntime({
          descriptorPath: settings.descriptorPath || undefined,
          customConfigPath: settings.customConfigPath,
        });
      } catch {
        throw new MineruTaskError(
          "environment",
          "MinerU runtime is missing or incompatible; run the companion installer",
        );
      }
      configPath = runtime.configPath;
      if (abort.signal.aborted) return;
      emit({ phase: "parsing", configPath });
      const parsed = await runMineruParse({
        pdfPath: path,
        runtime,
        options: { ...settings.options },
        signal: abort.signal,
        onValidation: () => emit({ phase: "validation", configPath }),
        onLogs: (files) => {
          logs = files;
          emit({ phase: "parsing", logs, configPath });
        },
      });
      logs = { stdout: parsed.stdoutLog, stderr: parsed.stderrLog };
      if (abort.signal.aborted) return;
      emit({ phase: "saving", logs, configPath });
      let result;
      try {
        result = await publishValidatedPackage({
          packageDirectory: parsed.packageDirectory,
          sourcePDF: source,
          signal: abort.signal,
        });
      } catch (error) {
        if (logs) {
          await IOUtils.write(
            logs.stderr,
            new TextEncoder().encode(
              `[plugin] Publication: ${String(error)}\n`,
            ),
            { mode: "append" },
          ).catch(() => undefined);
        }
        throw new MineruTaskError(
          "input",
          "Could not save result; check source and library permissions or recovery log",
          logs,
        );
      }
      if (abort.signal.aborted) return;
      emit({ phase: "done", logs, result, configPath });
      return result;
    } catch (error) {
      if (error instanceof MineruTaskError && error.logs) logs = error.logs;
      if (!abort.signal.aborted) {
        const message =
          error instanceof MineruTaskError
            ? error.message
            : "MinerU task failed; see stderr for details";
        emit({ phase: "failed", message, logs, configPath });
      }
      return undefined;
    } finally {
      this.active = false;
      this.abort = undefined;
    }
  }
}
