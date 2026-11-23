import { lstatSync, realpathSync } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultByokEndpoint } from "@linger/service-kit/byok-endpoint";

import {
  readByokEnvironment,
  validateByokConfiguration,
  type ByokConfiguration,
} from "./byok-source.js";
import { localmodelsStateDirectory } from "./localmodels-tool.js";
import type { NativeRuntime } from "./managed-runtimes.js";
import {
  atomicPrivate,
  privateDirectory,
  readPrivate,
} from "./private-files.js";

export const TEMPORARY_SESSION_ARGUMENT = "--temporary-session=";
const ROOT_PREFIX = "linger-temporary-session-";

export interface TemporarySessionPaths {
  readonly root: string;
  readonly home: string;
  readonly userData: string;
  readonly workspace: string;
  readonly setup: string;
}

interface TemporarySessionModel extends ByokConfiguration {
  runtime: NativeRuntime;
}

function pathsFor(root: string): TemporarySessionPaths {
  return {
    root,
    home: path.join(root, "services"),
    userData: path.join(root, "desktop"),
    workspace: path.join(root, "workspace"),
    setup: path.join(root, "setup.json"),
  };
}

/** Resolve the private profile before Electron opens a session or a log file. */
export function temporarySessionFromArgs(
  argv: readonly string[],
): TemporarySessionPaths | undefined {
  const requests = argv.filter(
    (arg) =>
      arg === "--temporary-session" ||
      arg.startsWith(TEMPORARY_SESSION_ARGUMENT),
  );
  if (requests.length === 0) return undefined;
  const arg = requests[0]!;
  if (requests.length !== 1 || !arg.startsWith(TEMPORARY_SESSION_ARGUMENT))
    throw new Error("Invalid temporary session request.");
  const root = arg.slice(TEMPORARY_SESSION_ARGUMENT.length);
  if (!path.isAbsolute(root) || !path.basename(root).startsWith(ROOT_PREFIX))
    throw new Error("Invalid temporary session directory.");
  const info = lstatSync(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    path.dirname(realpathSync(root)) !== realpathSync(tmpdir()) ||
    (process.platform !== "win32" &&
      (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
  )
    throw new Error("Temporary sessions need a private temporary directory.");
  const paths = pathsFor(root);
  for (const directory of [paths.home, paths.userData, paths.workspace]) {
    const child = lstatSync(directory);
    if (
      !child.isDirectory() ||
      child.isSymbolicLink() ||
      path.dirname(realpathSync(directory)) !== realpathSync(root) ||
      (process.platform !== "win32" &&
        (child.uid !== process.getuid?.() || (child.mode & 0o077) !== 0))
    )
      throw new Error("Invalid temporary session storage.");
  }
  return paths;
}

async function activeByokModel(home: string): Promise<TemporarySessionModel> {
  const source = await readByokEnvironment(home);
  if (source?.mode !== "byok")
    throw new Error(
      "Configure your own model endpoint before opening a temporary session.",
    );
  const saved = await readPrivate(
    path.join(localmodelsStateDirectory(home), "byok.json"),
  );
  if (!saved)
    throw new Error("The current model endpoint has no saved configuration.");
  const record = JSON.parse(saved) as Record<string, unknown>;
  return {
    ...validateByokConfiguration({
      baseUrl: record.base_url,
      path: record.path ?? "/v1",
      endpoint: record.endpoint ?? defaultByokEndpoint(source.runtime),
      protocol: record.protocol,
      modelId: record.model_id,
      contextWindow: record.context_window,
      apiKey: record.api_key,
    }),
    runtime: source.runtime,
  };
}

export async function prepareTemporarySession(
  regularHome: string,
): Promise<TemporarySessionPaths> {
  const model = await activeByokModel(regularHome);
  const paths = pathsFor(await mkdtemp(path.join(tmpdir(), ROOT_PREFIX)));
  try {
    await privateDirectory(paths.root);
    await Promise.all(
      [paths.home, paths.userData, paths.workspace].map(privateDirectory),
    );
    // The model credential never goes in process arguments or the environment.
    await atomicPrivate(paths.setup, JSON.stringify(model));
    return paths;
  } catch (error) {
    await rm(paths.root, { recursive: true, force: true });
    throw error;
  }
}

export async function takeTemporarySessionModel(
  paths: TemporarySessionPaths,
): Promise<TemporarySessionModel> {
  const raw = await readPrivate(paths.setup);
  if (!raw) throw new Error("Temporary session setup is missing.");
  const model = validateByokConfiguration(JSON.parse(raw));
  if (!model.runtime) throw new Error("Temporary session runtime is missing.");
  await unlink(paths.setup);
  return { ...model, runtime: model.runtime };
}

/** The kit's gateway config and ownership manifest live outside LOCALMODELS_STATE. */
export function temporarySessionModelEnvironment(
  home: string,
): Record<string, string> {
  const root = path.dirname(localmodelsStateDirectory(home));
  return {
    LOCALMODELS_TOOLS_DIR: path.join(root, "tools"),
    LOCALMODELS_BIFROST_DIR: path.join(root, "bifrost"),
  };
}

const temporaryEnvironmentKeys = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

/** Keep OS/desktop networking; drop overrides that could reach regular state. */
export function temporarySessionEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      temporaryEnvironmentKeys.has(key.toUpperCase()),
    ),
  );
}
