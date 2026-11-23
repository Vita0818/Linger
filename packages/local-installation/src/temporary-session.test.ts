import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { localmodelsStateDirectory } from "./localmodels-tool.js";
import { atomicPrivate, privateDirectory } from "./private-files.js";
import {
  prepareTemporarySession,
  takeTemporarySessionModel,
  TEMPORARY_SESSION_ARGUMENT,
  temporarySessionEnvironment,
  temporarySessionFromArgs,
} from "./temporary-session.js";

const testRoots: string[] = [];

async function ordinaryModelHome() {
  const home = await mkdtemp(path.join(tmpdir(), "linger-regular-fixture-"));
  testRoots.push(home);
  const state = localmodelsStateDirectory(home);
  await privateDirectory(state);
  const credentials = path.join(state, "byok.json");
  const saved = JSON.stringify({
    base_url: "http://127.0.0.1:8000",
    path: "/v1",
    endpoint: "/chat/completions",
    protocol: "openai-chat",
    model_id: "test-model",
    api_key: "fixture-only",
    context_window: 65536,
  });
  await atomicPrivate(credentials, saved);
  await atomicPrivate(
    path.join(state, "model-source.json"),
    JSON.stringify({
      schema: "localmodels.model-source/v1",
      mode: "byok",
      runtime: "pi",
    }),
  );
  return { home, credentials, saved };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of testRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("temporary session storage", () => {
  it("isolates services, desktop state and workspace from the ordinary model home", async () => {
    const ordinary = await ordinaryModelHome();
    const paths = await prepareTemporarySession(ordinary.home);
    testRoots.push(paths.root);
    expect(
      temporarySessionFromArgs([TEMPORARY_SESSION_ARGUMENT + paths.root]),
    ).toEqual(paths);
    for (const directory of [paths.home, paths.userData, paths.workspace]) {
      expect(path.dirname(directory)).toBe(paths.root);
      expect(directory.startsWith(ordinary.home)).toBe(false);
    }
    const model = await takeTemporarySessionModel(paths);
    expect(model).toMatchObject({
      runtime: "pi",
      modelId: "test-model",
      contextWindow: 65536,
    });
    await expect(lstat(paths.setup)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(ordinary.credentials, "utf8")).toBe(ordinary.saved);
  });

  it.skipIf(process.platform === "win32")(
    "uses the physical directory for the runtime beneath a temporary alias",
    async () => {
      const ordinary = await ordinaryModelHome();
      const fixture = await mkdtemp(path.join(tmpdir(), "linger-temp-alias-"));
      testRoots.push(fixture);
      const actual = path.join(fixture, "actual");
      const alias = path.join(fixture, "alias");
      await mkdir(actual, { mode: 0o700 });
      await symlink(actual, alias, "dir");
      vi.stubEnv("TMPDIR", alias);

      const paths = await prepareTemporarySession(ordinary.home);
      expect(path.dirname(paths.root)).toBe(await realpath(actual));
      expect(
        temporarySessionFromArgs([
          TEMPORARY_SESSION_ARGUMENT +
            path.join(alias, path.basename(paths.root)),
        ]),
      ).toEqual(paths);
    },
  );

  it("rejects missing or redirected private storage", async () => {
    expect(temporarySessionFromArgs([])).toBeUndefined();
    expect(() => temporarySessionFromArgs(["--temporary-session"])).toThrow();
    const ordinary = await ordinaryModelHome();
    const paths = await prepareTemporarySession(ordinary.home);
    testRoots.push(paths.root);
    expect(() =>
      temporarySessionFromArgs([TEMPORARY_SESSION_ARGUMENT + ordinary.home]),
    ).toThrow();
    if (process.platform === "win32") return;
    await rm(paths.home, { recursive: true });
    await symlink(ordinary.home, paths.home, "dir");
    expect(() =>
      temporarySessionFromArgs([TEMPORARY_SESSION_ARGUMENT + paths.root]),
    ).toThrow("Invalid temporary session storage");
  });

  it("keeps ordinary storage overrides and credentials out of the guest environment", () => {
    expect(
      temporarySessionEnvironment({
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://localhost:7890",
        ELECTRON_RUN_AS_NODE: "1",
        LINGER_HOME: "/ordinary",
        LINGER_SERVER_URL: "http://localhost:3000",
        PI_CODING_AGENT_DIR: "/ordinary/profile",
        TEAMHUB_DATABASE_URL: "postgres://ordinary",
        NODE_SERVICES_ROLES: "memory,llm-wiki",
        DEEPSEEK_API_KEY: "fixture-only",
      }),
    ).toEqual({ PATH: "/usr/bin", HTTPS_PROXY: "http://localhost:7890" });
  });
});
