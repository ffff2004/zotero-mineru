/** Companion runtime descriptor, installed package checks, and task config path. */

import manifest from "../../../runtime/release.json";
import pkg from "../../../package.json";

type PackageRecord = { version: string; metadata_path: string };

export type RuntimeDescriptor = {
  schema_version: 1;
  release_id: string;
  profile: "cpu" | "nvidia";
  python: string;
  mineru_kit: string;
  python_version: string;
  packages: { mineru: PackageRecord; docvortex: PackageRecord };
};

export type RuntimeSnapshot = {
  descriptor: RuntimeDescriptor;
  configPath: string;
  /** Copy into the child process environment without changing Services.env. */
  childEnvironment: { MINERU_CONFIG: string };
};

/** Capture a complete child environment, fingerprinting config-relevant values only. */
export async function freezeParseEnvironment(configPath: string): Promise<{
  environment: Record<string, string>;
  sha256: string;
}> {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  ) as { Subprocess: { getEnvironment(): Record<string, string> } };
  const environment = { ...Subprocess.getEnvironment() };
  const keys = new Set([
    "HOME",
    ...Object.keys(environment).filter(
      (key) => key.startsWith("MINERU_") && key !== "MINERU_CONFIG",
    ),
  ]);
  const visited = new Set<string>();
  const discover = (value: string) => {
    for (const match of value.matchAll(/\$\{(\w+)(?=[:}])/g)) {
      const key = match[1];
      keys.add(key);
      if (!visited.has(key)) {
        visited.add(key);
        discover(environment[key] || "");
      }
    }
  };
  discover(await IOUtils.readUTF8(configPath));
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      [...keys].sort().map((key) => [key, environment[key] ?? null]),
    ),
  );
  const hash = (Components.classes as any)[
    "@mozilla.org/security/hash;1"
  ].createInstance(Components.interfaces.nsICryptoHash) as nsICryptoHash;
  hash.initWithString("sha256");
  hash.update(bytes, bytes.length);
  const sha256 = Array.from(hash.finish(false), (character) =>
    character.charCodeAt(0).toString(16).padStart(2, "0"),
  ).join("");
  return { environment, sha256 };
}

/** Carries only the supported installation profile, never descriptor payloads. */
export class RuntimeCompatibilityError extends Error {
  constructor(
    cause: unknown,
    public readonly profile: RuntimeDescriptor["profile"],
  ) {
    super(
      cause instanceof Error ? cause.message : "MinerU runtime check failed",
      {
        cause,
      },
    );
    this.name = "RuntimeCompatibilityError";
  }
}

/** Run the standalone installer from the matching plugin release. */
export function companionRepairCommand(
  descriptorPath: string,
  error: unknown,
): string {
  const profile =
    error instanceof RuntimeCompatibilityError ? error.profile : "cpu";
  const dataHome = parent(
    absolute(descriptorPath) ? descriptorPath : defaultRuntimeDescriptorPath(),
  );
  const quotedHome = `'${dataHome.replace(/'/g, "'\\''")}'`;
  const installer = `${pkg.homepage.split("#")[0]}/releases/download/v${manifest.plugin.version}/install-runtime.py`;
  return `uv run --no-project ${installer} install --profile ${profile} --data-home ${quotedHome}`;
}

export const companionReleaseID = manifest.release_id;

export type ConfigPathInputs = {
  customPath?: string | null;
  inheritedConfig?: string | null;
  mineruHome?: string | null;
  home: string;
  workingDirectory: string;
  userHomes?: Record<string, string>;
};

function absolute(path: string): boolean {
  return path.startsWith("/");
}

function normalize(path: string): string {
  if (!absolute(path)) throw new Error("Expected an absolute path");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function parent(path: string): string {
  const normalized = normalize(path);
  return normalized.slice(0, normalized.lastIndexOf("/")) || "/";
}

function expandUser(
  path: string,
  home: string,
  userHomes: Record<string, string>,
): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  if (path.startsWith("~")) {
    const match = /^~([^/]+)(?:\/(.*))?$/.exec(path);
    const selectedHome = match && userHomes[match[1]];
    if (!selectedHome) return path;
    return match[2] ? `${selectedHome}/${match[2]}` : selectedHome;
  }
  return path;
}

function canonical(
  path: string,
  home: string,
  cwd: string,
  userHomes: Record<string, string>,
): string {
  const expanded = expandUser(path, home, userHomes);
  return normalize(absolute(expanded) ? expanded : `${cwd}/${expanded}`);
}

/** The selected MinerU release uses MINERU_HOME/config.yaml or ~/.mineru/config.yaml. */
export function resolveMineruConfigPath(inputs: ConfigPathInputs): string {
  const userHomes = inputs.userHomes ?? Object.create(null);
  const selected =
    inputs.customPath ||
    inputs.inheritedConfig ||
    `${inputs.mineruHome ? expandUser(inputs.mineruHome, inputs.home, userHomes) : `${inputs.home}/.mineru`}/config.yaml`;
  return canonical(selected, inputs.home, inputs.workingDirectory, userHomes);
}

