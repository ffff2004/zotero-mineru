import { assert } from "chai";
import { runMineruParse, MineruTaskError } from "../src/modules/mineru/parse";
import { extractValidatedPackage } from "../src/modules/mineru/package";
import { freezeRuntime } from "../src/modules/mineru/runtime";
import manifest from "../runtime/release.json";

function temp(): nsIFile {
  const root = Zotero.getTempDirectory();
  root.append("mineru-parse-test");
  root.createUnique(Components.interfaces.nsIFile.DIRECTORY_TYPE!, 0o700);
  return root;
}

async function runtime(root: nsIFile, script: string) {
  const bin = PathUtils.join(root.path, "bin");
  const site = PathUtils.join(root.path, "lib", "site-packages");
  await IOUtils.makeDirectory(bin);
  await IOUtils.makeDirectory(site, { createAncestors: true });
  const python = PathUtils.join(bin, "python");
  const cli = PathUtils.join(bin, "mineru-kit");
  await IOUtils.writeUTF8(python, "fixture");
  await IOUtils.writeUTF8(cli, script);
  Zotero.File.pathToFile(cli).permissions = 0o755;
  const packages: Record<string, { version: string; metadata_path: string }> =
    {};
  for (const name of ["mineru", "docvortex"] as const) {
    const version = manifest.packages[name].version;
    const metadata_path = PathUtils.join(site, `${name}.dist-info`, "METADATA");
    await IOUtils.makeDirectory(PathUtils.parent(metadata_path)!);
    await IOUtils.writeUTF8(
      metadata_path,
      `Name: ${name}\nVersion: ${version}\n\n`,
    );
    packages[name] = { version, metadata_path };
  }
  const descriptor = PathUtils.join(root.path, "runtime.json");
  await IOUtils.writeUTF8(
    descriptor,
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
  const config = PathUtils.join(root.path, "config.yaml");
  await IOUtils.writeUTF8(config, "{}\n");
  return freezeRuntime({
    descriptorPath: descriptor,
    customConfigPath: config,
  });
}

async function fixtureZIP(
  root: nsIFile,
  middle: object,
  markdown: string,
): Promise<string> {
  const contents = PathUtils.join(root.path, "contents");
  await IOUtils.makeDirectory(contents);
  await IOUtils.writeUTF8(PathUtils.join(contents, "markdown.md"), markdown);
  await IOUtils.writeUTF8(
    PathUtils.join(contents, "middle_json.json"),
    JSON.stringify(middle),
  );
  await IOUtils.makeDirectory(PathUtils.join(contents, "images"));
  await IOUtils.writeUTF8(
    PathUtils.join(contents, "images", "figure.png"),
    "image",
  );
  const zip = PathUtils.join(root.path, "fixture.zip");
  await Zotero.File.zipDirectory(contents, zip, null);
  return zip;
}

function middle() {
  return {
    schema: "docvortex.middle",
    schema_version: "2.0",
    metadata: {
      file_suffix: "pdf",
      producer: { name: "MinerU", version: manifest.packages.mineru.version },
    },
    extensions: { mineru: { tier: "standard", parse_mode: "txt" } },
    pages: [],
    is_full_document: true,
  };
}

describe("MinerU parse and package public interface", function () {
  this.timeout(120000);

  it("runs a fresh child, logs both streams and returns a validated package", async function () {
    const root = temp();
    try {
      const zip = await fixtureZIP(
        root,
        middle(),
        "# Result\n![figure](images/figure.png)\n[website](https://example.org)\n",
      );
      const pdf = PathUtils.join(root.path, "sample.pdf");
      await IOUtils.writeUTF8(pdf, "%PDF-1.4\n%%EOF\n");
      const script = `#!/bin/sh
printf '%s\\n' "$@" 
printf 'config=%s\\n' "$MINERU_CONFIG" >&2
cp '${zip}' "$4"
`;
      const frozen = await runtime(root, script);
      const result = await runMineruParse({
        pdfPath: pdf,
        runtime: frozen,
        options: {
          tier: "standard",
          ocr_mode: "auto",
          image_analysis: false,
          page_range: "all",
        },
      });
      assert.isTrue(
        await IOUtils.exists(
          PathUtils.join(result.packageDirectory, "images", "figure.png"),
        ),
      );
      assert.match(
        await IOUtils.readUTF8(result.stdoutLog),
        /--pages\nall\n--disable-image-analysis/,
      );
      assert.include(
        await IOUtils.readUTF8(result.stderrLog),
        `config=${frozen.configPath}`,
      );
      const provenance = JSON.parse(
        await IOUtils.readUTF8(
          PathUtils.join(result.packageDirectory, "provenance.json"),
        ),
      );
      assert.deepEqual(Object.keys(provenance), [
        "package_format_version",
        "plugin",
        "runtime",
        "source",
        "requested_options",
      ]);
      assert.deepEqual(Object.keys(provenance.source), ["sha256"]);
      assert.equal(
        provenance.source.sha256,
        await IOUtils.computeHexDigest(pdf, "sha256"),
      );
      assert.equal(
        provenance.runtime.docvortex_version,
        manifest.packages.docvortex.version,
      );
      assert.isFalse(
        await IOUtils.exists(
          PathUtils.join(result.packageDirectory, "input.pdf"),
        ),
      );
      const tail = await runMineruParse({
        pdfPath: pdf,
        runtime: frozen,
        options: {
          tier: "basic",
          ocr_mode: "txt",
          image_analysis: true,
          page_range: "r1",
        },
      });
      assert.notEqual(tail.taskDirectory, result.taskDirectory);
      const tailArgs = await IOUtils.readUTF8(tail.stdoutLog);
      assert.match(tailArgs, /--tier\nbasic\n--ocr-mode\ntxt\n--pages\nr1/);
      assert.notInclude(tailArgs, "--disable-image-analysis");
      await IOUtils.remove(tail.taskDirectory, { recursive: true });
      await IOUtils.remove(result.taskDirectory, { recursive: true });
    } finally {
      await IOUtils.remove(root.path, { recursive: true, ignoreAbsent: true });
    }
  });

  it("classifies CLI failure without treating output text or a partial ZIP as success", async function () {
    const root = temp();
    try {
      const zip = await fixtureZIP(root, middle(), "# Result\n");
      const pdf = PathUtils.join(root.path, "sample.pdf");
      await IOUtils.writeUTF8(pdf, "%PDF-1.4\n%%EOF\n");
      const frozen = await runtime(
        root,
        `#!/bin/sh
cp '${zip}' "$4"
printf 'success\n'
printf 'diagnostic\n' >&2
exit 3
`,
      );
      let failure: unknown;
      try {
        await runMineruParse({
          pdfPath: pdf,
          runtime: frozen,
          options: {
            tier: "standard",
            ocr_mode: "auto",
            image_analysis: true,
            page_range: "all",
          },
        });
      } catch (error) {
        failure = error;
      }
      assert.instanceOf(failure, MineruTaskError);
      assert.equal((failure as MineruTaskError).category, "process");
      assert.equal((failure as MineruTaskError).message, "MinerU 解析失败");
      assert.include(
        await IOUtils.readUTF8((failure as MineruTaskError).logs!.stdout),
        "success",
      );
      assert.include(
        await IOUtils.readUTF8((failure as MineruTaskError).logs!.stderr),
        "diagnostic",
      );
    } finally {
      await IOUtils.remove(root.path, { recursive: true, ignoreAbsent: true });
    }
  });

  it("rejects a successful CLI exit with no output ZIP", async function () {
    const root = temp();
    try {
      const pdf = PathUtils.join(root.path, "sample.pdf");
      await IOUtils.writeUTF8(pdf, "%PDF-1.4\n%%EOF\n");
      const frozen = await runtime(root, "#!/bin/sh\nprintf 'done\\n'\n");
      let failure: unknown;
      try {
        await runMineruParse({
          pdfPath: pdf,
          runtime: frozen,
          options: {
            tier: "standard",
            ocr_mode: "auto",
            image_analysis: true,
            page_range: "all",
          },
        });
      } catch (error) {
        failure = error;
      }
      assert.instanceOf(failure, MineruTaskError);
      assert.equal((failure as MineruTaskError).category, "validation");
      assert.match((failure as MineruTaskError).message, /ZIP is missing/);
    } finally {
      await IOUtils.remove(root.path, { recursive: true, ignoreAbsent: true });
    }
  });

  it("stops the child on abort and never returns a package", async function () {
    const root = temp();
    try {
      const pdf = PathUtils.join(root.path, "sample.pdf");
      await IOUtils.writeUTF8(pdf, "%PDF-1.4\n%%EOF\n");
      const frozen = await runtime(root, "#!/bin/sh\nexec sleep 10\n");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      let failure: unknown;
      try {
        await runMineruParse({
          pdfPath: pdf,
          runtime: frozen,
          signal: controller.signal,
          options: {
            tier: "standard",
            ocr_mode: "auto",
            image_analysis: true,
            page_range: "all",
          },
        });
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
      }
      assert.instanceOf(failure, MineruTaskError);
      assert.equal((failure as MineruTaskError).category, "process");
    } finally {
      await IOUtils.remove(root.path, { recursive: true, ignoreAbsent: true });
    }
  });

  it("rejects a ZIP with a missing local image", async function () {
    const root = temp();
    try {
      const zip = await fixtureZIP(
        root,
        middle(),
        "![figure](images/missing.png)\n",
      );
      const pdf = PathUtils.join(root.path, "sample.pdf");
      await IOUtils.writeUTF8(pdf, "%PDF-1.4\n%%EOF\n");
      const frozen = await runtime(root, `#!/bin/sh\ncp '${zip}' "$4"\n`);
      let failure: unknown;
      try {
        await runMineruParse({
          pdfPath: pdf,
          runtime: frozen,
          options: {
            tier: "standard",
            ocr_mode: "auto",
            image_analysis: true,
            page_range: "all",
          },
        });
      } catch (error) {
        failure = error;
      }
      assert.instanceOf(failure, MineruTaskError);
      assert.equal((failure as MineruTaskError).category, "validation");
    } finally {
      await IOUtils.remove(root.path, { recursive: true, ignoreAbsent: true });
    }
  });

  it("rejects unsafe ZIP entry names, duplicates, special files and reserved paths", async function () {
    const root = temp();
    try {
      const frozen = await runtime(root, "#!/bin/sh\nexit 0\n");
      const cases = {
        escape:
          "UEsDBBQAAAAAAHsRPl2DFtyMAQAAAAEAAAAHAAAALi4vZXZpbHhQSwECFAMUAAAAAAB7ET5dgxbcjAEAAAABAAAABwAAAAAAAAAAAAAAgAEAAAAALi4vZXZpbFBLBQYAAAAAAQABADUAAAAmAAAAAAA=",
        duplicate:
          "UEsDBBQAAAAAAHsRPl2379yDAQAAAAEAAAABAAAAeDFQSwMEFAAAAAAAexE+XQ2+1RoBAAAAAQAAAAEAAAB4MlBLAQIUAxQAAAAAAHsRPl2379yDAQAAAAEAAAABAAAAAAAAAAAAAACAAQAAAAB4UEsBAhQDFAAAAAAAexE+XQ2+1RoBAAAAAQAAAAEAAAAAAAAAAAAAAIABIAAAAHhQSwUGAAAAAAIAAgBeAAAAQAAAAAAA",
        collision:
          "UEsDBBQAAAAAAHsRPl2DFtyMAQAAAAEAAAAGAAAAeC8uLi94eFBLAQIUAxQAAAAAAHsRPl2DFtyMAQAAAAEAAAAGAAAAAAAAAAAAAACAAQAAAAB4Ly4uL3hQSwUGAAAAAAEAAQA0AAAAJQAAAAAA",
        reserved:
          "UEsDBBQAAAAAAHsRPl2DFtyMAQAAAAEAAAAPAAAAcHJvdmVuYW5jZS5qc29ueFBLAQIUAxQAAAAAAHsRPl2DFtyMAQAAAAEAAAAPAAAAAAAAAAAAAACAAQAAAABwcm92ZW5hbmNlLmpzb25QSwUGAAAAAAEAAQA9AAAALgAAAAAA",
        nested_fixed:
          "UEsDBBQAAAAAAHsRPl2DFtyMAQAAAAEAAAASAAAAaW1hZ2VzL21hcmtkb3duLm1keFBLAQIUAxQAAAAAAHsRPl2DFtyMAQAAAAEAAAASAAAAAAAAAAAAAACAAQAAAABpbWFnZXMvbWFya2Rvd24ubWRQSwUGAAAAAAEAAQBAAAAAMQAAAAAA",
        symlink:
          "UEsDBBQAAAAAAAAAIQCDFtyMAQAAAAEAAAAMAAAAaW1hZ2VzL2Fzc2V0eFBLAQIUAxQAAAAAAAAAIQCDFtyMAQAAAAEAAAAMAAAAAAAAAAAAAAD/oQAAAABpbWFnZXMvYXNzZXRQSwUGAAAAAAEAAQA6AAAAKwAAAAAA",
        fifo: "UEsDBBQAAAAAAAAAIQCDFtyMAQAAAAEAAAAMAAAAaW1hZ2VzL2Fzc2V0eFBLAQIUAxQAAAAAAAAAIQCDFtyMAQAAAAEAAAAMAAAAAAAAAAAAAACkEQAAAABpbWFnZXMvYXNzZXRQSwUGAAAAAAEAAQA6AAAAKwAAAAAA",
      };
      for (const [name, encoded] of Object.entries(cases)) {
        const zip = PathUtils.join(root.path, `${name}.zip`);
        await IOUtils.write(
          zip,
          Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
        );
        let error = "";
        try {
          await extractValidatedPackage(
            zip,
            PathUtils.join(root.path, `extract-${name}`),
            frozen,
            "a".repeat(64),
            {
              tier: "standard",
              ocr_mode: "auto",
              image_analysis: true,
              page_range: "all",
            },
          );
        } catch (caught) {
          error = String(caught);
        }
        assert.isNotEmpty(error, name);
      }
    } finally {
      await IOUtils.remove(root.path, { recursive: true, ignoreAbsent: true });
    }
  });

  it("rejects MiddleJson with an invalid schema version", async function () {
    const root = temp();
    try {
      const zip = await fixtureZIP(
        root,
        { ...middle(), schema_version: "1.0" },
        "# Result\n",
      );
      const frozen = await runtime(root, "#!/bin/sh\nexit 0\n");
      let error = "";
      try {
        await extractValidatedPackage(
          zip,
          PathUtils.join(root.path, "extract"),
          frozen,
          "a".repeat(64),
          {
            tier: "standard",
            ocr_mode: "auto",
            image_analysis: true,
            page_range: "all",
          },
        );
      } catch (caught) {
        error = String(caught);
      }
      assert.match(error, /Invalid MiddleJson schema/);
    } finally {
      await IOUtils.remove(root.path, { recursive: true, ignoreAbsent: true });
    }
  });
});
