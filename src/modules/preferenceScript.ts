import { clearPref, getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import {
  defaultRuntimeDescriptorPath,
  readCompatibleRuntime,
  resolveCurrentMineruConfigPath,
} from "./mineru/runtime";

function openFile(win: Window, path: string): void {
  let available = false;
  try {
    available = Zotero.File.pathToFile(path).isFile();
  } catch {
    // The configured path may no longer be valid.
  }
  if (!available) {
    win.alert(getString("config-unavailable"));
    return;
  }
  Zotero.launchFile(path);
}

export async function registerPrefsScripts(win: Window): Promise<void> {
  const doc = win.document;
  const input = (id: string) =>
    doc.getElementById(`mineru-${id}`) as HTMLInputElement;
  const runtime = input("runtime");
  const config = input("config");
  const effective = doc.getElementById("mineru-config-effective")!;
  const status = doc.getElementById("mineru-runtime-status")!;
  runtime.value = String(getPref("runtimeDescriptor") || "");
  config.value = String(getPref("configPath") || "");
  input("tier").value = String(getPref("tier") || "standard");
  input("ocr").value = String(getPref("ocrMode") || "auto");
  input("images").checked = getPref("imageAnalysis") !== false;
  input("pages").value = String(getPref("pageRange") || "all");
  const configPath = () => resolveCurrentMineruConfigPath(config.value.trim());
  let displayRequest = 0;
  const showEffective = async () => {
    const request = ++displayRequest;
    const path = await configPath();
    if (request === displayRequest)
      effective.textContent = `${getString("effective-config")}: ${path}`;
  };
  const checkRuntime = async () => {
    const path = runtime.value.trim() || defaultRuntimeDescriptorPath();
    try {
      const descriptor = await readCompatibleRuntime(path);
      status.textContent = `${getString("runtime-ready")}: ${descriptor.release_id} (${descriptor.profile})`;
    } catch {
      status.textContent = getString("runtime-unavailable");
    }
  };
  runtime.addEventListener("change", () => {
    setPref("runtimeDescriptor", runtime.value.trim());
    void checkRuntime();
  });
  config.addEventListener("change", () => {
    setPref("configPath", config.value.trim());
    void showEffective();
  });
  const button = (id: string, fn: () => void | Promise<void>) => {
    doc.getElementById(`mineru-${id}`)?.addEventListener("command", () => {
      void fn();
    });
  };
  button("runtime-choose", async () => {
    const path = await new ztoolkit.FilePicker(
      getString("pref-runtime"),
      "open",
      [["JSON", "*.json"]],
      undefined,
      win,
    ).open();
    if (path) {
      runtime.value = path;
      setPref("runtimeDescriptor", path);
      await checkRuntime();
    }
  });
  button("runtime-check", checkRuntime);
  button("config-choose", async () => {
    const path = await new ztoolkit.FilePicker(
      getString("pref-config"),
      "open",
      [["YAML", "*.yaml;*.yml"]],
      undefined,
      win,
    ).open();
    if (path) {
      config.value = path;
      setPref("configPath", path);
      await showEffective();
    }
  });
  button("config-open", async () => openFile(win, await configPath()));
  button("config-create", async () => {
    const path = await configPath();
    try {
      if (!(await IOUtils.exists(path))) {
        await IOUtils.makeDirectory(PathUtils.parent(path) || "/", {
          createAncestors: true,
        });
        await IOUtils.writeUTF8(path, "{}\n", { mode: "create" });
      }
      openFile(win, path);
    } catch {
      win.alert(getString("config-create-failed"));
    }
  });
  button("config-reset", () => {
    clearPref("configPath");
    config.value = "";
    void showEffective();
  });
  for (const [id, key] of [
    ["tier", "tier"],
    ["ocr", "ocrMode"],
    ["pages", "pageRange"],
  ] as const) {
    input(id).addEventListener("change", () =>
      setPref(
        key,
        input(id).value.trim() ||
          (id === "pages" ? "all" : id === "ocr" ? "auto" : "standard"),
      ),
    );
  }
  input("images").addEventListener("change", () =>
    setPref("imageAnalysis", input("images").checked),
  );
  await showEffective();
  await checkRuntime();
}
