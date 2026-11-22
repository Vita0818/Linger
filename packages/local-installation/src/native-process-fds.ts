import {
  closeSync,
  constants,
  readFileSync,
  readlinkSync,
  readdirSync,
} from "node:fs";

export interface CloseInheritedFdsOptions {
  /** File descriptors >= 3 that must stay open (for example Node's IPC fd 3). */
  readonly keepFds?: readonly number[];
  /** Override platform check in tests. */
  readonly platform?: NodeJS.Platform;
  /** Override /proc/self root in tests. */
  readonly procSelfDir?: string;
  /** Override /proc/net root in tests. */
  readonly procNetDir?: string;
  /** Override process.execArgv in tests. */
  readonly execArgv?: readonly string[];
  /** Override closeSync in tests. */
  readonly closeFd?: (fd: number) => void;
}

export interface NodeIpcChannelFdOptions {
  /** Override process.connected in tests. */
  readonly connected?: boolean;
  /** Override process.channel.fd in tests (null simulates an absent channel.fd). */
  readonly channelFd?: number | null;
  /** Override process.env in tests. */
  readonly env?: NodeJS.ProcessEnv;
}

const rawCloexec: unknown = Reflect.get(constants, "O_CLOEXEC");
const O_CLOEXEC = typeof rawCloexec === "number" ? rawCloexec : 0o2000000;
const FLAGS_PATTERN = /^flags:\s+([0-7]+)$/m;
const SOCKET_INODE_PATTERN = /^socket:\[(\d+)\]$/;
// Linux /proc/net/tcp{,6} TCP_LISTEN socket state.
const TCP_LISTEN_STATE = "0A";
// Linux /proc/net/unix SS_UNCONNECTED state and __SO_ACCEPTCON listening flag.
const UNIX_UNCONNECTED_STATE = "01";
const UNIX_ACCEPTCON_FLAG = 0x10000;

/**
 * Returns the file descriptor number of Node's active IPC channel when
 * connected, checking process.channel.fd and NODE_CHANNEL_FD before falling
 * back to 3. Returns undefined when the process has no IPC channel.
 */
export function nodeIpcChannelFd(
  options: NodeIpcChannelFdOptions = {},
): number | undefined {
  const connected = options.connected ?? process.connected;
  if (!connected) return undefined;
  const channelFd =
    options.channelFd !== undefined
      ? options.channelFd
      : (process.channel as { readonly fd?: unknown } | undefined)?.fd;
  if (
    typeof channelFd === "number" &&
    Number.isInteger(channelFd) &&
    channelFd >= 3
  ) {
    return channelFd;
  }
  const raw = (options.env ?? process.env).NODE_CHANNEL_FD;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 3) return parsed;
  }
  return 3;
}

function readListeningSocketInodes(procNetDir: string): Set<string> {
  const inodes = new Set<string>();
  for (const table of ["tcp", "tcp6"]) {
    let text: string;
    try {
      text = readFileSync(`${procNetDir}/${table}`, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let index = 1; index < lines.length; index++) {
      const columns = lines[index]?.trim().split(/\s+/);
      if (!columns || columns.length < 10) continue;
      // Columns: sl local_address rem_address st ... uid timeout inode
      if (columns[3] === TCP_LISTEN_STATE && columns[9] && columns[9] !== "0") {
        inodes.add(columns[9]);
      }
    }
  }
  try {
    const lines = readFileSync(`${procNetDir}/unix`, "utf8").split("\n");
    for (let index = 1; index < lines.length; index++) {
      const columns = lines[index]?.trim().split(/\s+/);
      if (!columns || columns.length < 7) continue;
      // Columns: Num RefCount Protocol Flags Type St Inode [Path]
      const flags = Number.parseInt(columns[3]!, 16);
      if (
        columns[5] === UNIX_UNCONNECTED_STATE &&
        (flags & UNIX_ACCEPTCON_FLAG) !== 0 &&
        columns[6] &&
        columns[6] !== "0"
      ) {
        inodes.add(columns[6]);
      }
    }
  } catch {
    // /proc/net/unix may be unavailable in restricted sandboxes.
  }
  return inodes;
}

/**
 * Closes Linux file descriptors >= 3 that were inherited across execve from a
 * parent process (for example Electron's DevTools listening socket):
 * - Any descriptor >= 3 without O_CLOEXEC (Node and libuv open all of their
 *   own descriptors with O_CLOEXEC, whereas inherited descriptors >= 20 keep
 *   O_CLOEXEC unset).
 * - Any listening TCP/TCP6 or Unix domain socket >= 3 even when Node's startup
 *   set O_CLOEXEC on low descriptor numbers (< 20) without closing them.
 */
export function closeInheritedFileDescriptors(
  options: CloseInheritedFdsOptions = {},
): number[] {
  if ((options.platform ?? process.platform) !== "linux") return [];
  const procSelf = options.procSelfDir ?? "/proc/self";
  const procNet = options.procNetDir ?? "/proc/net";
  const execArgv = options.execArgv ?? process.execArgv;
  const keep = new Set(options.keepFds ?? []);
  const closeFd = options.closeFd ?? closeSync;
  let entries: string[];
  try {
    entries = readdirSync(`${procSelf}/fd`);
  } catch {
    return [];
  }
  // When Node was explicitly started with --inspect*, avoid closing the
  // debugger's own listening socket if it happens to sit on a low FD.
  const inspectEnabled = execArgv.some((arg) => arg.startsWith("--inspect"));
  let listeningInodes: Set<string> | undefined;
  const isListeningSocket = (fd: number): boolean => {
    if (inspectEnabled) return false;
    let target: string;
    try {
      target = readlinkSync(`${procSelf}/fd/${fd}`);
    } catch {
      return false;
    }
    const match = SOCKET_INODE_PATTERN.exec(target);
    if (!match) return false;
    listeningInodes ??= readListeningSocketInodes(procNet);
    return listeningInodes.has(match[1]!);
  };
  const closed: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const fd = Number(entry);
    if (fd < 3 || keep.has(fd)) continue;
    let fdinfo: string;
    try {
      fdinfo = readFileSync(`${procSelf}/fdinfo/${fd}`, "utf8");
    } catch {
      // Closed between readdir and readFile (including readdir's own fd).
      continue;
    }
    const match = FLAGS_PATTERN.exec(fdinfo);
    if (!match) continue;
    const flags = Number.parseInt(match[1]!, 8);
    if ((flags & O_CLOEXEC) !== 0 && !isListeningSocket(fd)) continue;
    try {
      closeFd(fd);
      closed.push(fd);
    } catch {
      // Descriptor already closed or invalid.
    }
  }
  return closed;
}

