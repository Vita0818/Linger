import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeInheritedFileDescriptors,
  linuxNodeFdHygieneArgs,
  nodeIpcChannelFd,
} from "./native-process-fds.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("closeInheritedFileDescriptors", () => {
  it("closes non-O_CLOEXEC FDs >= 3 and inherited listening TCP sockets while preserving stdio, IPC, and Node internal FDs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-fds-"));
    roots.push(root);
    const procSelf = path.join(root, "proc-self");
    const procNet = path.join(root, "proc-net");
    await mkdir(path.join(procSelf, "fd"), { recursive: true });
    await mkdir(path.join(procSelf, "fdinfo"), { recursive: true });
    await mkdir(procNet, { recursive: true });

    const entries: Array<[number, string, string]> = [
      [0, "02", "/dev/null"],
      [1, "02", "/dev/null"],
      [2, "02", "/dev/null"],
      // IPC socket on fd 3 kept via keepFds.
      [3, "02004002", "socket:[1001]"],
      // Low inherited listening TCP socket whose O_CLOEXEC was set by Node startup.
      [5, "02004002", "socket:[2002]"],
      // Low inherited listening Unix domain socket whose O_CLOEXEC was set by Node startup.
      [6, "02004002", "socket:[2505]"],
      // Unconnected non-listening Unix datagram socket (state 01 without __SO_ACCEPTCON).
      [7, "02004002", "socket:[2606]"],
      // Node internal Unix domain socketpair (connected state 03).
      [15, "02004002", "socket:[3003]"],
      // Node internal eventpoll.
      [16, "02000002", "anon_inode:[eventpoll]"],
      // High inherited listening TCP socket without O_CLOEXEC.
      [67, "02", "socket:[4004]"],
    ];
    for (const [fd, flags, target] of entries) {
      await symlink(target, path.join(procSelf, "fd", String(fd)));
      await writeFile(
        path.join(procSelf, "fdinfo", String(fd)),
        `pos:\t0\nflags:\t${flags}\nmnt_id:\t9\n`,
      );
    }
    await writeFile(
      path.join(procNet, "tcp"),
      [
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
        "   0: 0100007F:4B16 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2002 1 0000000000000000 100 0 0 10 0",
        "   1: 0100007F:4B17 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4004 1 0000000000000000 100 0 0 10 0",
      ].join("\n"),
    );
    await writeFile(
      path.join(procNet, "unix"),
      [
        "Num       RefCount Protocol Flags    Type St Inode Path",
        "0000000000000000: 00000002 00000000 00010000 0001 01 2505 /tmp/electron-singleton.sock",
        "0000000000000000: 00000002 00000000 00000000 0002 01 2606",
        "0000000000000000: 00000003 00000000 00000000 0001 03 3003",
      ].join("\n"),
    );

    const closed: number[] = [];
    const result = closeInheritedFileDescriptors({
      platform: "linux",
      procSelfDir: procSelf,
      procNetDir: procNet,
      keepFds: [3],
      execArgv: [],
      closeFd: (fd) => closed.push(fd),
    });

    expect(result.sort((a, b) => a - b)).toEqual([5, 6, 67]);
    expect(closed.sort((a, b) => a - b)).toEqual([5, 6, 67]);
  });

  it("resolves the active Node IPC channel FD from channel.fd, NODE_CHANNEL_FD, or fallback 3", () => {
    expect(nodeIpcChannelFd({ connected: false })).toBeUndefined();
    expect(nodeIpcChannelFd({ connected: true, channelFd: 5 })).toBe(5);
    expect(
      nodeIpcChannelFd({
        connected: true,
        channelFd: null,
        env: { NODE_CHANNEL_FD: "4" },
      }),
    ).toBe(4);
    expect(
      nodeIpcChannelFd({ connected: true, channelFd: null, env: {} }),
    ).toBe(3);
    expect(
      nodeIpcChannelFd({
        connected: true,
        channelFd: null,
        env: { NODE_CHANNEL_FD: "bad" },
      }),
    ).toBe(3);
  });

  it("does nothing on non-Linux platforms", () => {
    expect(closeInheritedFileDescriptors({ platform: "darwin" })).toEqual([]);
    expect(closeInheritedFileDescriptors({ platform: "win32" })).toEqual([]);
    expect(linuxNodeFdHygieneArgs("darwin")).toEqual([]);
    expect(linuxNodeFdHygieneArgs("win32")).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")(
    "closes inherited listening TCP sockets in a spawned Node child via linuxNodeFdHygieneArgs",
    async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const handle = (server as unknown as { _handle?: { fd?: number } })
          ._handle;
        const listenFd = handle?.fd;
        expect(typeof listenFd).toBe("number");
        const stdio: Array<"ignore" | "pipe" | number> = [
          "ignore",
          "pipe",
          "pipe",
        ];
        // Map the listening socket onto both a low FD (5) and a high FD (67).
        while (stdio.length < 68) stdio.push("ignore");
        stdio[5] = listenFd!;
        stdio[67] = listenFd!;
        const result = spawnSync(
          process.execPath,
          [
            ...linuxNodeFdHygieneArgs("linux"),
            "-e",
            `
              const fs = require("node:fs");
              const check = (fd) => {
                try { return fs.readlinkSync("/proc/self/fd/" + fd); }
                catch { return null; }
              };
              console.log(JSON.stringify({ fd5: check(5), fd67: check(67) }));
            `,
          ],
          { stdio, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        const reported = JSON.parse(result.stdout.trim()) as {
          fd5: string | null;
          fd67: string | null;
        };
        expect(reported.fd5).toBeNull();
        expect(reported.fd67).toBeNull();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "closes inherited listening Unix sockets while preserving a non-3 IPC channel FD",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "native-unix-fds-"));
      roots.push(root);
      const sockPath = path.join(root, "listen.sock");
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(sockPath, resolve));
      try {
        const handle = (server as unknown as { _handle?: { fd?: number } })
          ._handle;
        const listenFd = handle?.fd;
        expect(typeof listenFd).toBe("number");
        const message = await new Promise<{
          unixFd: string | null;
          channelFd: number | null;
        }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              ...linuxNodeFdHygieneArgs("linux"),
              "-e",
              `
                const fs = require("node:fs");
                let unixFd = null;
                try { unixFd = fs.readlinkSync("/proc/self/fd/5"); } catch {}
                process.send({ unixFd, channelFd: process.channel?.fd ?? null });
                process.disconnect();
              `,
            ],
            {
              // Place IPC on FD 4 (not 3) and the listening Unix socket on FD 5.
              stdio: ["ignore", "pipe", "pipe", "ignore", "ipc", listenFd!],
            },
          );
          let stderr = "";
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          let received:
            | { unixFd: string | null; channelFd: number | null }
            | undefined;
          child.once("message", (payload) => {
            received = payload as {
              unixFd: string | null;
              channelFd: number | null;
            };
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (code !== 0 || !received)
              reject(new Error(`child exited ${code}: ${stderr}`));
            else resolve(received);
          });
        });
        expect(message).toEqual({ unixFd: null, channelFd: 4 });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
