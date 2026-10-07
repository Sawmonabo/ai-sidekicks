// Tier: bundle. A release build serves no remote-debugging connection: main removes Chromium's
// `--remote-debugging-port` and `--remote-debugging-pipe` switches before Electron reads them.
//
// The release `out/` is launched with the development Electron binary on a private profile, with
// the port switch and a `--fixture` launch. A release build refuses `--fixture` inside its ready
// continuation, after Electron has decided whether to start the server and before any window
// opens or the background service is sought, so the exit is the point the answer is settled.
// Chromium writes `DevToolsActivePort` into the profile whenever it serves, and a port it serves
// takes a connection, so both are read: the record after the exit, the port throughout the run.

import { existsSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isFixtureOnlyModule } from "../../electron.vite.config.js";
import { MAIN_DIAGNOSTIC_LOG_FILE_NAME } from "#main/services/diagnostic-log.js";
import { PROFILE_LOGS_FOLDER_NAME } from "#main/services/install-profile.js";
import { spawnChildCleanedUpAtSettleTime } from "../helpers/electron/child/cleanup.js";
import { ELECTRON_BIN, MAIN_ENTRY_PATH, PACKAGE_ROOT } from "../helpers/fixture/bundle.js";
import { createLaunchProfile } from "../helpers/launch/profile.js";
import { readSourceMapsOrFailLoudly } from "./built-renderer-tree.js";

/** How long the release launch has to reach its refusal of `--fixture` and exit. */
const RELEASE_LAUNCH_EXIT_TIMEOUT_MS = 30_000;

/** How often the run's port is tried while the launch runs. */
const PORT_ATTEMPT_INTERVAL_MS = 25;

/** The file Chromium writes into the profile when it serves a remote-debugging connection. */
const SERVED_PORT_RECORD_FILE_NAME = "DevToolsActivePort";

/** A main-bundle module only a smoke build ships, which keeps the switch for its harness. */
const SMOKE_PROBE_FOLDER = "/src/main/probes/";

/** A port no process holds now, which the launch is asked to serve on. */
async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("the free-port probe has no TCP address"));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

/** Whether something on this machine accepts a connection to `port` on the loopback address. */
async function isPortServed(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

describe("release build — no remote-debugging connection", () => {
  it(
    "refuses --remote-debugging-port: nothing is served on the port and Chromium records none",
    async () => {
      // A fixtures or smoke build keeps the switch for its harness, so a run against one would
      // report that build, not the release.
      const mainModules = readSourceMapsOrFailLoudly("main").flatMap((map) => map.sources);
      expect(
        mainModules.filter(
          (source) => isFixtureOnlyModule(source) || source.includes(SMOKE_PROBE_FOLDER),
        ),
        "out/ holds a fixtures or smoke build; run pnpm --filter @ai-sidekicks/desktop build",
      ).toEqual([]);

      const port = await findFreePort();
      const profile = createLaunchProfile("sidekicks-remote-debugging-test-");
      const managed = spawnChildCleanedUpAtSettleTime(
        {
          command: ELECTRON_BIN,
          args: [
            `--user-data-dir=${profile.directory}`,
            `--remote-debugging-port=${String(port)}`,
            MAIN_ENTRY_PATH,
            "--fixture",
            "first-run",
          ],
          cwd: PACKAGE_ROOT,
          env: process.env,
        },
        profile.remove,
      );
      let output = "";
      managed.child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      managed.child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      const exit = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `the release launch did not exit within ${String(RELEASE_LAUNCH_EXIT_TIMEOUT_MS)} ms:\n${output}`,
            ),
          );
        }, RELEASE_LAUNCH_EXIT_TIMEOUT_MS);
        managed.child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      let hasExited = false;
      let isServed = false;
      void exit.finally(() => {
        hasExited = true;
      });
      while (!hasExited && !isServed) {
        isServed = await isPortServed(port);
        await new Promise((resolve) => setTimeout(resolve, PORT_ATTEMPT_INTERVAL_MS));
      }
      const exitCode = await exit;

      const mainLog = readFileSync(
        join(profile.directory, PROFILE_LOGS_FOLDER_NAME, MAIN_DIAGNOSTIC_LOG_FILE_NAME),
        "utf8",
      );
      // The launch got as far as the ready continuation, past Electron's decision.
      expect(exitCode, output).toBe(1);
      expect(mainLog).toContain("--fixture needs a development or fixtures build");
      expect(isServed, `port ${String(port)} took a connection`).toBe(false);
      expect(existsSync(join(profile.directory, SERVED_PORT_RECORD_FILE_NAME))).toBe(false);
      expect(mainLog).toContain("--remote-debugging-port was refused");
    },
    RELEASE_LAUNCH_EXIT_TIMEOUT_MS * 2,
  );
});
