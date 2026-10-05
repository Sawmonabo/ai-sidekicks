// The daemon started from its command, `src/main.ts`, as a real child process: it answers
// `daemon.hello` on its socket, keeps serving a client that drops and reconnects, comes back after
// a SIGKILL over the socket file the crash left with the same machine id and a new session token
// the old one no longer opens, and stops cleanly on SIGTERM, a second one during its drain
// included. Its service log goes to standard error and to its own file, and a log folder it cannot
// open never stops it. Each run gets its own home and run folder, so the person's own files are
// never read.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DAEMON_DATA_FOLDER_NAME } from "@ai-sidekicks/contracts/daemon-data";
import { DAEMON_READY_LINE } from "@ai-sidekicks/contracts/daemon-lifecycle";
import { JSONRPC_VERSION, JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc-negotiation";
import { resolveDaemonRunFolder } from "@ai-sidekicks/contracts/daemon-run-folder";
import { MACHINE_SETTINGS_FILE_PATH_SEGMENTS } from "@ai-sidekicks/contracts/machine-settings";

import { connect } from "../ipc/__tests__/local-socket-client.test-support.js";

const ENTRY_POINT = fileURLToPath(new URL("../main.ts", import.meta.url));
const SOURCE_LOADER = new URL("./typescript-source-loader.mjs", import.meta.url).href;
// The start runs the login shell under its own 5 s deadline, so readiness is bounded above that.
const READY_TIMEOUT_MS = 15_000;

interface RunningDaemon {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Everything the daemon has written to standard error so far. */
  readonly standardError: () => string;
}

let scratch: string;
let homeDirectory: string;
let runtimeDirectory: string;
let socketPath: string;
let tokenPath: string;
const running: RunningDaemon[] = [];

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "aisk-"));
  homeDirectory = path.join(scratch, "home");
  runtimeDirectory = path.join(scratch, "run");
  await mkdir(homeDirectory);
  await mkdir(runtimeDirectory, { mode: 0o700 });
  ({ socketPath, tokenPath } = resolveDaemonRunFolder({
    platform: process.platform,
    runtimeDirectory,
    temporaryDirectory: os.tmpdir(),
    userId: os.userInfo().uid,
  }));
});

afterEach(async () => {
  for (const daemon of running.splice(0)) {
    if (daemon.child.exitCode === null && daemon.child.signalCode === null) {
      daemon.child.kill("SIGKILL");
      await daemon.exited;
    }
  }
  await rm(scratch, { recursive: true, force: true });
});

/** Starts the daemon from its command and resolves once it says it is ready. */
function startDaemon(): Promise<RunningDaemon> {
  const child = spawn(
    process.execPath,
    [
      "--conditions=@ai-sidekicks/source",
      "--import",
      `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(SOURCE_LOADER)})`,
      ENTRY_POINT,
    ],
    {
      env: { ...process.env, HOME: homeDirectory, XDG_RUNTIME_DIR: runtimeDirectory },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  let serviceLog = "";
  const daemon: RunningDaemon = { child, exited, standardError: () => serviceLog };
  running.push(daemon);
  return new Promise<RunningDaemon>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`The daemon did not become ready: ${serviceLog}`));
    }, READY_TIMEOUT_MS);
    child.stderr!.on("data", (chunk: Buffer) => {
      serviceLog += chunk.toString("utf8");
      if (serviceLog.includes(DAEMON_READY_LINE)) {
        clearTimeout(timeout);
        resolve(daemon);
      }
    });
    void exited.then(({ code, signal }) => {
      clearTimeout(timeout);
      reject(
        new Error(`The daemon exited (${String(code ?? signal)}) before ready: ${serviceLog}`),
      );
    });
  });
}

const readSessionToken = (): Promise<string> => readFile(tokenPath, "utf8");

/** Sends `daemon.hello` with `sessionToken`, by default the token file's, and answers its reply. */
async function sayHello(sessionToken?: string): Promise<unknown> {
  const client = await connect(socketPath);
  try {
    client.send({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "daemon.hello",
      params: {
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        sessionToken: sessionToken ?? (await readSessionToken()),
      },
    });
    const [reply] = await client.replies(1);
    return reply;
  } finally {
    await client.close();
  }
}

const COMPATIBLE_REPLY = {
  jsonrpc: JSONRPC_VERSION,
  id: 1,
  result: { compatible: true, protocolVersion: CURRENT_PROTOCOL_VERSION },
};

function readLocalMachine(): { readonly node_id: string; readonly name: string } {
  const database = new Database(path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME, "daemon.db"), {
    readonly: true,
  });
  try {
    return database.prepare("SELECT node_id, name FROM local_machine").get() as {
      node_id: string;
      name: string;
    };
  } finally {
    database.close();
  }
}

