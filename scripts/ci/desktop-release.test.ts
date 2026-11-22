import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/ci/desktop-release.sh");
const temporary: string[] = [];

function run(args: string[], env: Record<string, string> = {}, file = script) {
  const result = spawnSync("bash", [file, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: tmpdir(), ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "desktop-release-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("desktop-release.sh version", () => {
  it("reads a release tag", () => {
    const result = run(["version", "desktop-v0.16.33"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "tag=desktop-v0.16.33\nversion=0.16.33\nprerelease=false\n",
    );
  });

  it("marks a hyphenated version as a prerelease", () => {
    const result = run(["version", "desktop-v0.16.33-rc.1"]);
    expect(result.stdout).toBe(
      "tag=desktop-v0.16.33-rc.1\nversion=0.16.33-rc.1\nprerelease=true\n",
    );
  });

  it("gives a bare version from a manual run its tag", () => {
    expect(run(["version", "1.2.3"]).stdout).toContain("tag=desktop-v1.2.3\n");
  });

  it.each([
    "v0.16.33",
    "cli-v0.16.33",
    "desktop-v0.16",
    "desktop-v0.16.33-",
    "",
  ])("rejects %j", (tag) => {
    const result = run(["version", tag]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});

describe("desktop-release.sh guided-install", () => {
  const version = "0.16.33";
  const bundle = `Linger-${version}-guided-install`;
  const paths = [
    "LICENSE",
    "NOTICE",
    "scripts/install/install.sh",
    "scripts/install/install.ps1",
    "scripts/installs/stack.sh",
    "scripts/installs/stack.ps1",
  ];

  it("packs the release commit's scripts, not copies from the workspace", () => {
    const dir = folder();
    const result = run(["guided-install", dir, version]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const archive = join(dir, `${bundle}.zip`);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    const names = execFileSync("unzip", ["-Z", "-1", archive], {
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter((name) => !name.endsWith("/"));
    expect(names.sort()).toEqual(
      [...paths, "SOURCE_COMMIT"].map((name) => `${bundle}/${name}`).sort(),
    );
    expect(
      execFileSync("unzip", ["-p", archive, `${bundle}/SOURCE_COMMIT`]),
    ).toEqual(Buffer.from(commit));
    for (const path of paths) {
      expect(
        execFileSync("unzip", ["-p", archive, `${bundle}/${path}`]),
      ).toEqual(execFileSync("git", ["show", `${commit.trim()}:${path}`]));
    }
  });

  it("rejects a source commit missing an entrypoint", () => {
    const source = folder();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", source, ...args], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: source,
          GIT_CONFIG_NOSYSTEM: "1",
        },
        encoding: "utf8",
      }).trim();
    git("init", "--quiet");
    for (const path of paths.filter(
      (path) => path !== "scripts/install/install.ps1",
    )) {
      mkdirSync(join(source, path, ".."), { recursive: true });
      writeFileSync(join(source, path), path);
    }
    git("add", ".");
    const tree = git("write-tree");
    const commit = git(
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=release@example.test",
      "commit-tree",
      tree,
      "-m",
      "Installer without a Windows entrypoint",
    );
    git("update-ref", "HEAD", commit);

    const output = folder();
    const result = run(["guided-install", output, version], {
      GIT_DIR: join(source, ".git"),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `could not package the guided installer from ${commit}`,
    );
    expect(readdirSync(output)).toEqual([]);
  });

  it("finds the bundled stack when run outside a Linger checkout", () => {
    const dir = folder();
    expect(run(["guided-install", dir, version]).status).toBe(0);
    execFileSync("unzip", ["-q", join(dir, `${bundle}.zip`), "-d", dir]);
    const root = join(dir, bundle);
    writeFileSync(
      join(root, "scripts/installs/stack.sh"),
      '[ "$1" = --bootstrap-json ] || exit 2\nprintf "%s\\n" "guided bundle bootstrap reached" >&2\nexit 1\n',
    );

    const result = run(
      ["--status"],
      {
        HOME: dir,
        TMPDIR: dir,
        LOCALMODELS_KIT_HOME: dir,
        LINGER_STACK_URL: "http://127.0.0.1:1/unexpected",
      },
      join(root, "scripts/install/install.sh"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("guided bundle bootstrap reached");
  });
});

describe("desktop-release.sh checksums", () => {
  const version = "0.16.33";
  const required = [
    `Linger-${version}-macos-arm64.dmg`,
    `Linger-${version}-linux-x64.tar.gz`,
    `Linger-${version}-windows-x64-setup.exe`,
    `Linger-${version}-guided-install.zip`,
  ];

  it("lists every file of the version", () => {
    const dir = folder();
    const files = [...required, `Linger-${version}-windows-x64-portable.zip`];
    for (const name of files) writeFileSync(join(dir, name), name);
    writeFileSync(join(dir, "Linger-0.16.32-macos-arm64.dmg"), "older");

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(0);
    const expected = [...files]
      .sort()
      .map(
        (name) =>
          `${createHash("sha256").update(name).digest("hex")}  ${name}\n`,
      )
      .join("");
    expect(readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")).toBe(expected);
  });

  it("refuses a release without one of the installers", () => {
    const dir = folder();
    for (const name of required.filter((name) => !name.endsWith(".exe")))
      writeFileSync(join(dir, name), name);

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Linger-${version}-windows-x64-setup.exe`);
  });

  it("refuses a release without the guided installer", () => {
    const dir = folder();
    for (const name of required.slice(0, -1))
      writeFileSync(join(dir, name), name);

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Linger-${version}-guided-install.zip`);
    expect(existsSync(join(dir, "SHA256SUMS.txt"))).toBe(false);
  });

  // The DMG names its platform like the other packages.
  it("refuses a DMG without macos in its name", () => {
    const dir = folder();
    for (const name of [`Linger-${version}-arm64.dmg`, ...required.slice(1)])
      writeFileSync(join(dir, name), name);

    const result = run(["checksums", dir, version]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Linger-${version}-macos-arm64.dmg`);
  });
});

describe("desktop-release.sh manifest", () => {
  const version = "0.16.33";
  const packages = {
    "darwin-arm64": `Linger-${version}-macos-arm64.app.tar.gz`,
    "linux-x64": `Linger-${version}-linux-x64.tar.gz`,
    "win32-x64": `Linger-${version}-windows-x64-setup.exe`,
  };
  const release = () => {
    const dir = folder();
    for (const name of Object.values(packages))
      writeFileSync(join(dir, name), name);
    writeFileSync(join(dir, `Linger-${version}-macos-arm64.dmg`), "dmg");
    writeFileSync(join(dir, `Linger-${version}-guided-install.zip`), "zip");
    return dir;
  };
  // A copy of the script beside an update-manifest.ts holding a throwaway
  // key's public half, so the test never needs the release key.
  const checkout = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const root = folder();
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    mkdirSync(join(root, "apps/desktop/src/main"), { recursive: true });
    copyFileSync(script, join(root, "scripts/ci/desktop-release.sh"));
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    writeFileSync(
      join(root, "apps/desktop/src/main/update-manifest.ts"),
      `export const UPDATE_PUBLIC_KEY = \`${publicPem.toString().trim()}\`;\n`,
    );
    const key = join(folder(), "update.pem");
    writeFileSync(
      key,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    return {
      script: join(root, "scripts/ci/desktop-release.sh"),
      key,
      publicKey,
    };
  };

  it("signs a manifest of every platform's package", () => {
    const dir = release();
    const repo = checkout();

    const result = run(
      ["manifest", dir, version],
      { DESKTOP_UPDATE_KEY: repo.key },
      repo.script,
    );

    expect(result.status).toBe(0);
    const bytes = readFileSync(join(dir, "manifest.json"));
    const signature = readFileSync(join(dir, "manifest.json.sig"), "utf8");
    expect(
      verify(null, bytes, repo.publicKey, Buffer.from(signature, "base64")),
    ).toBe(true);
    expect(JSON.parse(bytes.toString())).toEqual({
      schema: 2,
      version,
      packages: Object.fromEntries(
        Object.entries(packages).map(([target, file]) => [
          target,
          {
            file,
            sha256: createHash("sha256").update(file).digest("hex"),
            size: file.length,
          },
        ]),
      ),
    });

    run(["checksums", dir, version]);
    const sums = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8");
    expect(sums).toContain("  manifest.json\n");
    expect(sums).toContain("  manifest.json.sig\n");
  });

  it("warns and writes nothing without the key", () => {
    const dir = release();

    const result = run(["manifest", dir, version]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning::DESKTOP_UPDATE_KEY_PEM");
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("refuses a key installed apps would not accept", () => {
    const dir = release();
    // The throwaway key against this checkout's UPDATE_PUBLIC_KEY.
    const other = checkout();

    const result = run(["manifest", dir, version], {
      DESKTOP_UPDATE_KEY: other.key,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("UPDATE_PUBLIC_KEY");
    expect(existsSync(join(dir, "manifest.json"))).toBe(false);
  });

  it("refuses a release without a platform's package", () => {
    const dir = release();
    rmSync(join(dir, packages["darwin-arm64"]));
    const repo = checkout();

    const result = run(
      ["manifest", dir, version],
      { DESKTOP_UPDATE_KEY: repo.key },
      repo.script,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(packages["darwin-arm64"]);
  });
});

describe("desktop-release.sh build", () => {
  it("needs a known target and a version", () => {
    expect(
      run(["build", "darwin-x64"], { DESKTOP_VERSION: "1.0.0" }).status,
    ).toBe(1);
    expect(run(["compile", "linux-x64"]).stderr).toContain("DESKTOP_VERSION");
  });

  it("stops before building when a pinned archive has no source", () => {
    const result = run(["build", "linux-x64"], {
      DESKTOP_VERSION: "1.0.0",
      RELEASE_OUT: folder(),
      LINGER_NATIVE_POSTGRES_DIR: folder(),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LINGER_NATIVE_DEPS_URL");
  });

  it("keeps the archive folder's address out of the log", () => {
    const result = run(["fetch-native", "linux-x64"], {
      LINGER_NATIVE_POSTGRES_DIR: folder(),
      LINGER_NATIVE_DEPS_URL: "http://deps.invalid/private/folder",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot download");
    expect(result.stdout + result.stderr).not.toContain("deps.invalid");
  });
});

describe("desktop-release.sh gitlab-upload", () => {
  it("needs GitLab CI", () => {
    const result = run(["gitlab-upload", ".", "1.0.0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CI_API_V4_URL is not set");
  });

  it.each(["target", "gitlab-release"])(
    "has no %s command: releases publish only on GitHub",
    (command) => {
      expect(run([command]).status).toBe(2);
    },
  );
});

describe("desktop-release.sh github-release", () => {
  const version = "1.0.0-rc.1";
  const tag = `desktop-v${version}`;

  // A gh that records its arguments and has no release yet.
  function release(env: Record<string, string>) {
    const dir = folder();
    const bin = folder();
    const log = join(dir, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >>"${log}"\n[ "$2" != view ]\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(dir, "SHA256SUMS.txt"), "");
    const result = run(["github-release", dir, tag, version], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ...env,
    });
    let calls = "";
    try {
      calls = readFileSync(log, "utf8");
    } catch {
      // gh was not run
    }
    return { ...result, calls };
  }

  it("publishes to simplexai-labs/linger by default", () => {
    const result = release({
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GITHUB_SHA: "abc123",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain(`release create ${tag} `);
    expect(result.calls).toContain("--repo simplexai-labs/linger");
    expect(result.calls).toContain("--target abc123");
    expect(result.calls).toContain("--prerelease");
    expect(result.calls).not.toContain("--latest");
  });

  it("leaves another repository's commit out of a cross-repository release", () => {
    const result = release({
      GITHUB_REPOSITORY: "example/linger-copy",
      GITHUB_SHA: "abc123",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    expect(result.calls).toContain("--repo simplexai-labs/linger");
    expect(result.calls).not.toContain("abc123");
  });

  it("marks a stable release as the latest", () => {
    const dir = folder();
    const bin = folder();
    const log = join(dir, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >>"${log}"\n[ "$2" != view ]\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(dir, "SHA256SUMS.txt"), "");

    const result = run(["github-release", dir, "desktop-v1.0.0", "1.0.0"], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "simplexai-labs/linger",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("--latest");
  });

  it("needs LINGER_RELEASE_TOKEN to publish from another repository", () => {
    const result = release({ GITHUB_REPOSITORY: "example/linger-copy" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LINGER_RELEASE_TOKEN");
    expect(result.calls).toBe("");
  });

  it("refuses a RELEASE_REPO that is not owner/name", () => {
    const result = release({
      RELEASE_REPO: "https://github.com/simplexai-labs/linger",
      GH_TOKEN: "token",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("owner/name");
  });
});
