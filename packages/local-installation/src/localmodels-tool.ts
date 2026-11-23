import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  lstat,
  readdir,
  readFile,
  rm,
  chmod,
  copyFile,
  mkdir,
  cp,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { x as extract } from "tar";
import { downloadInRegion, resolveRegion } from "./region.js";
import {
  atomicPrivate,
  privateDirectory,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import { runProcess, type ProcessOptions } from "./process.js";
import {
  validatePublishedServiceSource,
  type PublishedServiceSource,
} from "./published-source.js";
import type { InstallerEvent } from "./events.js";
import type { NativeRuntime } from "./managed-runtimes.js";
import { renameRetrying } from "./fs-retry.js";
export type LocalmodelsToolSource = PublishedServiceSource & {
  sourceCommit: string;
  manifestSha256: string;
};
interface ToolManifest {
  schemaVersion: number;
  platform: string;
  arch: string;
  sourceCommit: string;
  python: string;
  moduleDir: string;
  assets: Record<string, string>;
}
type Options = ProcessOptions & { onEvent?: (event: InstallerEvent) => void };
export function validateToolSource(value: unknown): LocalmodelsToolSource {
  const source = validatePublishedServiceSource(value);
  const extra = value as LocalmodelsToolSource;
  if (
    !/^[a-f0-9]{40}$/.test(extra.sourceCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(extra.manifestSha256 ?? "")
  )
    throw new Error(
      "Upstream tool distribution metadata requires a pinned commit and manifest checksum.",
    );
  return {
    ...source,
    sourceCommit: extra.sourceCommit,
    manifestSha256: extra.manifestSha256,
  };
}
function safeRelative(name: string): boolean {
  return (
    !!name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name
      .split("/")
      .some(
        (p) =>
          p === ".." ||
          p === "." ||
          !p ||
          [...p].some((c) => c.charCodeAt(0) < 32) ||
          /[. ]$/.test(p) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p),
      )
  );
}
async function digest(file: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
async function regular(root: string, relative: string) {
  if (!safeRelative(relative)) throw new Error("Unsafe upstream tool path.");
  let file = root;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    const s = await lstat(file);
    if (s.isSymbolicLink())
      throw new Error("Linked upstream tool paths are forbidden.");
  }
  if (!(await lstat(file)).isFile())
    throw new Error("Upstream tool payload must be a regular file.");
  return file;
}
// Size and modification time of each asset when it last matched its
// checksum. An asset whose stamp still matches is not hashed again: the kit
// has ~4.7k files, and hashing them all made every Windows check of this
// computer take over a minute.
type Stamps = Record<string, [size: number, mtimeMs: number]>;
const stampsFile = (directory: string) => `${directory}.verified.json`;
async function readStamps(
  directory: string,
  source: LocalmodelsToolSource,
): Promise<Stamps | undefined> {
  try {
    const value = JSON.parse(await readFile(stampsFile(directory), "utf8")) as {
      manifestSha256?: unknown;
      stamps?: Stamps;
    };
    return value.manifestSha256 === source.manifestSha256 &&
      value.stamps &&
      typeof value.stamps === "object"
      ? value.stamps
      : undefined;
  } catch {
    return undefined;
  }
}
async function writeStamps(
  directory: string,
  source: LocalmodelsToolSource,
  stamps: Stamps,
) {
  await atomicPrivate(
    stampsFile(directory),
    JSON.stringify({ manifestSha256: source.manifestSha256, stamps }),
  ).catch(() => undefined);
}
/** Marks a stop that could not verify the pinned localmodels kit. */
export const LOCALMODELS_KIT_VERIFICATION_FAILED =
  "LOCALMODELS_KIT_VERIFICATION_FAILED";
// Assets hashed at once.
const CONCURRENCY = 16;
async function verify(
  directory: string,
  source: LocalmodelsToolSource,
  known: Stamps = {},
) {
  const manifestFile = await regular(directory, "tool.json");
  const body = await readFile(manifestFile);
  if (createHash("sha256").update(body).digest("hex") !== source.manifestSha256)
    throw new Error("Upstream tool manifest checksum mismatch.");
  const m = JSON.parse(body.toString()) as ToolManifest;
  if (
    m.schemaVersion !== 1 ||
    m.platform !== process.platform ||
    m.arch !== process.arch ||
    m.sourceCommit !== source.sourceCommit ||
    !m.assets ||
    !m.assets[m.python] ||
    !safeRelative(m.moduleDir)
  )
    throw new Error(
      "Upstream tool distribution target or source does not match.",
    );
  const assets = Object.entries(m.assets);
  const writable: string[] = [];
  if (process.platform === "win32" && (await lstat(manifestFile)).mode & 0o200)
    writable.push(manifestFile);
  const stamps: Stamps = {};
  let hashed = 0;
  let next = 0;
  const worker = async () => {
    while (next < assets.length) {
      const [name, expected] = assets[next++]!;
      if (!/^[a-f0-9]{64}$/.test(expected))
        throw new Error("Upstream tool payload checksum mismatch.");
      const file = await regular(directory, name);
      const info = await lstat(file);
      if (process.platform === "win32" && info.mode & 0o200)
        writable.push(file);
      const stamp: [number, number] = [info.size, info.mtimeMs];
      const seen = known[name];
      if (!seen || seen[0] !== stamp[0] || seen[1] !== stamp[1]) {
        hashed += 1;
        if ((await digest(file)) !== expected)
          throw new Error("Upstream tool payload checksum mismatch.");
      }
      stamps[name] = stamp;
    }
  };
  // Recovery may move or remove this kit, so wait for all active reads even
  // when one worker has already found a mismatched asset.
  let failure: { reason: unknown } | undefined;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, assets.length) }, () =>
      worker().catch((error: unknown) => {
        next = assets.length;
        failure ??= { reason: error };
      }),
    ),
  );
  if (failure) throw failure.reason;
  return {
    python: await regular(directory, m.python),
    moduleDir: path.join(directory, m.moduleDir),
    sourceCommit: m.sourceCommit,
    stamps,
    hashed,
    writable,
  };
}
const location = (tool: Awaited<ReturnType<typeof verify>>) => ({
  python: tool.python,
  moduleDir: tool.moduleDir,
  sourceCommit: tool.sourceCommit,
});
async function unpack(archive: string, directory: string) {
  let size = 0;
  // tar calls the filter from a stream event, so an error thrown there would
  // escape as an uncaught exception and leave extract() pending forever.
  // Record the first refusal, skip every later member, and throw afterwards,
  // as native-dependencies.ts does.
  let refused: Error | undefined;
  const refuse = (message: string) => {
    refused ??= new Error(message);
    return false;
  };
  await extract({
    file: archive,
    cwd: directory,
    strict: true,
    preservePaths: false,
    filter: (name, entry) => {
      const type =
        "type" in entry
          ? entry.type
          : entry.isDirectory()
            ? "Directory"
            : entry.isFile()
              ? "File"
              : "Unsupported";
      if (refused) return false;
      const relative = name.replace(/^\.\//, "").replace(/\/$/, "");
      if (!relative) return type === "Directory";
      if (!safeRelative(relative) || !["File", "Directory"].includes(type))
        return refuse("Unsafe upstream tool archive.");
      size += entry.size;
      if (size > 1024 ** 3)
        return refuse(
          "Upstream tool archive exceeds its extracted size limit.",
        );
      return true;
    },
  });
  if (refused) throw refused;
}
/**
 * Verified kits are sealed read-only: upstream children that run the kit's
 * Python without -B would otherwise rewrite verified bytecode, and every later
 * verification would fail.
 */
async function setKitMode(directory: string, sealed: boolean) {
  if (process.platform === "win32") return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await setKitMode(file, sealed);
    else if (sealed && entry.isFile())
      await chmod(file, (await lstat(file)).mode & 0o500);
  }
  await chmod(directory, sealed ? 0o500 : 0o700);
}
/** Reopen the sealed directories before removing an owned installation. */
export async function unlockLocalmodelsKitsForRemoval(
  home: string,
): Promise<void> {
  const tools = path.join(home, "tools");
  const kits = path.join(tools, "localmodels");
  for (const directory of [home, tools, kits]) {
    try {
      if (!(await lstat(directory)).isDirectory()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  await setKitMode(kits, false);
}

/** The Windows read-only attribute prevents CPython from replacing a verified cache file. */
async function sealWindowsFiles(writable: string[]) {
  for (let offset = 0; offset < writable.length; offset += CONCURRENCY)
    await Promise.all(
      writable
        .slice(offset, offset + CONCURRENCY)
        .map((file) => chmod(file, 0o400)),
    );
}
async function installedKit(directory: string, source: LocalmodelsToolSource) {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && info.uid !== process.getuid?.())
  )
    throw new Error("Upstream tool kit must be an owned directory.");
  if (process.platform === "win32") await privateDirectory(directory);
  const tool = await verify(
    directory,
    source,
    await readStamps(directory, source),
  );
  if (process.platform !== "win32" && (info.mode & 0o777) !== 0o500)
    await setKitMode(directory, true);
  await sealWindowsFiles(tool.writable);
  if (tool.hashed > 0) await writeStamps(directory, source, tool.stamps);
  return location(tool);
}
/** Seed only the published tool files and the matching Bifrost archive. The
 * temporary installer still verifies what it uses in the private directories. */
export async function reuseTemporaryModelTools(
  regularHome: string,
  temporaryHome: string,
  toolsDirectory: string,
  options: {
    source?: LocalmodelsToolSource;
    archives?: string;
    runtime?: NativeRuntime;
  } = {},
): Promise<void> {
  const source = options.source ?? pinnedToolSource();
  if (!source) return;
  const from = kitDirectory(regularHome, source);
  const to = kitDirectory(temporaryHome, source);
  let created = false;
  let verified: Awaited<ReturnType<typeof verify>>;
  try {
    const info = await lstat(from);
    if (!info.isDirectory() || info.uid !== process.getuid?.()) return;
    verified = await verify(from, source);
    await privateDirectory(path.dirname(to));
    await mkdir(to, { mode: 0o700 });
    created = true;
    const files = ["tool.json", ...Object.keys(verified.stamps)];
    for (let offset = 0; offset < files.length; offset += CONCURRENCY) {
      const copied = await Promise.allSettled(
        files.slice(offset, offset + CONCURRENCY).map(async (name) => {
          const destination = path.join(to, name);
          await mkdir(path.dirname(destination), {
            recursive: true,
            mode: 0o700,
          });
          await copyFile(
            path.join(from, name),
            destination,
            constants.COPYFILE_FICLONE,
          );
        }),
      );
      if (copied.some((outcome) => outcome.status === "rejected"))
        throw new Error("Could not copy the published tool files.");
    }
  } catch {
    if (created) await rm(to, { recursive: true, force: true });
    return;
  }

  const lockFile = path.join(verified.moduleDir, "localmodels", "tools.json");
  if (!Object.hasOwn(verified.stamps, path.relative(from, lockFile))) return;
  try {
    const lock = JSON.parse(await readFile(lockFile, "utf8")) as {
      bifrost?: { builds?: BifrostArchive[] };
      pi?: { version?: string };
    };
    const pin = lock.bifrost?.builds?.find(
      (build) =>
        build.platform === process.platform && build.arch === process.arch,
    );
    // Either component may be downloaded normally if the local copy is unavailable.
    await Promise.allSettled([
      pin &&
        reuseBifrostArchive(
          pin,
          options.archives ??
            path.join(homedir(), ".local/share/localmodels/tools/.archives"),
          toolsDirectory,
        ),
      options.runtime === "pi" && lock.pi?.version
        ? reuseManagedPi(regularHome, temporaryHome, lock.pi.version)
        : undefined,
    ]);
  } catch {
    // A cold install can still fetch the pinned runtime and gateway.
  }
}

interface BifrostArchive {
  platform: string;
  arch: string;
  name: string;
  sha256: string;
}

async function reuseBifrostArchive(
  pin: BifrostArchive,
  archives: string,
  toolsDirectory: string,
): Promise<void> {
  if (!/^bifrost-http-[a-zA-Z0-9_.-]+$/.test(pin.name)) return;
  const previous = path.join(archives, pin.name);
  if (
    !(await lstat(previous)).isFile() ||
    (await digest(previous)) !== pin.sha256
  )
    return;
  const destination = path.join(toolsDirectory, ".archives");
  await privateDirectory(destination);
  await copyFile(
    previous,
    path.join(destination, pin.name),
    constants.COPYFILE_FICLONE,
  );
}

async function reuseManagedPi(
  regularHome: string,
  temporaryHome: string,
  version: string,
): Promise<void> {
  if (process.platform !== "darwin" || !/^\d+\.\d+\.\d+$/.test(version)) return;
  const relative = path.join("runtime", "harness", "tools", "pi", version);
  const from = path.join(regularHome, relative);
  const to = path.join(temporaryHome, relative);
  const marker = JSON.parse(
    await readFile(await regular(from, "localmodels-runtime.json"), "utf8"),
  ) as { schema?: string; planId?: string };
  if (
    marker.schema !== "localmodels.runtime-owned/v1" ||
    !/^[a-f0-9]{64}$/.test(marker.planId ?? "")
  )
    return;

  const files = ["localmodels-runtime.json", "node", "package", "pi"];
  await privateDirectory(path.dirname(to));
  try {
    // Copy only the program and its install receipt. The runtime installer
    // checks the version and its extension support before choosing reuse.
    await cp(from, to, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: async (entry) => {
        const parts = path.relative(from, entry).split(path.sep);
        if (parts[0] && !files.includes(parts[0])) return false;
        if ((await lstat(entry)).isSymbolicLink())
          throw new Error("Linked Pi install.");
        return true;
      },
    });
  } catch {
    await rm(to, { recursive: true, force: true });
  }
}

