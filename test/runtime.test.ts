import { assert } from "chai";
import {
  defaultRuntimeDescriptorPath,
  freezeRuntime,
  readCompatibleRuntime,
  resolveMineruConfigPath,
} from "../src/modules/mineru/runtime";
import manifest from "../runtime/release.json";

function tempDirectory(): nsIFile {
  const directory = Zotero.getTempDirectory();
  directory.append(`mineru-runtime-test-${Date.now()}-${Math.random()}`);
  directory.create(Components.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
  return directory;
}

describe("MinerU companion runtime", function () {
  it("resolves custom, inherited, and release default config paths", function () {
    const base = { home: "/home/example", workingDirectory: "/work" };
    assert.equal(
      resolveMineruConfigPath({
        ...base,
        customPath: "~/custom.yaml",
        inheritedConfig: "/env/config.yaml",
      }),
      "/home/example/custom.yaml",
    );
    assert.equal(
      resolveMineruConfigPath({
        ...base,
        customPath: "",
        inheritedConfig: "relative.yaml",
      }),
      "/work/relative.yaml",
    );
    assert.equal(
      resolveMineruConfigPath({
        ...base,
        inheritedConfig: "",
        mineruHome: "~/mineru-data",
      }),
      "/home/example/mineru-data/config.yaml",
    );
    assert.equal(
      resolveMineruConfigPath({ ...base, mineruHome: "" }),
      "/home/example/.mineru/config.yaml",
    );
    assert.equal(
      resolveMineruConfigPath({
        ...base,
        customPath: "~alice/work/config.yaml",
        userHomes: { alice: "/users/alice" },
      }),
      "/users/alice/work/config.yaml",
    );
    assert.equal(
      defaultRuntimeDescriptorPath("", "/home/example"),
      "/home/example/.local/share/zotero-mineru/runtime.json",
    );
  });

  it("checks installed metadata separately from descriptor claims and freezes config", async function () {
    const root = tempDirectory();
    try {
      const bin = PathUtils.join(root.path, "bin");
      const site = PathUtils.join(
        root.path,
        "lib",
        "python3.13",
        "site-packages",
      );
      await IOUtils.makeDirectory(bin);
      await IOUtils.makeDirectory(site, { createAncestors: true });
      const python = PathUtils.join(bin, "python");
      const cli = PathUtils.join(bin, "mineru-kit");
      await IOUtils.writeUTF8(python, "python fixture");
      await IOUtils.writeUTF8(cli, "cli fixture");
      Zotero.File.pathToFile(python).permissions = 0o755;
      Zotero.File.pathToFile(cli).permissions = 0o755;
      const packages: Record<
        string,
        { version: string; metadata_path: string }
      > = {};
      for (const name of ["mineru", "docvortex"] as const) {
        const version = manifest.packages[name].version;
        const path = PathUtils.join(site, `${name}.dist-info`, "METADATA");
        await IOUtils.makeDirectory(PathUtils.join(site, `${name}.dist-info`));
        await IOUtils.writeUTF8(path, `Name: ${name}\nVersion: ${version}\n\n`);
        packages[name] = { version, metadata_path: path };
      }
      const path = PathUtils.join(root.path, "runtime.json");
      await IOUtils.writeUTF8(
        path,
        JSON.stringify({
          schema_version: 1,
          release_id: manifest.release_id,
          profile: "cpu",
          python,
          mineru_kit: cli,
          python_version: manifest.python_version,
          packages,
        }),
      );
      const initial = await freezeRuntime({
        descriptorPath: path,
        customConfigPath: "~/first.yaml",
        environment: { MINERU_CONFIG: "/env/second.yaml" },
      });
      assert.equal(initial.configPath, initial.childEnvironment.MINERU_CONFIG);
      assert.match(initial.configPath, /\/first\.yaml$/);
      const next = await freezeRuntime({
        descriptorPath: path,
        customConfigPath: "",
        environment: { MINERU_CONFIG: "/env/second.yaml" },
      });
      assert.equal(next.configPath, "/env/second.yaml");
      assert.match(initial.configPath, /\/first\.yaml$/);

      for (const executable of [python, cli]) {
        Zotero.File.pathToFile(executable).permissions = 0o644;
        let rejected = false;
        try {
          await readCompatibleRuntime(path);
        } catch (error) {
          rejected = true;
          assert.match(String(error), /not executable/);
        }
        assert.isTrue(rejected);
        Zotero.File.pathToFile(executable).permissions = 0o755;
        assert.equal((await readCompatibleRuntime(path)).mineru_kit, cli);
      }

      await IOUtils.writeUTF8(
        packages.mineru.metadata_path,
        "Name: mineru\nVersion: 0.0.0\n\n",
      );
      let mineruRejected = false;
      try {
        await readCompatibleRuntime(path);
      } catch (error) {
        mineruRejected = true;
        assert.match(String(error), /mineru version is incompatible/);
      }
      assert.isTrue(mineruRejected);
      await IOUtils.writeUTF8(
        packages.mineru.metadata_path,
        `Name: mineru\nVersion: ${manifest.packages.mineru.version}\n\n`,
      );

      await IOUtils.writeUTF8(
        packages.docvortex.metadata_path,
        "Name: docvortex\nVersion: 0.0.0\n\n",
      );
      let rejected = false;
      try {
        await readCompatibleRuntime(path);
      } catch (error) {
        rejected = true;
        assert.match(String(error), /docvortex version is incompatible/);
      }
      assert.isTrue(rejected);
    } finally {
      await IOUtils.remove(root.path, { recursive: true, ignoreAbsent: true });
    }
  });
});
