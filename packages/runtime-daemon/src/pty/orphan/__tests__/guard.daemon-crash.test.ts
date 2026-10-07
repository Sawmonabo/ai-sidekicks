// A daemon killed outright leaves a shell that ignores the hangup running, reparented to the
// system; the next start's sweep finds it in the registry and kills it. Real processes, macOS.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { createProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { openOrphanGuard } from "../guard.js";
import { openOrphanOperatingSystem } from "../operating-system.js";
import { ORPHAN_REGISTRY_FILE_NAME } from "../registry.js";

const PACKAGE_FOLDER = new URL("../../../../", import.meta.url);
const SOURCE_LOADER = new URL("tests/helpers/typescript-source-loader.mjs", PACKAGE_FOLDER).href;
const moduleUrl = (relativePath: string): string => new URL(relativePath, import.meta.url).href;

const runProgram = promisify(execFile);
const readProcessIdentity = createProcessIdentityReader({
  platform: process.platform,
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  runProgram: (file, args, environment) => runProgram(file, [...args], { env: environment }),
});

// The daemon's part: a guard over the data folder and a real host that starts one shell, which
// ignores the hangup its terminal sends when the daemon dies, as a program run with `nohup` does.
const DAEMON_SCRIPT = `
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";
import { NodePtyHost } from ${JSON.stringify(moduleUrl("../../host/node-pty.ts"))};
import { openOrphanGuard } from ${JSON.stringify(moduleUrl("../guard.ts"))};
import { openOrphanOperatingSystem } from ${JSON.stringify(moduleUrl("../operating-system.ts"))};

const runProgram = promisify(execFile);
const readProcessIdentity = createProcessIdentityReader({
  platform: process.platform,
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  runProgram: (file, args, environment) => runProgram(file, [...args], { env: environment }),
});
const daemon = await readProcessIdentity(process.pid);
const { guard } = await openOrphanGuard({
  dataFolder: process.env.DATA_FOLDER,
  bootId: daemon.bootId,
  readProcessIdentity,
  operatingSystem: await openOrphanOperatingSystem(process.platform, (error) => {
    throw error;
  }),
  writeServiceLog: (line) => process.stderr.write(line + "\\n"),
});
await new NodePtyHost(guard).spawn({
  kind: "spawn_request",
  command: "/bin/sh",
  args: ["-c", "trap '' HUP; while :; do sleep 1; done"],
  env: [["PATH", "/usr/bin:/bin"]],
  cwd: process.env.DATA_FOLDER,
  rows: 24,
  cols: 80,
});
process.stdout.write("ready\\n");
setInterval(() => {}, 60_000);
`;

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
        env: { ...process.env, DATA_FOLDER: dataFolder },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let daemonOutput = "";
    daemon.stdout.on("data", (chunk: Buffer) => (daemonOutput += chunk.toString()));
    daemon.stderr.on("data", (chunk: Buffer) => (daemonOutput += chunk.toString()));
    let shellProcessId: number | undefined;
    try {
      await vi.waitFor(
        () => {
          expect(daemonOutput).toContain("ready");
        },
        { timeout: 20_000, interval: 50 },
      );
      const recorded = JSON.parse(
        await readFile(path.join(dataFolder, ORPHAN_REGISTRY_FILE_NAME), "utf8"),
      ) as { entries: Array<{ child?: { processId: number } }> };
      shellProcessId = recorded.entries[0]?.child?.processId;
      expect(shellProcessId).toBeTypeOf("number");
      const shell = shellProcessId ?? 0;

      const daemonExit = new Promise((resolve) => daemon.once("exit", resolve));
      daemon.kill("SIGKILL");
      await daemonExit;
      // Past the hangup the terminal sent when the daemon's end closed it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isRunning(shell)).toBe(true);

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

      expect(sweep).toEqual({ killed: 1, discarded: 0, unreadableCause: undefined });
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
});
