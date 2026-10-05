// A background service of the test's own, for a launch that plays no scenario.
//
// Such a launch runs main's supervisor, which connects to the service on this account's run
// folder and starts one detached when none answers. A detached service outlives the test and,
// on the person's real home and run folder, would be their own service. So every such launch
// gets a home and a run folder under one short temporary directory, and a service started there
// first through the one spawn chokepoint, which kills it when the test settles. The app finds it
// running and starts nothing. The run folder stays short because a socket path is bounded (104
// bytes on macOS).

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DAEMON_READY_LINE } from "@ai-sidekicks/contracts/daemon/lifecycle";

import { spawnManagedElectronChild } from "./electron/child/child.js";
import { PACKAGE_ROOT } from "./fixture/bundle.js";
import { SPAWNED_TREE_HOST_QUERY_CEILING_MS } from "./process-tree/budget.js";

/** The service's built entry, the program a development build of the app starts. */
const SERVICE_ENTRY_PATH = path.join(PACKAGE_ROOT, "../../packages/runtime-daemon/dist/main.js");

/**
 * How long a spawn harness waits for its service to answer, in milliseconds. Measured at about
 * 0.2 s on an unloaded macOS M1 Pro; the hosted runners boot Electron up to 25 times slower than
 * that machine, so the ceiling is 10 s.
 */
export const ISOLATED_SERVICE_READY_TIMEOUT_MS = 10_000;

/**
 * What a service start can spend before its launch begins, for an enclosing test budget: the
 * spawn's blocking host queries, which no ready wait contains, then the ready wait.
 */
export const ISOLATED_SERVICE_START_CEILING_MS: number =
  SPAWNED_TREE_HOST_QUERY_CEILING_MS + ISOLATED_SERVICE_READY_TIMEOUT_MS;

/** The environment a launch runs under so its service is the isolated one. */
export interface IsolatedService {
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * Starts a service in a fresh home and run folder and resolves once it answers, within
 * `readyWithinMs`. Must run inside a test: the service is killed and its folders removed when the
 * test settles. Throws when the service is not built, exits, or is not ready in time.
 */
export async function startIsolatedService(readyWithinMs: number): Promise<IsolatedService> {
  if (!existsSync(SERVICE_ENTRY_PATH)) {
    throw new Error(
      `The background service is not built (${SERVICE_ENTRY_PATH}); run ` +
        "pnpm --filter @ai-sidekicks/runtime-daemon build",
    );
  }
  const root = mkdtempSync(path.join(tmpdir(), "aisk-"));
  const homeDirectory = path.join(root, "home");
  const runtimeDirectory = path.join(root, "run");
  mkdirSync(homeDirectory);
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  const environment = { HOME: homeDirectory, XDG_RUNTIME_DIR: runtimeDirectory };

  const managed = spawnManagedElectronChild({
    command: process.execPath,
    args: [SERVICE_ENTRY_PATH],
    cwd: root,
    env: { ...process.env, ...environment },
    releaseAfterTermination: () => {
      rmSync(root, { recursive: true, force: true });
    },
  });

  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`The isolated service was not ready within ${String(readyWithinMs)} ms`));
    }, readyWithinMs);
    managed.child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(DAEMON_READY_LINE)) {
        clearTimeout(timer);
        resolve();
      }
    });
    managed.child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `The isolated service exited before it was ready (code ${String(code)}, signal ` +
            `${String(signal)}): ${output}`,
        ),
      );
    });
  });
  return { environment };
}
