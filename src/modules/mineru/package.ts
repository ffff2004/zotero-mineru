/** Validate the locked MinerU/DocVortex ZIP export before publication. */
import Ajv2020 from "ajv/dist/2020.js";
import middleSchema from "./middle-json.schema.json";
import pkg from "../../../package.json";
import type { RuntimeSnapshot } from "./runtime";

export type ParseOptions = {
  tier: "flash" | "basic" | "standard" | "advanced";
  ocr_mode: "auto" | "txt" | "ocr";
  image_analysis: boolean;
  page_range: string;
};

const ROOT_FILES = new Set([
  "markdown.md",
  "middle_json.json",
  "structured_content.json",
  "model_output.json",
  "provenance.json",
]);
const REQUIRED = ["markdown.md", "middle_json.json"];
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const validateSchema = new Ajv2020({ strict: false }).compile(middleSchema);

type ArchiveEntry = { name: string; directory: boolean; size: number };

function file(path: string): nsIFile {
  return Zotero.File.pathToFile(path);
}

function validPart(part: string): boolean {
  const validName = (
    Zotero.File as typeof Zotero.File & {
      getValidFileName(name: string): string;
    }
  ).getValidFileName(part);
  return (
    !!part &&
    part !== "." &&
    part !== ".." &&
    !part.startsWith(".") &&
    part === validName &&
    !Array.from(part).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) &&
    !/[\\:\0]/.test(part)
  );
}

function safeRelative(name: string): string {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((part) => !validPart(part))
  ) {
    throw new Error(`Unsafe package path: ${name}`);
  }
  return name;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/** Read central headers ourselves: nsIZipReader may hide duplicate names. */
async function archiveEntries(zipPath: string): Promise<ArchiveEntry[]> {
  const size = (await IOUtils.stat(zipPath)).size;
  if (!size || size > MAX_ZIP_BYTES) throw new Error("Invalid ZIP size");
  const tailOffset = Math.max(0, size - 65557);
  const tail = await IOUtils.read(zipPath, { offset: tailOffset });
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      readU32(tail, i) === 0x06054b50 &&
      i + 22 + readU16(tail, i + 20) === tail.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Invalid ZIP end record");
  const count = readU16(tail, end + 10);
  const centralSize = readU32(tail, end + 12);
  const centralOffset = readU32(tail, end + 16);
  if (
    count === 0 ||
    count === 0xffff ||
    count > MAX_ENTRIES ||
    centralSize > 16 * 1024 * 1024 ||
    centralOffset + centralSize > size
  )
    throw new Error("Unsupported or oversized ZIP directory");
  const bytes = await IOUtils.read(zipPath, {
    offset: centralOffset,
    maxBytes: centralSize,
  });
  const names = new Set<string>();
  const namesFolded = new Set<string>();
  const normalizedPrefixes = new Map<string, string>();
  const entries: ArchiveEntry[] = [];
  let cursor = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || readU32(bytes, cursor) !== 0x02014b50) {
      throw new Error("Invalid ZIP central entry");
    }
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const expanded = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const host = bytes[cursor + 5];
    const attributes = readU32(bytes, cursor + 38);
    const endEntry = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      endEntry > bytes.length ||
      !nameLength ||
      flags & 1 ||
      ![0, 8].includes(method)
    ) {
      throw new Error("Invalid or unsupported ZIP entry");
    }
    const raw = utf8.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    const directory = raw.endsWith("/");
    const name = safeRelative(directory ? raw.slice(0, -1) : raw);
    const mode = host === 3 ? attributes >>> 16 : 0;
    const kind = mode & 0o170000;
    if (kind && kind !== (directory ? 0o040000 : 0o100000)) {
      throw new Error(`ZIP special file: ${name}`);
    }
    if (expanded === 0xffffffff || expanded > MAX_ENTRY_BYTES) {
      throw new Error("Oversized ZIP entry");
    }
    total += expanded;
    if (total > MAX_ZIP_BYTES) throw new Error("Oversized ZIP contents");
    const folded = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(name) || namesFolded.has(folded)) {
      throw new Error(`Duplicate ZIP path: ${name}`);
    }
    names.add(name);
    namesFolded.add(folded);
    const parts = name.split("/");
    for (let j = 1; j <= parts.length; j++) {
      const prefix = parts.slice(0, j).join("/");
      const key = prefix.normalize("NFC").toLocaleLowerCase("en-US");
      const previous = normalizedPrefixes.get(key);
      if (previous && previous !== prefix) {
        throw new Error(`Normalized ZIP path collision: ${name}`);
      }
      normalizedPrefixes.set(key, prefix);
    }
    if (
      folded === "provenance.json" ||
      (name.includes("/") &&
        ROOT_FILES.has(name.split("/").at(-1)!.toLocaleLowerCase("en-US")))
    ) {
      throw new Error(`Reserved package path: ${name}`);
    }
    entries.push({ name, directory, size: expanded });
    cursor = endEntry;
  }
  if (cursor !== bytes.length) throw new Error("Invalid ZIP central directory");
  for (const entry of entries) {
    const parts = entry.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (
        entries.some(
          (other) =>
            !other.directory && other.name === parts.slice(0, i).join("/"),
        )
      ) {
        throw new Error(`ZIP path overlaps file: ${entry.name}`);
      }
    }
    if (
      entry.directory &&
      entries.some((other) => other.name === entry.name && !other.directory)
    ) {
      throw new Error(`ZIP file/directory collision: ${entry.name}`);
    }
  }
  return entries;
}

