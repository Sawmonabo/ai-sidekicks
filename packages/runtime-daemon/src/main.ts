#!/usr/bin/env node
// The daemon's entry point, `sidekicks-daemon`: starts the daemon on this machine's own socket and
// exits once it has stopped, whether a client asked for the stop over the socket or a SIGTERM or
// SIGINT did, which is how the desktop app's main process, the command line and the operating
// system's service manager end it.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import { promisify } from "node:util";

import { DAEMON_READY_LINE } from "@ai-sidekicks/contracts/daemon/lifecycle";
import { CURRENT_PROTOCOL_VERSION } from "@ai-sidekicks/contracts/jsonrpc/negotiation";
import { resolveDaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import { createProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { DaemonProcess, resolveDataFolder } from "./daemon/daemon-process.js";
import {
  captureLoginShellEnvironment,
  LOGIN_SHELL_DEADLINE_MS,
  readDarwinUserTempDirectory,
} from "./daemon/login-shell-environment.js";
import { nodeMachineNameSources, readMachineName } from "./daemon/machine/name.js";
import { readProcessTreeUsage } from "./daemon/process-tree-usage.js";
import { openServiceLog } from "./daemon/service-log.js";
import { selectPtyHost } from "./pty/host/selector.js";

// The service's version is its package's; the manifest sits one folder above this file, in the
// source tree and in the build alike.
function readServiceVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("The daemon's package.json names no version");
}

// First, so every service-log line from here on is kept in the file too.
const homeDirectory = os.homedir();
const writeServiceLog = openServiceLog({
  dataFolder: resolveDataFolder(homeDirectory),
  startedAt: new Date(),
  standardError: process.stderr,
});

let isStarted = false;
// Node would print an error nothing handled to standard error alone, which whoever started the
// daemon may not keep, so it goes to the service log, stack and all. A failed start ends here too.
// A rejection can carry any value, whatever Node's types say.
process.on("uncaughtException", (error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeServiceLog(`${isStarted ? "The daemon failed" : "The daemon could not start"}: ${detail}`);
  process.exit(1);
});

// Installed before the start, so a signal sent at any moment stops the daemon cleanly: during the
// start it ends the login shell's capture and the daemon stops as soon as it has started. The
// handlers stay installed for the whole stop: with none, a second signal would end the daemon
// mid-drain.
const stopRequest = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopRequest.abort();
  });
}

// Read once: the reading of a running process never changes.
const runProgram = promisify(execFile);
const processIdentity = await createProcessIdentityReader({
  platform: process.platform,
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  runProgram: (file, args, environment) => runProgram(file, [...args], { env: environment }),
})(process.pid);
if (processIdentity === undefined) {
  throw new Error("The system finds no process with the daemon's own id");
}
const account = os.userInfo();
const daemon = await DaemonProcess.start({
  homeDirectory,
  runFolder: resolveDaemonRunFolder({
    platform: process.platform,
    runtimeDirectory: process.env["XDG_RUNTIME_DIR"],
    temporaryDirectory: os.tmpdir(),
    userId: account.uid,
  }),
  ptyHost: selectPtyHost(),
  readMachineName: () => readMachineName(nodeMachineNameSources()),
  captureProviderBaseEnvironment: () =>
    captureLoginShellEnvironment({
      platform: process.platform,
      shell: account.shell,
      homeDirectory: account.homedir,
      userName: account.username,
      readUserTempDirectory: readDarwinUserTempDirectory,
      deadlineMs: LOGIN_SHELL_DEADLINE_MS,
      serviceEnvironment: process.env,
      writeServiceLog,
      signal: stopRequest.signal,
    }),
  serviceVersion: readServiceVersion(),
  processIdentity,
  readProcessTreeUsage: () => readProcessTreeUsage(process.pid),
  now: () => new Date(),
  writeServiceLog,
});

isStarted = true;
if (stopRequest.signal.aborted) {
  void daemon.stop();
} else {
  stopRequest.signal.addEventListener("abort", () => {
    void daemon.stop();
  });
  writeServiceLog(
    `${DAEMON_READY_LINE} (process ${String(process.pid)}, protocol ${CURRENT_PROTOCOL_VERSION}).`,
  );
}

void daemon.whenStopped().then((outcome) => {
  if (!outcome.isClean) {
    const { failure } = outcome;
    writeServiceLog(
      `The daemon's stop failed: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
  process.exit(outcome.isClean ? 0 : 1);
});