describe("the daemon started from its command", () => {
  it(
    "answers daemon.hello on its socket and keeps serving a client that drops and reconnects",
    async () => {
      const daemon = await startDaemon();
      expect(await sayHello()).toStrictEqual(COMPATIBLE_REPLY);

      const dropped = await connect(socketPath);
      dropped.socket.destroy();
      expect(await sayHello()).toStrictEqual(COMPATIBLE_REPLY);
      expect(daemon.child.exitCode).toBeNull();
    },
    READY_TIMEOUT_MS * 2,
  );

  it(
    "comes back after a crash with the same machine id and a new token, and stops on SIGTERM",
    async () => {
      const crashed = await startDaemon();
      const machineAtFirstStart = readLocalMachine();
      const tokenAtFirstStart = await readSessionToken();
      // Readable and writable by the person alone.
      expect((await lstat(tokenPath)).mode & 0o777).toBe(0o600);
      crashed.child.kill("SIGKILL");
      await crashed.exited;
      expect((await lstat(socketPath)).isSocket()).toBe(true);

      const restarted = await startDaemon();
      expect(await sayHello(tokenAtFirstStart)).toMatchObject({
        id: 1,
        error: { code: JsonRpcErrorCode.InvalidRequest, data: { type: "auth.token_invalid" } },
      });
      expect(await sayHello()).toStrictEqual(COMPATIBLE_REPLY);
      expect(readLocalMachine()).toStrictEqual(machineAtFirstStart);

      restarted.child.kill("SIGTERM");
      expect(await restarted.exited).toStrictEqual({ code: 0, signal: null });
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
    READY_TIMEOUT_MS * 3,
  );

  it(
    "finishes its stop when a second SIGTERM arrives during the drain",
    async () => {
      // The settings file is a named pipe, so a settings write waits on it until the test closes
      // its end, and the stop drains meanwhile.
      const settingsPath = path.join(homeDirectory, ...MACHINE_SETTINGS_FILE_PATH_SEGMENTS);
      await mkdir(path.dirname(settingsPath), { recursive: true });
      execFileSync("mkfifo", [settingsPath]);
      const daemon = await startDaemon();
      const client = await connect(socketPath);
      const linkClosed = new Promise<void>((resolve) => {
        client.socket.once("close", () => {
          resolve();
        });
      });
      client.send({
        jsonrpc: JSONRPC_VERSION,
        id: 1,
        method: "daemon.hello",
        params: {
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          sessionToken: await readSessionToken(),
        },
      });
      await client.replies(1);
      client.send({
        jsonrpc: JSONRPC_VERSION,
        id: 2,
        method: "daemon.machineSettingsUpdate",
        params: { change: { screenReaderMode: true } },
        protocolVersion: CURRENT_PROTOCOL_VERSION,
      });
      // The write is under way once its read has opened the pipe.
      const pipe = await vi.waitFor(() =>
        open(settingsPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK),
      );

      daemon.child.kill("SIGTERM");
      // The stop closes the socket before it drains.
      await linkClosed;
      daemon.child.kill("SIGTERM");
      await pipe.close();

      expect(await daemon.exited).toStrictEqual({ code: 0, signal: null });
    },
    READY_TIMEOUT_MS * 2,
  );

  it(
    "writes its service log to its data folder's log file as well as to standard error",
    async () => {
      const daemon = await startDaemon();
      daemon.child.kill("SIGTERM");
      expect(await daemon.exited).toStrictEqual({ code: 0, signal: null });

      const logFolder = path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME, "logs");
      const logFiles = await readdir(logFolder);
      expect(logFiles).toStrictEqual([
        expect.stringMatching(/^service-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.log$/),
      ]);
      const logFile = path.join(logFolder, logFiles[0]!);
      // Readable by the person alone.
      expect((await lstat(logFolder)).mode & 0o777).toBe(0o700);
      expect((await lstat(logFile)).mode & 0o777).toBe(0o600);
      const logged = await readFile(logFile, "utf8");
      for (const line of [DAEMON_READY_LINE, "The terminals drained at the stop"]) {
        expect(logged).toContain(line);
        expect(daemon.standardError()).toContain(line);
      }
    },
    READY_TIMEOUT_MS * 2,
  );

  it(
    "starts with its log on standard error alone when its log folder cannot be opened",
    async () => {
      // A file where the log folder belongs.
      const dataFolder = path.join(homeDirectory, DAEMON_DATA_FOLDER_NAME);
      await mkdir(dataFolder, { mode: 0o700 });
      await writeFile(path.join(dataFolder, "logs"), "");

      const daemon = await startDaemon();
      expect(await sayHello()).toStrictEqual(COMPATIBLE_REPLY);
      const reasons = daemon.standardError().match(/The service log file .* could not be opened/g);
      expect(reasons).toHaveLength(1);
    },
    READY_TIMEOUT_MS * 2,
  );
});
