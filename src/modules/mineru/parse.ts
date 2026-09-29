/** Run one locked MinerU CLI task and return a validated, unpublished package. */
import { extractValidatedPackage, type ParseOptions } from "./package";
import type { RuntimeSnapshot } from "./runtime";

type Pipe = { read(): Promise<ArrayBuffer> };
type Child = {
  stdout: Pipe;
  stderr: Pipe;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<{ exitCode: number }>;
};
type SubprocessAPI = {
  call(options: {
    command: string;
    arguments: string[];
    environment: Record<string, string>;
    environmentAppend: boolean;
    stderr: "pipe";
  }): Promise<Child>;
};

export type ParseRequest = {
  /** Existing, readable local PDF, copied into a new task directory. */
  pdfPath: string;
  /** Result of freezeRuntime() captured once at task start. */
  runtime: RuntimeSnapshot;
  /** Task options captured once at task start. */
  options: ParseOptions;
  /** Shutdown signal; stopping the child prevents publication. */
  signal?: AbortSignal;
};

export type ValidatedParse = {
  packageDirectory: string;
  taskDirectory: string;
  stdoutLog: string;
  stderrLog: string;
  inputSha256: string;
  requestedOptions: ParseOptions;
};

export class MineruTaskError extends Error {
  constructor(
    public readonly category:
      | "input"
      | "environment"
      | "process"
      | "validation",
    message: string,
    public readonly logs?: { stdout: string; stderr: string },
  ) {
    super(message);
    this.name = "MineruTaskError";
  }
}

function taskDirectory(): string {
  const directory = Zotero.getTempDirectory();
  directory.append("zotero-mineru-task");
  directory.createUnique(Components.interfaces.nsIFile.DIRECTORY_TYPE!, 0o700);
  return directory.path;
}

function childArguments(
  pdf: string,
  zip: string,
  options: ParseOptions,
): string[] {
  return [
    "parse",
    pdf,
    "--output",
    zip,
    "--format",
    "zip",
    "--tier",
    options.tier,
    "--ocr-mode",
    options.ocr_mode,
    "--pages",
    options.page_range,
    ...(options.image_analysis ? [] : ["--disable-image-analysis"]),
  ];
}

async function drain(pipe: Pipe, path: string): Promise<void> {
  for (;;) {
    const buffer = await pipe.read();
    if (!buffer.byteLength) return;
    // Each read is bounded by the pipe's internal chunk size. No log is
    // retained in memory, and backpressure follows the disk write.
    await IOUtils.write(path, new Uint8Array(buffer), { mode: "append" });
  }
}

function taskError(
  category: MineruTaskError["category"],
  message: string,
  stdout: string,
  stderr: string,
): MineruTaskError {
  return new MineruTaskError(category, message, { stdout, stderr });
}

