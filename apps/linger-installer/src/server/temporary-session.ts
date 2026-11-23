import { spawn } from "node:child_process";

import { removeRetrying } from "@linger/local-installation/fs-retry";
import {
  stopLocalmodels,
  unlockLocalmodelsKitsForRemoval,
} from "@linger/local-installation/localmodels-tool";
import { freePort } from "@linger/local-installation/ports";
import {
  prepareTemporarySession,
  TEMPORARY_SESSION_ARGUMENT,
  TEMPORARY_WATCH_READY,
  temporarySessionEnvironment,
  temporarySessionFromArgs,
  temporarySessionModelEnvironment,
  type TemporarySessionPaths,
} from "@linger/local-installation/temporary-session";
import { stopDesktopInstallation } from "./stop.js";

interface TemporarySessionDependencies {
  desktopExecutable?: string;
  start?: (
    paths: TemporarySessionPaths,
    env: NodeJS.ProcessEnv,
    desktopExecutable: string,
  ) => Promise<number | null>;
  stop?: (
    paths: TemporarySessionPaths,
    env: NodeJS.ProcessEnv,
  ) => Promise<void>;
}

async function start(
  paths: TemporarySessionPaths,
  env: NodeJS.ProcessEnv,
  desktopExecutable: string,
): Promise<number | null> {
  const child = spawn(
    desktopExecutable,
    [TEMPORARY_SESSION_ARGUMENT + paths.root],
    {
      cwd: paths.root,
      env: { ...temporarySessionEnvironment(), ...env },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

async function stop(
  paths: TemporarySessionPaths,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await stopDesktopInstallation(
    {
      home: paths.home,
      includeCustomHome: false,
      instanceName: "desktop",
      signal: AbortSignal.timeout(120_000),
      log: () => {},
    },
    {
      stopModels: (home, options) => stopLocalmodels(home, { ...options, env }),
    },
  );
  if (result.failed.length > 0)
    throw new Error("The temporary session services could not be stopped.");
}

/**
 * The installer supervises the temporary desktop independently of the regular
 * app, so the regular app can close while a temporary session is open.
 */
export async function runTemporarySession(
  regularHome: string,
  dependencies: TemporarySessionDependencies = {},
): Promise<void> {
  const paths = await prepareTemporarySession(regularHome);
  const env: NodeJS.ProcessEnv = temporarySessionModelEnvironment(paths.home);
  let status: number | null;
  try {
    env.LOCALMODELS_BIFROST_ADDR = `127.0.0.1:${await freePort(new Set())}`;
    status = await (dependencies.start ?? start)(
      paths,
      env,
      dependencies.desktopExecutable ?? process.execPath,
    );
  } finally {
    // A running service may still own the private database. Clean its storage
    // only after the stop succeeded.
    await (dependencies.stop ?? stop)(paths, env);
    await removeTemporarySession(paths);
  }
  if (status !== 0)
    throw new Error("The temporary session exited unexpectedly.");
}

/** The Desktop's pipe closes after normal shutdown and after an abrupt exit. */
export async function watchTemporarySession(root: string): Promise<void> {
  const paths = temporarySessionFromArgs([TEMPORARY_SESSION_ARGUMENT + root]);
  if (!paths) throw new Error("Missing temporary session.");
  const env = {
    ...temporarySessionModelEnvironment(paths.home),
    LOCALMODELS_BIFROST_ADDR: process.env.LOCALMODELS_BIFROST_ADDR,
  };
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.resume();
  });
  process.stdout.write(TEMPORARY_WATCH_READY + "\n");
  await closed;
  await stop(paths, env);
  await removeTemporarySession(paths);
}

async function removeTemporarySession(paths: TemporarySessionPaths) {
  await unlockLocalmodelsKitsForRemoval(paths.home);
  await removeRetrying(paths.root);
}
