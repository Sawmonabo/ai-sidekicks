// A daemon killed outright leaves no terminal child running past the next start's sweep, real
// processes on macOS: a recorded shell that ignores the hangup is found in the registry, and a
// child caught inside its spawn, before its process was recorded, is found by its nonce.

import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { createProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { findDarwinProcessesCarryingNonces } from "../darwin/nonce-search.js";
import { loadDarwinSystemLibrary } from "../darwin/system-library.js";
import { openOrphanGuard } from "../guard.js";
import { openOrphanOperatingSystem } from "../operating-system.js";
import { ORPHAN_REGISTRY_FILE_NAME } from "../registry.js";
import type { OrphanSweepResult } from "../sweep.js";

const PACKAGE_FOLDER = new URL("../../../../", import.meta.url);
const SOURCE_LOADER = new URL("tests/helpers/typescript-source-loader.mjs", PACKAGE_FOLDER).href;
const moduleUrl = (relativePath: string): string => new URL(relativePath, import.meta.url).href;
// Where a daemon killed inside its spawn writes the child's process id and nonce first.
const SPAWNED_FILE_NAME = "spawned.json";
// Spawns killed inside the window: five, so the kill lands at several points of the spawn, then on
// until one left a process the sweep killed. Each run checks that nothing of its spawn survives,
// which also holds when the shell dies on the hangup by itself, so only the count of killed
// processes proves the sweep. A node-pty helper outlived 9 of 20 such spawns when measured, so the
// last bound is a backstop.
const MIN_WINDOW_RUNS = 5;
const MAX_WINDOW_RUNS = 30;

const runProgram = promisify(execFile);
const readProcessIdentity = createProcessIdentityReader({
  platform: process.platform,
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  runProgram: (file, args, environment) => runProgram(file, [...args], { env: environment }),
});

// The daemon's part: a guard over the data folder and a real host that starts one shell. With
// `CRASH_IN_SPAWN` set, the daemon kills itself the moment `node-pty` has started the child,
// before its process is recorded; otherwise the shell ignores the hangup the terminal sends when
// the daemon dies, as a program run with `nohup` does.
const DAEMON_SCRIPT = `
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import nodePty from "node-pty";
import { createProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";
import { NodePtyHost } from ${JSON.stringify(moduleUrl("../../host/node-pty.ts"))};
import { openOrphanGuard } from ${JSON.stringify(moduleUrl("../guard.ts"))};
import { openOrphanOperatingSystem } from ${JSON.stringify(moduleUrl("../operating-system.ts"))};
import { SPAWN_NONCE_ENVIRONMENT_NAME } from ${JSON.stringify(moduleUrl("../registry.ts"))};

const dataFolder = process.env.DATA_FOLDER;
const isCrashingInSpawn = process.env.CRASH_IN_SPAWN === "1";
const runProgram = promisify(execFile);
const readProcessIdentity = createProcessIdentityReader({
  platform: process.platform,
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  runProgram: (file, args, environment) => runProgram(file, [...args], { env: environment }),
});
const daemon = await readProcessIdentity(process.pid);
const { guard } = await openOrphanGuard({
  dataFolder,
  bootId: daemon.bootId,
  readProcessIdentity,
  operatingSystem: await openOrphanOperatingSystem(process.platform, (error) => {
    throw error;
  }),
  writeServiceLog: (line) => process.stderr.write(line + "\\n"),
});
const ptySpawn = (command, args, options) => {
  const child = nodePty.spawn(command, args, options);
  if (isCrashingInSpawn) {
    writeFileSync(
      path.join(dataFolder, ${JSON.stringify(SPAWNED_FILE_NAME)}),
      JSON.stringify({ processId: child.pid, nonce: options.env[SPAWN_NONCE_ENVIRONMENT_NAME] }),
    );
    process.kill(process.pid, "SIGKILL");
  }
  return child;
};
await new NodePtyHost(guard, { ptySpawn }).spawn({
  kind: "spawn_request",
  ...(isCrashingInSpawn
    ? { command: "/bin/zsh", args: ["-l"] }
    : { command: "/bin/sh", args: ["-c", "trap '' HUP; while :; do sleep 1; done"] }),
  env: [["PATH", "/usr/bin:/bin"], ["HOME", dataFolder]],
  cwd: dataFolder,
  rows: 24,
  cols: 80,
});
process.stdout.write("ready\\n");
setInterval(() => {}, 60_000);
`;

interface StartedDaemon {
  readonly daemon: ChildProcess;
  readonly exit: Promise<unknown>;
  output(): string;
}

function startDaemon(dataFolder: string, isCrashingInSpawn: boolean): StartedDaemon {
  const daemon = spawn(
    process.execPath,
    [
      "--conditions=@ai-sidekicks/source",
      "--import",
      `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(SOURCE_LOADER)})`,
      "--input-type=module",
      "--eval",
      DAEMON_SCRIPT,
    ],
    {
      cwd: PACKAGE_FOLDER,
      env: {
        ...process.env,
        DATA_FOLDER: dataFolder,
        CRASH_IN_SPAWN: isCrashingInSpawn ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  daemon.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  daemon.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exit = new Promise((resolve) => daemon.once("exit", resolve));
  return { daemon, exit, output: () => output };
}

// The next start: a fresh guard over the folder, whose opening sweeps it.
async function sweepFolder(dataFolder: string): Promise<OrphanSweepResult> {
  const self = await readProcessIdentity(process.pid);
  const { guard, sweep } = await openOrphanGuard({
    dataFolder,
    bootId: self?.bootId ?? "",
    readProcessIdentity,
    operatingSystem: await openOrphanOperatingSystem(process.platform, (error) => {
      throw error;
    }),
    writeServiceLog: () => {},
  });
  await guard.close();
  return sweep;
}

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

describe.skipIf(process.platform !== "darwin")("the orphan sweep after a daemon crash", () => {
  it("kills the shell a killed daemon left running", async () => {
    const dataFolder = await mkdtemp(path.join(tmpdir(), "orphan-crash-"));
    const { daemon, exit, output } = startDaemon(dataFolder, false);
    let shellProcessId: number | undefined;
    try {
      await vi.waitFor(
        () => {
          expect(output()).toContain("ready");
        },
        { timeout: 20_000, interval: 50 },
      );
      const recorded = JSON.parse(
        await readFile(path.join(dataFolder, ORPHAN_REGISTRY_FILE_NAME), "utf8"),
      ) as { entries: Array<{ child?: { processId: number } }> };
      shellProcessId = recorded.entries[0]?.child?.processId;
      expect(shellProcessId).toBeTypeOf("number");
      const shell = shellProcessId ?? 0;

      daemon.kill("SIGKILL");
      await exit;
      // Past the hangup the terminal sent when the daemon's end closed it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isRunning(shell)).toBe(true);

      expect(await sweepFolder(dataFolder)).toEqual({
        killed: 1,
        discarded: 0,
        unreadableCause: undefined,
      });
      await vi.waitFor(
        () => {
          expect(isRunning(shell)).toBe(false);
        },
        { timeout: 5_000, interval: 50 },
      );
    } finally {
      daemon.kill("SIGKILL");
      if (shellProcessId !== undefined && isRunning(shellProcessId)) {
        process.kill(shellProcessId, "SIGKILL");
      }
      await rm(dataFolder, { recursive: true, force: true });
    }
  }, 40_000);

  it("kills what a daemon killed inside a spawn left, found by its nonce", async () => {
    const library = await loadDarwinSystemLibrary();
    const userId = process.getuid?.() ?? -1;
    let killedCount = 0;
    for (
      let run = 0;
      run < MAX_WINDOW_RUNS && (run < MIN_WINDOW_RUNS || killedCount === 0);
      run += 1
    ) {
      const dataFolder = await mkdtemp(path.join(tmpdir(), "orphan-window-"));
      const { daemon, exit, output } = startDaemon(dataFolder, true);
      let spawned: { processId: number; nonce: string } | undefined;
      try {
        await exit;
        expect(output()).not.toContain("ready");
        spawned = JSON.parse(await readFile(path.join(dataFolder, SPAWNED_FILE_NAME), "utf8")) as {
          processId: number;
          nonce: string;
        };
        const { processId, nonce } = spawned;

        // Only the intent is recorded; whatever of the spawn still runs is found by its nonce.
        const sweep = await sweepFolder(dataFolder);
        killedCount += sweep.killed;
        await vi.waitFor(
          () => {
            expect(isRunning(processId)).toBe(false);
            expect(findDarwinProcessesCarryingNonces(library, userId, new Set([nonce]))).toEqual(
              new Map(),
            );
          },
          { timeout: 5_000, interval: 50 },
        );
      } finally {
        daemon.kill("SIGKILL");
        if (spawned !== undefined && isRunning(spawned.processId)) {
          process.kill(spawned.processId, "SIGKILL");
        }
        await rm(dataFolder, { recursive: true, force: true });
      }
    }
    expect(killedCount).toBeGreaterThan(0);
  }, 120_000);
});
