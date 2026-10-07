// Tier: bundle. A release build serves no remote-debugging connection: main removes Chromium's
// `--remote-debugging-port` and `--remote-debugging-pipe` switches before Electron reads them.
//
// The release `out/` is launched through the smoke tier's spawn harness with the port switch and a
// `--fixture` launch. A release build refuses `--fixture` inside its ready continuation, after
// Electron has decided whether to start the server and before any window opens, so the exit is
// the point the answer is settled. Chromium prints `DevTools listening` and writes
// `DevToolsActivePort` into the profile whenever it serves, and a port it serves takes a
// connection, so all three are read: the port throughout the run, the output and the record after.

import { existsSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isFixtureOnlyModule } from "../../electron.vite.config.js";
import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { MAIN_DIAGNOSTIC_LOG_FILE_NAME } from "#main/services/diagnostic-log.js";
import { PROFILE_LOGS_FOLDER_NAME } from "#main/services/install-profile.js";
import { BOOT_TEST_TIMEOUT_MS, spawnElectron } from "../helpers/smoke-probe/harness.js";
import { readSourceMapsOrFailLoudly, SMOKE_PROBE_FOLDER } from "./built-renderer-tree.js";

/** How often the launch's port is tried while it runs; a served port answers at once. */
const PORT_ATTEMPT_INTERVAL_MS = 25;

/** The file Chromium writes into the profile when it serves a remote-debugging connection. */
const SERVED_PORT_RECORD_FILE_NAME = "DevToolsActivePort";

/** The line Chromium prints when it serves a remote-debugging connection. */
const SERVED_PORT_ANNOUNCEMENT = "DevTools listening on";

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
      const nonReleaseModules = readSourceMapsOrFailLoudly("main")
        .flatMap((map) => map.sources)
        .filter((source) => isFixtureOnlyModule(source) || source.includes(SMOKE_PROBE_FOLDER));
      expect(
        nonReleaseModules,
        "out/ holds a fixtures or smoke build; run pnpm --filter @ai-sidekicks/desktop build",
      ).toEqual([]);

      const port = await findFreePort();
      let hasSettled = false;
      const launch = spawnElectron({
        chromiumSwitches: [`--remote-debugging-port=${String(port)}`],
        appArguments: ["--fixture", FIRST_RUN_SCENARIO.id],
      }).finally(() => {
        hasSettled = true;
      });
      let isServed = false;
      while (!hasSettled && !isServed) {
        isServed = await isPortServed(port);
        await new Promise((resolve) => setTimeout(resolve, PORT_ATTEMPT_INTERVAL_MS));
      }
      const result = await launch;

      expect(result.timedOut, result.combinedOutput).toBe(false);
      expect(result.profileDirectory, result.combinedOutput).toBeDefined();
      const profileDirectory = result.profileDirectory ?? "";
      const mainLog = readFileSync(
        join(profileDirectory, PROFILE_LOGS_FOLDER_NAME, MAIN_DIAGNOSTIC_LOG_FILE_NAME),
        "utf8",
      );
      // The launch got as far as the ready continuation, past Electron's decision.
      expect(result.exitCode, result.combinedOutput).toBe(1);
      expect(mainLog).toContain("--fixture needs a development or fixtures build");
      expect(isServed, `port ${String(port)} took a connection`).toBe(false);
      expect(result.combinedOutput).not.toContain(SERVED_PORT_ANNOUNCEMENT);
      expect(existsSync(join(profileDirectory, SERVED_PORT_RECORD_FILE_NAME))).toBe(false);
      expect(mainLog).toContain("--remote-debugging-port was refused");
    },
    BOOT_TEST_TIMEOUT_MS,
  );
});
