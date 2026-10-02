import { assert } from "chai";
import { config, homepage } from "../package.json";
import { registerPrefsScripts } from "../src/modules/preferenceScript";
import { freezeRuntime } from "../src/modules/mineru/runtime";
import manifest from "../runtime/release.json";

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!check() && Date.now() < deadline) await Zotero.Promise.delay(20);
  assert.isTrue(check(), "Preferences operation completed");
}

describe("MinerU Preferences", function () {
  this.timeout(30000);
  const globals = globalThis as unknown as {
    addon?: unknown;
    ztoolkit?: unknown;
  };
  let previousAddon: unknown;
  let previousToolkit: unknown;
  let win: Window;
  let root: string;
  let descriptorPath: string;
  let namedUser: string;
  let namedHome: string;
  const saved = new Map<string, unknown>();
  const env = new Map<string, string>();

  before(async function () {
    previousAddon = globals.addon;
    previousToolkit = globals.ztoolkit;
    globals.addon = Zotero[config.addonInstance];
    globals.ztoolkit = (Zotero[config.addonInstance] as any).data.ztoolkit;
    for (const key of ["runtimeDescriptor", "configPath"]) {
      saved.set(key, Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true));
    }
    for (const key of ["MINERU_CONFIG", "MINERU_HOME"])
      env.set(key, Services.env.get(key));
    namedUser = Services.env.get("USER");
    const account = (await IOUtils.readUTF8("/etc/passwd"))
      .split("\n")
      .map((line) => line.split(":"))
      .find((fields) => fields[0] === namedUser && fields[5]?.startsWith("/"));
    assert.isDefined(account, "A named user exists on the Linux test host");
    namedHome = account![5];
    const dir = Zotero.getTempDirectory();
    dir.append(`mineru-preferences-test-${Date.now()}`);
    dir.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
    root = dir.path;
    const bin = PathUtils.join(root, "bin");
    await IOUtils.makeDirectory(bin);
    const python = PathUtils.join(bin, "python");
    const mineru_kit = PathUtils.join(bin, "mineru-kit");
    for (const path of [python, mineru_kit]) {
      await IOUtils.writeUTF8(path, "fixture");
      Zotero.File.pathToFile(path).permissions = 0o755;
    }
    const packages: Record<string, { version: string; metadata_path: string }> =
      {};
    for (const name of ["mineru", "docvortex"] as const) {
      const metadata_path = PathUtils.join(
        root,
        `${name}.dist-info`,
        "METADATA",
      );
      await IOUtils.makeDirectory(PathUtils.parent(metadata_path)!);
      const version = manifest.packages[name].version;
      await IOUtils.writeUTF8(
        metadata_path,
        `Name: ${name}\nVersion: ${version}\n\n`,
      );
      packages[name] = { version, metadata_path };
    }
    descriptorPath = PathUtils.join(root, "runtime.json");
    await IOUtils.writeUTF8(
      descriptorPath,
      JSON.stringify({
        schema_version: 1,
        release_id: manifest.release_id,
        profile: "cpu",
        python,
        mineru_kit,
        python_version: manifest.python_version,
        packages,
      }),
    );
    Zotero.Prefs.set(
      `${config.prefsPrefix}.runtimeDescriptor`,
      descriptorPath,
      true,
    );
  });

  beforeEach(async function () {
    win = Zotero.getMainWindow().openDialog(
      "about:blank",
      "",
      "chrome,dialog=no,width=760,height=440",
    )!;
    await waitFor(() => win.document.readyState === "complete");
    const doc = win.document;
    for (const id of ["runtime", "config", "tier", "ocr", "images", "pages"]) {
      const input = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "input",
      );
      input.id = `mineru-${id}`;
      doc.documentElement.append(input);
    }
    for (const id of [
      "config-effective",
      "runtime-status",
      "runtime-check",
      "config-open",
      "config-create",
      "config-reset",
    ]) {
      const element = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      );
      element.id = `mineru-${id}`;
      doc.documentElement.append(element);
    }
  });

  afterEach(function () {
    win?.close();
  });

  after(async function () {
    for (const [key, value] of saved) {
      if (value === undefined)
        Zotero.Prefs.clear(`${config.prefsPrefix}.${key}`, true);
      else
        Zotero.Prefs.set(`${config.prefsPrefix}.${key}`, value as string, true);
    }
    for (const [key, value] of env) Services.env.set(key, value);
    globals.addon = previousAddon;
    globals.ztoolkit = previousToolkit;
    await IOUtils.remove(root, { recursive: true });
  });

  it("uses the same named-user, home, relative and inherited paths as task freezing", async function () {
    const home = Services.dirsvc.get(
      "Home",
      Components.interfaces.nsIFile,
    ).path;
    const cwd = Services.dirsvc.get(
      "CurWorkD",
      Components.interfaces.nsIFile,
    ).path;
    const cases = [
      [
        `~${namedUser}/config.yaml`,
        "/ignored.yaml",
        "",
        `${namedHome}/config.yaml`,
      ],
      ["~/custom.yaml", "/ignored.yaml", "", `${home}/custom.yaml`],
      ["relative.yaml", "/ignored.yaml", "", `${cwd}/relative.yaml`],
      [
        "",
        `~${namedUser}/inherited.yaml`,
        "~/ignored",
        `${namedHome}/inherited.yaml`,
      ],
      ["", "relative-env.yaml", "", `${cwd}/relative-env.yaml`],
      [
        "",
        "",
        `~${namedUser}/mineru-data`,
        `${namedHome}/mineru-data/config.yaml`,
      ],
      ["", "", "relative-home", `${cwd}/relative-home/config.yaml`],
      ["", "", "", `${home}/.mineru/config.yaml`],
    ];
    for (const [custom, inherited, mineruHome, expected] of cases) {
      Zotero.Prefs.set(`${config.prefsPrefix}.configPath`, custom, true);
      Services.env.set("MINERU_CONFIG", inherited);
      Services.env.set("MINERU_HOME", mineruHome);
      await registerPrefsScripts(win);
      assert.include(
        win.document.getElementById("mineru-config-effective")!.textContent!,
        expected,
      );
      const snapshot = await freezeRuntime({
        descriptorPath,
        customConfigPath: custom,
      });
      assert.equal(snapshot.configPath, expected);
      assert.equal(snapshot.childEnvironment.MINERU_CONFIG, expected);
    }
  });

  it("distinguishes missing executables from installed-version mismatch and provides the release repair command", async function () {
    const original = await IOUtils.readUTF8(descriptorPath);
    const runtime = JSON.parse(original);
    runtime.profile = "nvidia";
    const metadata = runtime.packages.mineru.metadata_path;
    const originalMetadata = await IOUtils.readUTF8(metadata);
    try {
      await IOUtils.writeUTF8(descriptorPath, JSON.stringify(runtime));
      await IOUtils.remove(runtime.mineru_kit);
      await registerPrefsScripts(win);
      const status = win.document.getElementById("mineru-runtime-status")!;
      assert.include(status.textContent!, "executables are missing");
      assert.notInclude(status.textContent!, "version is incompatible");
      assert.include(status.textContent!, manifest.release_id);
      assert.include(
        status.textContent!,
        `uv run --no-project ${homepage.split("#")[0]}/releases/download/v${manifest.plugin.version}/install-runtime.py install --profile nvidia --data-home '${root}'`,
      );
      assert.include(status.textContent!, descriptorPath);
      await IOUtils.writeUTF8(runtime.mineru_kit, "fixture");
      Zotero.File.pathToFile(runtime.mineru_kit).permissions = 0o755;
      await IOUtils.writeUTF8(metadata, "Name: mineru\nVersion: 0.0.0\n\n");
      win.document
        .getElementById("mineru-runtime-check")!
        .dispatchEvent(new win.Event("command"));
      await waitFor(
        () =>
          !!status.textContent?.includes(
            "Installed mineru version is incompatible",
          ),
      );
      assert.notInclude(status.textContent!, "executables are missing");
      assert.include(status.textContent!, "--profile nvidia");
    } finally {
      await IOUtils.writeUTF8(descriptorPath, original);
      await IOUtils.writeUTF8(metadata, originalMetadata);
      await IOUtils.writeUTF8(runtime.mineru_kit, "fixture");
      Zotero.File.pathToFile(runtime.mineru_kit).permissions = 0o755;
    }
  });

  it("shows a safe JSON parser cause and an explicit CPU repair when no profile is known", async function () {
    const original = await IOUtils.readUTF8(descriptorPath);
    const malformed = '{"private": "descriptor-content-value",';
    let expected = "";
    try {
      JSON.parse(malformed);
    } catch (error) {
      expected = (error as Error).message;
    }
    try {
      await IOUtils.writeUTF8(descriptorPath, malformed);
      await registerPrefsScripts(win);
      const status = win.document.getElementById(
        "mineru-runtime-status",
      )!.textContent!;
      assert.include(status, expected);
      assert.notInclude(status, "descriptor-content-value");
      assert.include(status, "--profile cpu");
      assert.include(status, manifest.release_id);
    } finally {
      await IOUtils.writeUTF8(descriptorPath, original);
    }
  });

  it("creates and opens the displayed named-user path without overwriting it, and resets precedence", async function () {
    const toRoot = "../".repeat(namedHome.split("/").filter(Boolean).length);
    const custom = `~${namedUser}/${toRoot}${root.slice(1)}/named-config.yaml`;
    const expected = PathUtils.join(root, "named-config.yaml");
    const originalLaunch = Zotero.launchFile;
    const launched: string[] = [];
    try {
      Zotero.launchFile = (path: string) => {
        launched.push(path);
      };
      Zotero.Prefs.set(`${config.prefsPrefix}.configPath`, custom, true);
      Services.env.set("MINERU_CONFIG", PathUtils.join(root, "inherited.yaml"));
      await registerPrefsScripts(win);
      assert.include(
        win.document.getElementById("mineru-config-effective")!.textContent!,
        expected,
      );
      const command = (id: string) =>
        win.document
          .getElementById(`mineru-${id}`)!
          .dispatchEvent(new win.Event("command"));
      command("config-create");
      await waitFor(() => launched.length === 1);
      assert.equal(await IOUtils.readUTF8(expected), "{}\n");
      await IOUtils.writeUTF8(expected, "existing: retained\n");
      command("config-create");
      await waitFor(() => launched.length === 2);
      command("config-open");
      await waitFor(() => launched.length === 3);
      assert.deepEqual(launched, [expected, expected, expected]);
      assert.equal(await IOUtils.readUTF8(expected), "existing: retained\n");
      command("config-reset");
      await waitFor(
        () =>
          !!win.document
            .getElementById("mineru-config-effective")!
            .textContent?.includes("inherited.yaml"),
      );
      assert.equal(
        (win.document.getElementById("mineru-config") as HTMLInputElement)
          .value,
        "",
      );
      assert.equal(
        (await freezeRuntime({ descriptorPath })).configPath,
        PathUtils.join(root, "inherited.yaml"),
      );
    } finally {
      Zotero.launchFile = originalLaunch;
    }
  });
});
