/** Validate raw caller intent separately from dequeue-time preference binding. */
import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import type { ParseOptions } from "./package";
import type { TaskSettings } from "./task";
import { MineruAPIError } from "./apiError";

export function explicitTaskOptions(
  value: unknown = {},
): Partial<ParseOptions> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MineruAPIError(
      400,
      "invalid_options",
      "Options must be an object",
    );
  const options = value as Partial<ParseOptions>;
  if (
    Object.keys(options).some(
      (key) =>
        !["tier", "ocr_mode", "image_analysis", "page_range"].includes(key),
    ) ||
    (options.tier !== undefined &&
      !["flash", "basic", "standard", "advanced"].includes(options.tier)) ||
    (options.ocr_mode !== undefined &&
      !["auto", "txt", "ocr"].includes(options.ocr_mode)) ||
    (options.image_analysis !== undefined &&
      typeof options.image_analysis !== "boolean") ||
    (options.page_range !== undefined &&
      (typeof options.page_range !== "string" ||
        !options.page_range.trim() ||
        options.page_range.startsWith("-")))
  )
    throw new MineruAPIError(
      400,
      "invalid_options",
      "Unsupported MinerU options",
    );
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );
}

export function currentTaskSettings(overrides: unknown = {}): TaskSettings {
  const explicit = explicitTaskOptions(overrides);
  const options = {
    tier: String(getPref("tier") || "standard"),
    ocr_mode: String(getPref("ocrMode") || "auto"),
    image_analysis: getPref("imageAnalysis") !== false,
    page_range: String(getPref("pageRange") || "all"),
    ...explicit,
  } as ParseOptions;
  explicitTaskOptions(options);
  return {
    descriptorPath: String(getPref("runtimeDescriptor") || ""),
    customConfigPath: String(getPref("configPath") || ""),
    options,
  };
}

export function currentQueueLimit(): number {
  // The preference is the sole capacity authority, also for menu submissions.
  const value = Zotero.Prefs.get(`${config.prefsPrefix}.queueLimit`, true);
  if (value === undefined) return 10;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new MineruAPIError(
      503,
      "invalid_queue_limit",
      "Queue limit must be a positive integer",
    );
  return value;
}
