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
  temporarySessionEnvironment,
  temporarySessionModelEnvironment,
  type TemporarySessionPaths,
} from "@linger/local-installation/temporary-session";
import { stopDesktopInstallation } from "./stop.js";

interface TemporarySessionDependencies {
  start?: (
    paths: TemporarySessionPaths,
    env: NodeJS.ProcessEnv,
  ) => Promise<number | null>;
  stop?: (
    paths: TemporarySessionPaths,
    env: NodeJS.ProcessEnv,
  ) => Promise<void>;
}

async function start(
  paths: TemporarySessionPaths,
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  const child = spawn(
    process.execPath,
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
  const env = temporarySessionModelEnvironment(paths.home);
  let status: number | null;
  try {
    env.LOCALMODELS_BIFROST_ADDR = `127.0.0.1:${await freePort(new Set())}`;
    status = await (dependencies.start ?? start)(paths, env);
  } finally {
    // A running service may still own the private database. Clean its storage
    // only after the stop succeeded.
    await (dependencies.stop ?? stop)(paths, env);
    await unlockLocalmodelsKitsForRemoval(paths.home);
    await removeRetrying(paths.root);
  }
  if (status !== 0)
    throw new Error("The temporary session exited unexpectedly.");
}