async function localUserHomes(home: string): Promise<Record<string, string>> {
  const homes: Record<string, string> = Object.create(null);
  const current = Services.env.get("USER");
  if (current) homes[current] = home;
  try {
    for (const line of (await IOUtils.readUTF8("/etc/passwd")).split("\n")) {
      const fields = line.split(":");
      if (fields.length >= 6 && fields[0] && fields[5].startsWith("/")) {
        homes[fields[0]] = fields[5];
      }
    }
  } catch {
    // The current user's home remains available without /etc/passwd.
  }
  return homes;
}

/** Resolve against the Zotero process context used by Preferences and tasks. */
export async function resolveCurrentMineruConfigPath(
  customPath?: string | null,
  environment: { MINERU_CONFIG?: string; MINERU_HOME?: string } = {
    MINERU_CONFIG: Services.env.get("MINERU_CONFIG"),
    MINERU_HOME: Services.env.get("MINERU_HOME"),
  },
): Promise<string> {
  const home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
  const workingDirectory = Services.dirsvc.get(
    "CurWorkD",
    Components.interfaces.nsIFile,
  ).path;
  return resolveMineruConfigPath({
    customPath,
    inheritedConfig: environment.MINERU_CONFIG,
    mineruHome: environment.MINERU_HOME,
    home,
    workingDirectory,
    userHomes: await localUserHomes(home),
  });
}

function isFile(path: string): boolean {
  try {
    return Zotero.File.pathToFile(path).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const file = Zotero.File.pathToFile(path);
    return file.isFile() && file.isExecutable();
  } catch {
    return false;
  }
}

function metadataVersion(text: string, name: string): string {
  const headers = text.split(/\r?\n\r?\n/, 1)[0];
  const actualName = /^Name:\s*(.+)$/im.exec(headers)?.[1]?.trim();
  const version = /^Version:\s*(.+)$/im.exec(headers)?.[1]?.trim();
  if (actualName?.toLowerCase() !== name || !version) {
    throw new Error(`Installed ${name} metadata is invalid`);
  }
  return version;
}

/** Default descriptor path under the XDG data directory. */
export function defaultRuntimeDescriptorPath(
  inheritedDataHome = Services.env.get("XDG_DATA_HOME"),
  home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path,
): string {
  return PathUtils.join(
    inheritedDataHome || PathUtils.join(home, ".local", "share"),
    "zotero-mineru",
    "runtime.json",
  );
}

/** Validate the selected descriptor against actual environment files. */
export async function readCompatibleRuntime(
  descriptorPath = defaultRuntimeDescriptorPath(),
): Promise<RuntimeDescriptor> {
  if (!isFile(descriptorPath)) {
    throw new Error(
      "MinerU runtime is not installed; run the companion installer",
    );
  }
  const value: unknown = JSON.parse(await IOUtils.readUTF8(descriptorPath));
  if (!value || typeof value !== "object") {
    throw new Error("MinerU runtime descriptor is invalid");
  }
  const runtime = value as RuntimeDescriptor;
  const profile = runtime.profile === "nvidia" ? "nvidia" : "cpu";
  try {
    return await checkInstalledRuntime(runtime);
  } catch (error) {
    throw new RuntimeCompatibilityError(error, profile);
  }
}

async function checkInstalledRuntime(
  runtime: RuntimeDescriptor,
): Promise<RuntimeDescriptor> {
  if (
    runtime.schema_version !== 1 ||
    runtime.release_id !== manifest.release_id ||
    !(runtime.profile in manifest.profiles) ||
    runtime.python_version !== manifest.python_version ||
    !runtime.packages
  ) {
    throw new Error(
      "MinerU runtime release is incompatible; run the companion installer",
    );
  }
  const bin = parent(runtime.mineru_kit);
  const root = parent(bin);
  if (
    !absolute(runtime.python) ||
    !absolute(runtime.mineru_kit) ||
    normalize(runtime.python) !== PathUtils.join(bin, "python") ||
    normalize(runtime.mineru_kit) !== PathUtils.join(bin, "mineru-kit") ||
    !isExecutableFile(runtime.python) ||
    !isExecutableFile(runtime.mineru_kit)
  ) {
    throw new Error(
      "MinerU runtime executables are missing, not executable, or inconsistent",
    );
  }
  for (const name of ["mineru", "docvortex"] as const) {
    const record = runtime.packages[name];
    const expected = manifest.packages[name].version;
    if (
      !record ||
      !absolute(record.metadata_path) ||
      !normalize(record.metadata_path).startsWith(`${root}/`) ||
      !isFile(record.metadata_path)
    ) {
      throw new Error(`Installed ${name} metadata is missing`);
    }
    const actual = metadataVersion(
      await IOUtils.readUTF8(record.metadata_path),
      name,
    );
    if (actual !== expected || actual !== record.version) {
      throw new Error(`Installed ${name} version is incompatible`);
    }
  }
  return runtime;
}

/** Freeze runtime and absolute config path once, at task start. */
export async function freezeRuntime(
  options: {
    descriptorPath?: string;
    customConfigPath?: string | null;
    environment?: { MINERU_CONFIG?: string; MINERU_HOME?: string };
  } = {},
): Promise<RuntimeSnapshot> {
  const descriptor = await readCompatibleRuntime(options.descriptorPath);
  const configPath = await resolveCurrentMineruConfigPath(
    options.customConfigPath,
    options.environment,
  );
  return {
    descriptor,
    configPath,
    childEnvironment: { MINERU_CONFIG: configPath },
  };
}