const LINUX_CLOSE_INHERITED_FDS_MODULE = [
  'import { closeSync, constants, readFileSync, readlinkSync, readdirSync } from "node:fs";',
  'if (process.platform === "linux") {',
  "  const oCloexec = constants.O_CLOEXEC ?? 0o2000000;",
  '  const inspectEnabled = process.execArgv.some((arg) => arg.startsWith("--inspect"));',
  "  const channelFd = process.channel?.fd;",
  "  const envFd = process.env.NODE_CHANNEL_FD ? Number(process.env.NODE_CHANNEL_FD) : Number.NaN;",
  "  const ipcFd = process.connected ? (Number.isInteger(channelFd) && channelFd >= 3 ? channelFd : Number.isInteger(envFd) && envFd >= 3 ? envFd : 3) : -1;",
  "  let listeningInodes;",
  "  const readListening = () => {",
  "    const inodes = new Set();",
  '    for (const table of ["tcp", "tcp6"]) {',
  "      try {",
  '        const lines = readFileSync(`/proc/net/${table}`, "utf8").split("\\n");',
  "        for (let i = 1; i < lines.length; i++) {",
  "          const cols = lines[i]?.trim().split(/\\s+/);",
  '          if (cols && cols.length >= 10 && cols[3] === "0A" && cols[9] && cols[9] !== "0") inodes.add(cols[9]);',
  "        }",
  "      } catch {}",
  "    }",
  "    try {",
  '      const lines = readFileSync("/proc/net/unix", "utf8").split("\\n");',
  "      for (let i = 1; i < lines.length; i++) {",
  "        const cols = lines[i]?.trim().split(/\\s+/);",
  '        if (cols && cols.length >= 7 && cols[5] === "01" && (Number.parseInt(cols[3], 16) & 0x10000) !== 0 && cols[6] && cols[6] !== "0") inodes.add(cols[6]);',
  "      }",
  "    } catch {}",
  "    return inodes;",
  "  };",
  "  const isListeningSocket = (fd) => {",
  "    if (inspectEnabled) return false;",
  "    try {",
  "      const m = /^socket:\\[(\\d+)\\]$/.exec(readlinkSync(`/proc/self/fd/${fd}`));",
  "      if (!m) return false;",
  "      listeningInodes ??= readListening();",
  "      return listeningInodes.has(m[1]);",
  "    } catch { return false; }",
  "  };",
  "  let entries = [];",
  '  try { entries = readdirSync("/proc/self/fd"); } catch {}',
  "  for (const entry of entries) {",
  "    if (!/^\\d+$/.test(entry)) continue;",
  "    const fd = Number(entry);",
  "    if (fd < 3 || fd === ipcFd) continue;",
  "    try {",
  '      const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");',
  "      const match = /^flags:\\s+([0-7]+)$/m.exec(info);",
  "      if (!match) continue;",
  "      const flags = Number.parseInt(match[1], 8);",
  "      if ((flags & oCloexec) === 0 || isListeningSocket(fd)) closeSync(fd);",
  "    } catch {}",
  "  }",
  "}",
].join("\n");

const LINUX_CLOSE_INHERITED_FDS_IMPORT_URL = `data:text/javascript,${encodeURIComponent(LINUX_CLOSE_INHERITED_FDS_MODULE)}`;

/**
 * Node CLI flags that close inherited non-FD_CLOEXEC descriptors and listening
 * TCP/Unix sockets >= 3 before a spawned Node script executes on Linux; empty
 * on other platforms.
 */
export function linuxNodeFdHygieneArgs(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return platform === "linux"
    ? ["--import", LINUX_CLOSE_INHERITED_FDS_IMPORT_URL]
    : [];
}
