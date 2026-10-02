/** UI and local API use the same preference snapshot and option vocabulary. */
import { getPref } from "../../utils/prefs";
import type { ParseOptions } from "./package";
import type { TaskSettings } from "./task";
import { MineruAPIError } from "./apiError";

export function currentTaskSettings(overrides: unknown = {}): TaskSettings {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new MineruAPIError(
      400,
      "invalid_options",
      "Options must be an object",
    );
  const options = {
    tier: String(getPref("tier") || "standard"),
    ocr_mode: String(getPref("ocrMode") || "auto"),
    image_analysis: getPref("imageAnalysis") !== false,
    page_range: String(getPref("pageRange") || "all"),
    ...overrides,
  } as ParseOptions;
  if (
    Object.keys(overrides).some(
      (key) =>
        !["tier", "ocr_mode", "image_analysis", "page_range"].includes(key),
    ) ||
    !["flash", "basic", "standard", "advanced"].includes(options.tier) ||
    !["auto", "txt", "ocr"].includes(options.ocr_mode) ||
    typeof options.image_analysis !== "boolean" ||
    typeof options.page_range !== "string" ||
    !options.page_range.trim() ||
    options.page_range.startsWith("-")
  )
    throw new MineruAPIError(
      400,
      "invalid_options",
      "Unsupported MinerU options",
    );
  return {
    descriptorPath: String(getPref("runtimeDescriptor") || ""),
    customConfigPath: String(getPref("configPath") || ""),
    options,
  };
}