async function prepareLocalmodelsTool(
  home: string,
  options: Options = {},
  dependencies: { source?: LocalmodelsToolSource; fetcher?: typeof fetch } = {},
) {
  const pinned = dependencies.source ?? pinnedToolSource();
  if (!pinned)
    throw new Error(
      "Upstream tool distribution metadata is unavailable. Download the current Linger installer.",
    );
  const source = validateToolSource(pinned);
  const directory = kitDirectory(home, source);
  const base = path.dirname(directory);
  await privateDirectory(base);
  // Published kits are immutable and renamed into place only after validation.
  // Readers must not compete for the cross-process installation lock.
  try {
    const tool = await installedKit(directory, source);
    if (tool) return tool;
  } catch {
    // An altered kit is replaced below, under the publication lock.
  }
  const lock = path.join(base, "lock");
  await privateDirectory(lock);
  return withInstanceLock({ root: lock } as Instance, async () => {
    let damaged = false;
    try {
      const tool = await installedKit(directory, source);
      if (tool) return tool;
    } catch (error) {
      if (/owned directory/.test((error as Error).message)) throw error;
      damaged = true;
    }
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (damaged) {
      // Re-fetch the same pinned kit; the altered copy is moved aside first so
      // the published path only ever holds a verified kit.
      const invalid = path.join(base, `invalid-${randomUUID()}`);
      // macOS also requires the source directory to be writable when moving
      // a sealed directory. Ownership was checked above; reopen only its root
      // before quarantine, then reopen descendants at the quarantined path.
      if (process.platform !== "win32") await chmod(directory, 0o700);
      await renameRetrying(directory, invalid, { signal });
      await setKitMode(invalid, false);
      await rm(invalid, { recursive: true, force: true });
    }
    const stage = path.join(base, `pending-${randomUUID()}`);
    await privateDirectory(stage);
    const archive = path.join(base, `${randomUUID()}.tgz`);
    try {
      options.onEvent?.({
        kind: "stage",
        stage: "preflight",
        state: "running",
        message: damaged
          ? "Repairing the model and Harness installation tool…"
          : "Preparing the model and Harness installation tool…",
      });
      await downloadInRegion(
        home,
        {
          url: source.url,
          mirrors: source.mirrors,
          output: archive,
          algorithm: "sha256",
          digest: source.sha256,
          maxBytes: source.bytes,
          signal,
          onProgress: (completed, total) =>
            options.onEvent?.({
              kind: "stage",
              stage: "preflight",
              state: "running",
              message: "Downloading the model and Harness installation tool…",
              progress: { completed, total, unit: "bytes" },
            }),
        },
        dependencies.fetcher,
      );
      await unpack(archive, stage);
      // The kit is an npm tarball: its files sit under package/.
      const kit = path.join(stage, "package");
      const tool = await verify(kit, source);
      if (process.platform !== "win32") await chmod(tool.python, 0o700);
      // The kit manifest is private state; publisher bytes stay unchanged for digest checks.
      const manifest = path.join(kit, "tool.json");
      const body = await readFile(manifest, "utf8");
      // A read-only archive manifest cannot be replaced on Windows until
      // it is writable. Seal the replacement as well as the verified assets.
      if (process.platform === "win32" && !tool.writable.includes(manifest)) {
        await chmod(manifest, 0o600);
        tool.writable.push(manifest);
      }
      await atomicPrivate(manifest, body);
      await sealWindowsFiles(tool.writable);
      signal.throwIfAborted();
      await renameRetrying(kit, directory, { signal });
      // The rename keeps every stamp, so this checks the published kit
      // without hashing it a second time.
      const verified = await verify(directory, source, tool.stamps);
      await setKitMode(directory, true);
      await writeStamps(directory, source, verified.stamps);
      return location(verified);
    } finally {
      await rm(stage, { recursive: true, force: true });
      await rm(archive, { force: true });
    }
  });
}
type ToolLocation = Awaited<ReturnType<typeof prepareLocalmodelsTool>>;
const preparing = new Map<string, Promise<ToolLocation>>();
function configuredDevTool(): ToolLocation | undefined {
  const python = process.env.LINGER_LOCALMODELS_DEV_PYTHON?.trim();
  const moduleDir = process.env.LINGER_LOCALMODELS_DEV_MODULE_DIR?.trim();
  if (!python || !moduleDir) return undefined;
  if (!path.isAbsolute(python) || !path.isAbsolute(moduleDir))
    throw new Error(
      "LINGER_LOCALMODELS_DEV_PYTHON and LINGER_LOCALMODELS_DEV_MODULE_DIR must be absolute paths.",
    );
  return { python, moduleDir, sourceCommit: "0".repeat(40) };
}
export async function ensureLocalmodelsTool(
  home: string,
  options: Options = {},
  dependencies: { source?: LocalmodelsToolSource; fetcher?: typeof fetch } = {},
): Promise<ToolLocation> {
  options.signal?.throwIfAborted();
  const devTool = configuredDevTool();
  if (
    devTool &&
    (!dependencies.source ||
      dependencies.source.url.startsWith("https://dev.invalid/"))
  )
    return devTool;
  const key = `${path.resolve(home)}:${JSON.stringify(dependencies.source ?? pinnedToolSource())}`;
  const running = preparing.get(key);
  if (running) {
    const result = await running;
    options.signal?.throwIfAborted();
    return result;
  }
  const task = prepareLocalmodelsTool(home, options, dependencies);
  preparing.set(key, task);
  try {
    return await task;
  } finally {
    preparing.delete(key);
  }
}
/** LOCALMODELS_STATE of every call for this home. */
export function localmodelsStateDirectory(home: string): string {
  return path.join(path.resolve(home), "runtime", "localmodels", "state");
}
/** Where this home's models live: every call's --base-dir. */
export function localmodelsBaseDirectory(home: string): string {
  return path.join(path.resolve(home), "runtime", "localmodels", "models");
}
function formatDownloadedBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
export async function runLocalmodels(
  home: string,
  args: string[],
  options: Options = {},
  dependencies: { run?: typeof runProcess } = {},
) {
  return runLocalmodelsCommand(
    home,
    args,
    options,
    () => ensureLocalmodelsTool(home, options),
    dependencies.run,
  );
}
// Hosts come from the kit's mirror list; anything else is not shown.
function displayHost(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 253 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
    ? value
    : undefined;
}
function downloadStageMessage(
  value: Record<string, unknown>,
  label: string,
  harnessApply: boolean,
): string | undefined {
  if (value.state === "connecting") {
    const host = displayHost(value.host);
    return host ? `${label}: connecting to ${host}…` : `${label}: connecting…`;
  }
  if (value.state === "switching") {
    const host = displayHost(value.to);
    return host ? `${label}: switching to ${host}…` : `${label}: switching…`;
  }
  if (value.state === "retrying")
    return harnessApply
      ? "Retrying the Harness download…"
      : `${label}: retrying…`;
  return undefined;
}
async function runLocalmodelsCommand(
  home: string,
  args: string[],
  options: Options,
  loadTool: () => Promise<ToolLocation | undefined>,
  run: typeof runProcess = runProcess,
) {
  const startedAt = Date.now();
  const tool = await loadTool();
  if (!tool) throw new Error("The installed localmodels tool kit is missing.");
  const checkedAt = Date.now();
  const state = localmodelsStateDirectory(home);
  await privateDirectory(state);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    // localmodels downloads from the same region and does not probe again.
    SIMPLEX_REGION: await resolveRegion(home, { signal: options.signal }),
    PYTHONPATH: tool.moduleDir,
    LOCALMODELS_STATE: state,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  delete env.PYTHONHOME;
  delete env.PYTHONSTARTUP;
  delete env.PYTHONINSPECT;
  const harnessApply = args[0] === "harness" && args[1] === "apply";
  const label =
    args[0] === "gateway"
      ? "Downloading the application model gateway"
      : args[0] === "source" && args[1] === "apply"
        ? "Downloading the model gateway"
        : "Downloading the selected Harness";
  let pending = "";
  const onOutput = (chunk: string) => {
    options.onOutput?.(chunk);
    pending += chunk;
    if (pending.length > 65536) pending = pending.slice(-65536);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value?.kind === "stage" && value.stage === "download") {
        const message = downloadStageMessage(value, label, harnessApply);
        if (message)
          options.onEvent?.({
            kind: "stage",
            stage: "runtime",
            state: "running",
            message,
          });
        continue;
      }
      if (harnessApply && value?.kind === "stage") {
        const messages: Record<string, string> = {
          "extract:running":
            "Extracting Harness files and applying private permissions…",
          "verify:running": "Verifying the installed Harness executable…",
          "install:running": "Installing the selected Harness…",
          "install:succeeded":
            "Harness files installed; checking runtime status…",
          "reuse:succeeded":
            "Reusing the existing Harness; checking runtime status…",
        };
        const message =
          messages[`${String(value.stage)}:${String(value.state)}`];
        if (message)
          options.onEvent?.({
            kind: "stage",
            stage: "runtime",
            state: "running",
            message,
          });
        continue;
      }
      if (
        !value ||
        value.kind !== "progress" ||
        value.unit !== "bytes" ||
        typeof value.completed !== "number" ||
        !Number.isSafeInteger(value.completed) ||
        value.completed < 0
      )
        continue;
      const hasTotal = value.total !== null && value.total !== undefined;
      if (
        hasTotal &&
        (typeof value.total !== "number" ||
          !Number.isSafeInteger(value.total) ||
          value.total <= 0 ||
          value.completed > value.total)
      )
        continue;
      options.onEvent?.({
        kind: "stage",
        stage: "runtime",
        state: "running",
        message: hasTotal
          ? `${label}…`
          : `${label} (${formatDownloadedBytes(value.completed)})…`,
        progress: hasTotal
          ? {
              completed: value.completed,
              total: value.total as number,
              unit: "bytes",
            }
          : { completed: value.completed, unit: "bytes" },
      });
    }
  };
  const result = await run(
    tool.python,
    ["-P", "-s", "-m", "localmodels", ...args],
    { ...options, cwd: tool.moduleDir, env, onOutput },
  );
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  options.onEvent?.({
    kind: "log",
    message: `localmodels ${args.slice(0, 2).join(" ")}: tool checked in ${seconds(checkedAt - startedAt)}s, ran in ${seconds(Date.now() - checkedAt)}s.\n`,
  });
  return result;
}
/**
 * Stops what the pinned kit runs for a home, through that kit: first every
 * model the model library loaded (`library unload`), whose engines `stack
 * down` leaves running, then, unless `keepController`, the model controller
 * under <home>/runtime/model-services, and last the stack's processes and
 * the gateway the tool started (`stack down`), the library's Bifrost
 * included. An uninstall or an install over this release stops all of it; a
 * quit keeps the controller, which belongs to the services that keep
 * running. Nothing is downloaded. An absent pinned kit is skipped; a pinned
 * kit that is present but fails verification is reported as a stop failure.
 * Every stop command runs even when an earlier command fails; the error
 * names each that did not stop.
 */