/** The caller owns publication and may retain the task directory for log actions. */
export async function runMineruParse(
  request: ParseRequest,
): Promise<ValidatedParse> {
  const options: ParseOptions = {
    tier: request.options.tier,
    ocr_mode: request.options.ocr_mode,
    image_analysis: request.options.image_analysis,
    page_range: request.options.page_range || "all",
  };
  if (
    !["flash", "basic", "standard", "advanced"].includes(options.tier) ||
    !["auto", "txt", "ocr"].includes(options.ocr_mode) ||
    typeof options.image_analysis !== "boolean" ||
    !options.page_range ||
    options.page_range.startsWith("-")
  ) {
    throw new MineruTaskError("input", "Invalid MinerU parse options");
  }
  const root = taskDirectory();
  const pdf = PathUtils.join(root, "input.pdf");
  const zip = PathUtils.join(root, "output.zip");
  const packageDirectory = PathUtils.join(root, "package");
  const stdout = PathUtils.join(root, "stdout.log");
  const stderr = PathUtils.join(root, "stderr.log");
  await IOUtils.write(stdout, new Uint8Array(), { mode: "create" });
  await IOUtils.write(stderr, new Uint8Array(), { mode: "create" });
  try {
    const source = Zotero.File.pathToFile(request.pdfPath);
    if (!source.exists() || !source.isFile() || source.isSymlink()) {
      throw taskError("input", "Source PDF is unavailable", stdout, stderr);
    }
    await IOUtils.copy(request.pdfPath, pdf, { noOverwrite: true });
    const sha256 = await IOUtils.computeHexDigest(pdf, "sha256");
    if (
      !(await IOUtils.exists(request.runtime.configPath)) ||
      !Zotero.File.pathToFile(request.runtime.configPath).isFile()
    ) {
      throw taskError(
        "environment",
        "MinerU configuration file is missing",
        stdout,
        stderr,
      );
    }
    if (await IOUtils.exists(zip)) {
      throw taskError(
        "validation",
        "Task output ZIP already exists",
        stdout,
        stderr,
      );
    }
    if (request.signal?.aborted) {
      throw taskError("process", "MinerU task stopped", stdout, stderr);
    }
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    ) as { Subprocess: SubprocessAPI };
    let child: Child;
    try {
      child = await Subprocess.call({
        command: request.runtime.descriptor.mineru_kit,
        arguments: childArguments(pdf, zip, options),
        environment: {
          MINERU_CONFIG: request.runtime.childEnvironment.MINERU_CONFIG,
        },
        environmentAppend: true,
        stderr: "pipe",
      });
    } catch {
      throw taskError("process", "Could not start MinerU", stdout, stderr);
    }
    let stopped = false;
    const stop = () => {
      stopped = true;
      void child.kill().catch(() => undefined);
    };
    request.signal?.addEventListener("abort", stop, { once: true });
    if (request.signal?.aborted) stop();
    try {
      const guardedDrain = (pipe: Pipe, path: string) =>
        drain(pipe, path).catch(async (error) => {
          await child.kill().catch(() => undefined);
          throw error;
        });
      const [outcome, stdoutResult, stderrResult] = await Promise.allSettled([
        child.wait(),
        guardedDrain(child.stdout, stdout),
        guardedDrain(child.stderr, stderr),
      ]);
      if (
        stdoutResult.status === "rejected" ||
        stderrResult.status === "rejected"
      ) {
        await child.kill().catch(() => undefined);
        throw taskError(
          "process",
          "Could not record MinerU output",
          stdout,
          stderr,
        );
      }
      if (
        outcome.status === "rejected" ||
        stopped ||
        outcome.value.exitCode < 0
      ) {
        throw taskError(
          "process",
          "MinerU process ended abnormally",
          stdout,
          stderr,
        );
      }
      if (outcome.value.exitCode !== 0) {
        throw taskError("process", "MinerU 解析失败", stdout, stderr);
      }
    } finally {
      request.signal?.removeEventListener("abort", stop);
    }
    if (!(await IOUtils.exists(zip)) || !Zotero.File.pathToFile(zip).isFile()) {
      throw taskError(
        "validation",
        "MinerU output ZIP is missing",
        stdout,
        stderr,
      );
    }
    try {
      await extractValidatedPackage(
        zip,
        packageDirectory,
        request.runtime,
        sha256,
        options,
      );
    } catch (error) {
      await IOUtils.write(
        stderr,
        new TextEncoder().encode(
          `[plugin] Package validation: ${String(error)}\n`,
        ),
        { mode: "append" },
      ).catch(() => undefined);
      throw taskError(
        "validation",
        "MinerU result package is invalid",
        stdout,
        stderr,
      );
    }
    if (request.signal?.aborted) {
      throw taskError("process", "MinerU task stopped", stdout, stderr);
    }
    return {
      packageDirectory,
      taskDirectory: root,
      stdoutLog: stdout,
      stderrLog: stderr,
      inputSha256: sha256,
      requestedOptions: options,
    };
  } catch (error) {
    if (error instanceof MineruTaskError) throw error;
    await IOUtils.write(
      stderr,
      new TextEncoder().encode(`[plugin] Task preparation: ${String(error)}\n`),
      { mode: "append" },
    ).catch(() => undefined);
    throw taskError("input", "Could not prepare MinerU task", stdout, stderr);
  }
}
