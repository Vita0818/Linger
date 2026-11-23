import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  atomicPrivate,
  privateDirectory,
} from "@linger/local-installation/private-files";
import { localmodelsStateDirectory } from "@linger/local-installation/localmodels-tool";
import { afterEach, describe, expect, it } from "vitest";

import { runTemporarySession } from "./temporary-session.js";

const testRoots: string[] = [];

async function ordinaryHome() {
  const home = await mkdtemp(path.join(tmpdir(), "linger-ordinary-fixture-"));
  testRoots.push(home);
  const state = localmodelsStateDirectory(home);
  await privateDirectory(state);
  await atomicPrivate(
    path.join(state, "model-source.json"),
    JSON.stringify({
      schema: "localmodels.model-source/v1",
      mode: "byok",
      runtime: "pi",
    }),
  );
  await atomicPrivate(
    path.join(state, "byok.json"),
    JSON.stringify({
      base_url: "http://127.0.0.1:8000",
      path: "/v1",
      endpoint: "/chat/completions",
      protocol: "openai-chat",
      model_id: "test-model",
    }),
  );
  const history = path.join(home, "history.json");
  await atomicPrivate(history, "ordinary history");
  return { home, history };
}

afterEach(async () => {
  for (const root of testRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("temporary Desktop supervision", () => {
  it("stops the disposable instance before cleaning its data and leaves ordinary storage alone", async () => {
    const ordinary = await ordinaryHome();
    const ordinaryKit = path.join(ordinary.home, "sealed");
    await privateDirectory(ordinaryKit);
    if (process.platform !== "win32") await chmod(ordinaryKit, 0o500);
    let root = "";
    const phases: string[] = [];
    let gateway: string | undefined;
    await runTemporarySession(ordinary.home, {
      start: async (paths, env) => {
        testRoots.push(paths.root);
        gateway = env.LOCALMODELS_BIFROST_ADDR;
        expect(gateway).toMatch(/^127\.0\.0\.1:\d+$/);
        expect(env.LOCALMODELS_BIFROST_DIR).toBe(
          path.join(paths.home, "runtime", "localmodels", "bifrost"),
        );
        expect(env.LOCALMODELS_TOOLS_DIR).toBe(
          path.join(paths.home, "runtime", "localmodels", "tools"),
        );
        root = paths.root;
        expect(paths.home).not.toBe(ordinary.home);
        await atomicPrivate(
          path.join(paths.home, "history.json"),
          "private history",
        );
        if (process.platform !== "win32") {
          const kits = path.join(paths.home, "tools", "localmodels");
          const sealed = path.join(kits, "fixture-kit");
          await privateDirectory(sealed);
          await atomicPrivate(path.join(sealed, "python"), "sealed tool");
          await chmod(sealed, 0o500);
          await symlink(ordinaryKit, path.join(kits, "ordinary-link"), "dir");
        }
        phases.push("exit");
        return 0;
      },
      stop: async (paths, env) => {
        expect(env.LOCALMODELS_BIFROST_ADDR).toBe(gateway);
        expect(paths.root).toBe(root);
        expect(
          await readFile(path.join(paths.home, "history.json"), "utf8"),
        ).toBe("private history");
        phases.push("stop");
      },
    });
    expect(phases).toEqual(["exit", "stop"]);
    if (process.platform !== "win32")
      expect((await lstat(ordinaryKit)).mode & 0o777).toBe(0o500);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(ordinary.history, "utf8")).toBe("ordinary history");
  });

  it("keeps the temporary directory when the owned services cannot be stopped", async () => {
    const ordinary = await ordinaryHome();
    let root = "";
    await expect(
      runTemporarySession(ordinary.home, {
        start: async (paths) => {
          root = paths.root;
          testRoots.push(root);
          return 0;
        },
        stop: async () => {
          throw new Error("fixture stop failure");
        },
      }),
    ).rejects.toThrow("fixture stop failure");
    expect((await lstat(root)).isDirectory()).toBe(true);
    expect(await readFile(ordinary.history, "utf8")).toBe("ordinary history");
  });
});