async function actualFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const path of await IOUtils.getChildren(directory)) {
      const child = file(path);
      const name = safeRelative(
        prefix ? `${prefix}/${child.leafName}` : child.leafName,
      );
      if (child.isSymlink()) throw new Error(`Package symlink: ${name}`);
      if (child.isDirectory()) await walk(path, name);
      else if (child.isFile()) found.push(name);
      else throw new Error(`Package special file: ${name}`);
    }
  }
  await walk(root, "");
  return found.sort();
}

function referencedPath(value: string, base = ""): string | null {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  if (/^(?:\/\/|#)/.test(trimmed)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1].toLowerCase();
  if (scheme) {
    if (["http", "https", "mailto", "ftp"].includes(scheme)) return null;
    throw new Error(`Unsafe asset reference: ${value}`);
  }
  const bare = trimmed.split(/[?#]/, 1)[0];
  if (!bare) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    throw new Error(`Invalid asset reference: ${value}`);
  }
  return safeRelative(base ? `${base}/${decoded}` : decoded);
}

function verifyReferences(value: unknown, files: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child) => verifyReferences(child, files));
    return;
  }
  const object = value as Record<string, unknown>;
  if (object.type === "hyperlink" && typeof object.url === "string") {
    const path = referencedPath(object.url);
    if (path && !files.has(path)) throw new Error(`Missing asset: ${path}`);
  }
  if (typeof object.image_url === "string") {
    let url: URL;
    try {
      url = new URL(object.image_url);
    } catch {
      throw new Error("Invalid external image URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error("Unsafe external image URL");
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      ["image_path", "image_source", "src"].includes(key)
    ) {
      const path = referencedPath(child);
      if (path && !files.has(path)) throw new Error(`Missing asset: ${path}`);
    } else verifyReferences(child, files);
  }
}

function validateMiddle(value: unknown): void {
  if (!validateSchema(value)) {
    throw new Error(
      `Invalid MiddleJson schema: ${validateSchema.errors?.[0]?.instancePath ?? ""}`,
    );
  }
  const middle = value as {
    metadata: { file_suffix: string };
    extensions?: Record<string, unknown>;
    pages: {
      page_idx: number;
      blocks: { index?: number; bbox?: unknown; [key: string]: unknown }[];
    }[];
  };
  const extension = middle.extensions?.mineru;
  if (
    extension !== undefined &&
    (!extension ||
      typeof extension !== "object" ||
      Array.isArray(extension) ||
      Object.keys(extension).sort().join(",") !== "parse_mode,tier" ||
      !["flash", "basic", "standard", "advanced"].includes(
        (extension as any).tier,
      ) ||
      !["txt", "ocr"].includes((extension as any).parse_mode))
  )
    throw new Error("Invalid MinerU extension");
  let previous = -1;
  for (const page of middle.pages) {
    if (page.page_idx <= previous)
      throw new Error("MiddleJson pages are not ordered");
    previous = page.page_idx;
    let index = -1;
    for (const block of page.blocks) {
      if (block.index === undefined || block.index <= index) {
        throw new Error("MiddleJson blocks are not ordered");
      }
      index = block.index;
      if (
        ["pdf", "ofd"].includes(middle.metadata.file_suffix) &&
        block.bbox == null
      ) {
        throw new Error("MiddleJson fixed-layout block lacks bbox");
      }
    }
  }
}

function provenance(
  runtime: RuntimeSnapshot,
  sha256: string,
  options: ParseOptions,
) {
  const result = {
    package_format_version: 1,
    plugin: { id: pkg.config.addonID, version: pkg.version },
    runtime: {
      release_id: runtime.descriptor.release_id,
      mineru_version: runtime.descriptor.packages.mineru.version,
      docvortex_version: runtime.descriptor.packages.docvortex.version,
    },
    source: { sha256 },
    requested_options: {
      tier: options.tier,
      ocr_mode: options.ocr_mode,
      image_analysis: options.image_analysis,
      page_range: options.page_range,
    },
  };
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid input SHA-256");
  return result;
}

/** Extract into an empty task-owned directory and return only after full validation. */
export async function extractValidatedPackage(
  zipPath: string,
  directory: string,
  runtime: RuntimeSnapshot,
  sha256: string,
  options: ParseOptions,
): Promise<string> {
  if (await IOUtils.exists(directory))
    throw new Error("Package directory already exists");
  const entries = await archiveEntries(zipPath);
  await IOUtils.makeDirectory(directory, { permissions: 0o700 });
  const reader = (Components.classes as any)[
    "@mozilla.org/libjar/zip-reader;1"
  ].createInstance(Components.interfaces.nsIZipReader) as nsIZipReader;
  try {
    reader.open(file(zipPath));
    reader.test(null as unknown as string);
    for (const entry of entries) {
      if (entry.directory) continue;
      const target = PathUtils.join(directory, ...entry.name.split("/"));
      await IOUtils.makeDirectory(PathUtils.parent(target)!, {
        createAncestors: true,
        ignoreExisting: true,
        permissions: 0o700,
      });
      reader.extract(entry.name, file(target));
      if (
        file(target).isSymlink() ||
        !file(target).isFile() ||
        (await IOUtils.stat(target)).size !== entry.size
      ) {
        throw new Error(`Extracted file differs from ZIP: ${entry.name}`);
      }
    }
  } finally {
    reader.close();
  }
  const expected = entries
    .filter((entry) => !entry.directory)
    .map((entry) => entry.name)
    .sort();
  const files = await actualFiles(directory);
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error("Extracted tree differs from ZIP");
  }
  for (const name of REQUIRED) {
    if (!files.includes(name))
      throw new Error(`Missing required file: ${name}`);
  }
  const markdown = utf8.decode(
    await IOUtils.read(PathUtils.join(directory, "markdown.md")),
  );
  const middle = JSON.parse(
    utf8.decode(
      await IOUtils.read(PathUtils.join(directory, "middle_json.json")),
    ),
  ) as unknown;
  validateMiddle(middle);
  const fileSet = new Set(files);
  verifyReferences(middle, fileSet);
  for (const match of markdown.matchAll(
    /!?\[[^\]]*\]\(([^)]+)\)|<(?:img|source|a)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gi,
  )) {
    const path = referencedPath(match[1] || match[2]);
    if (path && !fileSet.has(path)) throw new Error(`Missing asset: ${path}`);
  }
  for (const name of ["structured_content.json", "model_output.json"]) {
    if (fileSet.has(name)) {
      const value = JSON.parse(
        utf8.decode(await IOUtils.read(PathUtils.join(directory, name))),
      ) as unknown;
      verifyReferences(value, fileSet);
    }
  }
  const result = provenance(runtime, sha256, options);
  const path = PathUtils.join(directory, "provenance.json");
  await IOUtils.writeUTF8(path, JSON.stringify(result, null, 2) + "\n");
  const stored = JSON.parse(await IOUtils.readUTF8(path)) as unknown;
  if (JSON.stringify(stored) !== JSON.stringify(result))
    throw new Error("Invalid provenance");
  return directory;
}
