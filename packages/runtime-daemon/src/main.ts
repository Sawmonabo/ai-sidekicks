#!/usr/bin/env node
// The daemon's entry point, `sidekicks-daemon`: starts the daemon on this machine's own socket and
// exits once it has stopped, whether a client asked for the stop over the socket or a SIGTERM or
// SIGINT did, which is how the desktop app's main process, the command line and the operating
// system's service manager end it.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import { promisify } from "node:util";

import { resolveDaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";
import { createProcessIdentityReader } from "@ai-sidekicks/contracts/process-identity";

import { DaemonProcess, resolveDataFolder } from "./daemon/process.js";
import {
  captureLoginShellEnvironment,
  LOGIN_SHELL_DEADLINE_MS,
  readDarwinUserTempDirectory,
} from "./daemon/login-shell-environment.js";
import { createNodeMachineNameSources, readMachineName } from "./daemon/machine/name.js";
import { readProcessTreeUsage } from "./daemon/process-tree-usage.js";
import { DaemonStartStoppedError } from "./daemon/start-stopped-error.js";
import { openServiceLog } from "./daemon/service-log.js";
import { readServiceVersion } from "./daemon/service-version.js";
import { readWindowsDriveMounts } from "./daemon/windows-drive-mounts.js";
import { describeRejection } from "./rejection.js";
import { selectPtyHost } from "./pty/host/selector.js";
import { openOrphanGuard } from "./pty/orphan/guard.js";
import { openOrphanOperatingSystem } from "./pty/orphan/operating-system.js";
import { chooseDatabaseFileOperatingSystem } from "./recovery/database-file/operating-system.js";
import { selectProviderOperatingSystem } from "./provider/operating-system/selection.js";

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
// Node's default rejection mode throws an unhandled rejection, a rejected top-level await
// included, as an uncaught exception, so this one handler covers both; an `unhandledRejection`
// handler would turn that mode off. A rejection can carry any value, whatever Node's types say.
process.on("uncaughtException", (error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeServiceLog(`${isStarted ? "The daemon failed" : "The daemon could not start"}: ${detail}`);
  process.exit(1);
});

// Installed before the start, so a signal sent at any moment stops the daemon cleanly: during the
// start it ends the login shell's capture, its reason saying why in the service log, and a repair
// of the database file under way, which ends the start; once the daemon listens it stops it. The
// handlers stay installed for the whole stop: with none, a second signal would end the daemon
// mid-drain.
const stopRequest = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopRequest.abort("a stop came during the start");
  });
}

// One reader for the daemon's own process and its terminal children, so the boot is read once.
const runProgram = promisify(execFile);
const readProcessIdentity = createProcessIdentityReader({
  platform: process.platform,
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  runProgram: (file, args, environment) => runProgram(file, [...args], { env: environment }),
});
// Read once: the reading of a running process never changes.
const processIdentity = await readProcessIdentity(process.pid);
if (processIdentity === undefined) {
  throw new Error("The system finds no process with the daemon's own id");
}
const account = os.userInfo();
const daemon = await DaemonProcess.start({
  stopSignal: stopRequest.signal,
  homeDirectory,
  runFolder: resolveDaemonRunFolder({
    platform: process.platform,
    runtimeDirectory: process.env["XDG_RUNTIME_DIR"],
    temporaryDirectory: os.tmpdir(),
    userId: account.uid,
  }),
  openOrphanGuard: async (dataFolder) =>
    openOrphanGuard({
      dataFolder,
      bootId: processIdentity.bootId,
      readProcessIdentity,
      operatingSystem: await openOrphanOperatingSystem(process.platform, (error) => {
        writeServiceLog(`The watch on terminal children's exits stopped: ${error.message}`);
      }),
      writeServiceLog,
    }),
  createPtyHost: selectPtyHost,
  databaseFileOperatingSystem: chooseDatabaseFileOperatingSystem(process.platform),
  readMachineName: () => readMachineName(createNodeMachineNameSources()),
  captureProviderBaseEnvironment: (startAbort) =>
    captureLoginShellEnvironment({
      platform: process.platform,
      shell: account.shell,
      homeDirectory: account.homedir,
      userName: account.username,
      readUserTempDirectory: readDarwinUserTempDirectory,
      readWindowsDriveMounts,
      deadlineMs: LOGIN_SHELL_DEADLINE_MS,
      serviceEnvironment: process.env,
      writeServiceLog,
      signal: AbortSignal.any([stopRequest.signal, startAbort]),
    }),
  commandShell: account.shell,
  providerOperatingSystem: selectProviderOperatingSystem(process.platform),
  serviceVersion: readServiceVersion(),
  processIdentity,
  readProcessTreeUsage: () => readProcessTreeUsage(process.pid),
  now: () => new Date(),
  writeServiceLog,
}).catch((error: unknown) => {
  // A start a stop ended before the daemon listened has let go of what it took, so it exits as a
  // clean stop does; anything that failed beside it is a failed start.
  if (error instanceof DaemonStartStoppedError && error.cause === undefined) {
    writeServiceLog(`The daemon stopped during its start: ${error.message}.`);
    process.exit(0);
  }
  throw error;
});

isStarted = true;

void daemon.whenStopped().then((outcome) => {
  if (!outcome.isClean) {
    const { failure } = outcome;
    writeServiceLog(`The daemon's stop failed: ${describeRejection(failure)}`);
  }
  // A stop for a damaged file exits as a failure, so whoever started the daemon starts it again
  // and the start repairs the file.
  process.exit(outcome.isClean && !outcome.isFileDamaged ? 0 : 1);
});