export async function stopLocalmodels(
  home: string,
  options: {
    signal: AbortSignal;
    log?: (message: string) => void;
    keepController?: boolean;
    env?: NodeJS.ProcessEnv;
  },
  dependencies: {
    run?: typeof runLocalmodels;
    installed?: (home: string) => Promise<boolean>;
  } = {},
): Promise<void> {
  let installed: boolean;
  try {
    installed = await (dependencies.installed ?? hasPinnedTool)(home);
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error), {
        cause: error,
      }),
      {
        code: LOCALMODELS_KIT_VERIFICATION_FAILED,
      },
    );
  }
  if (!installed) return;
  const run =
    dependencies.run ??
    ((home, args, options = {}) =>
      runLocalmodelsCommand(home, args, options, () =>
        installedPinnedTool(home),
      ));
  const base = localmodelsBaseDirectory(home);
  const failed: string[] = [];
  const step = async (args: string[], name = args.slice(0, 2).join(" ")) => {
    options.signal.throwIfAborted();
    options.log?.(`Stopping the local models (localmodels ${name}).`);
    const result = await run(home, args, {
      signal: options.signal,
      timeoutMs: 30_000,
      ...(options.env ? { env: options.env } : {}),
    }).catch((error: unknown) => {
      options.signal.throwIfAborted();
      return {
        code: 1,
        stdout: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        stderr: "",
      };
    });
    if (result.code !== 0)
      failed.push(`localmodels ${name}: ${stopFailure(result)}`);
    return result;
  };
  const status = await step([
    "library",
    "status",
    "--base-dir",
    base,
    "--json",
  ]);
  if (status.code === 0) {
    const loaded = loadedLibraryModels(status.stdout);
    if (!loaded) failed.push("localmodels library status: no model list");
    for (const model of loaded ?? [])
      await step(
        ["library", "unload", model, "--base-dir", base, "--json"],
        `library unload ${model}`,
      );
  }
  if (!options.keepController)
    await step([
      "foundations",
      "stop",
      "--root",
      modelServicesRoot(home),
      "--json",
    ]);
  await step(["stack", "down", "--json"]);
  if (failed.length) throw new Error(failed.join("; "));
}
// The ids of the models `library status` reports loaded, or undefined when
// its output is not a status report.
function loadedLibraryModels(stdout: string): string[] | undefined {
  try {
    const models = (JSON.parse(stdout) as { models?: unknown }).models;
    if (!Array.isArray(models)) return undefined;
    return models.flatMap((model: { id?: unknown; state?: unknown }) =>
      model?.state === "loaded" &&
      typeof model.id === "string" &&
      /^[a-z0-9][a-z0-9._-]*:[A-Za-z0-9._-]+$/.test(model.id)
        ? [model.id]
        : [],
    );
  } catch {
    return undefined;
  }
}
// A failed step's structured cause: the library's error code, the tool's
// error, or its exit status.
function stopFailure(result: { code: number; stdout: string }): string {
  try {
    const report = JSON.parse(result.stdout) as {
      code?: unknown;
      error?: unknown;
    };
    if (
      typeof report.code === "string" &&
      /^[A-Z][A-Z_]{0,63}$/.test(report.code)
    )
      return report.code;
    if (typeof report.error === "string" && report.error) return report.error;
  } catch {
    // No report: the exit status is all there is.
  }
  return `exit ${result.code}`;
}
async function hasPinnedTool(home: string): Promise<boolean> {
  return (await installedPinnedTool(home)) !== undefined;
}
async function installedPinnedTool(
  home: string,
): Promise<ToolLocation | undefined> {
  const devTool = configuredDevTool();
  if (devTool) return devTool;
  const source = pinnedToolSource();
  if (!source) return;
  return installedKit(kitDirectory(home, source), source).catch(
    (cause: unknown) => {
      throw new Error(
        "Cannot stop local models: the installed tool kit could not be verified. Start Linger to repair the kit, then try again.",
        { cause },
      );
    },
  );
}
/**
 * The kit this release pins, from the installer's published metadata
 * (LINGER_LOCALMODELS_TOOL_JSON), or undefined when it ships none. The one
 * reader of that variable.
 */
export function pinnedToolSource(): LocalmodelsToolSource | undefined {
  if (configuredDevTool()) {
    return {
      url: "https://dev.invalid/localmodels.tgz",
      sha256: "0".repeat(64),
      bytes: 1,
      sourceCommit: "0".repeat(40),
      manifestSha256: "0".repeat(64),
    };
  }
  const raw = process.env.LINGER_LOCALMODELS_TOOL_JSON;
  return raw ? validateToolSource(JSON.parse(raw)) : undefined;
}
function kitDirectory(home: string, source: LocalmodelsToolSource): string {
  return path.join(path.resolve(home), "tools", "localmodels", source.sha256);
}
/** Where the foundations controller of a home keeps its state. */
export function modelServicesRoot(home: string): string {
  return path.join(path.resolve(home), "runtime", "model-services");
}
export async function readPublishedTool(
  file: string,
): Promise<LocalmodelsToolSource | undefined> {
  let value: { platform?: unknown; arch?: unknown; localmodelsTool?: unknown };
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (value.localmodelsTool === undefined) return;
  if (value.platform !== process.platform || value.arch !== process.arch)
    throw new Error(
      "Upstream tool distribution target does not match this computer.",
    );
  return validateToolSource(value.localmodelsTool);
}
