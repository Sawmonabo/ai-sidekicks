#!/usr/bin/env node
// The daemon's entry point, `sidekicks-daemon`: starts the daemon on this machine's own socket and
// exits once it has stopped, whether a client asked for the stop over the socket or a SIGTERM or
// SIGINT did, which is how the desktop app's main process, the command line and the operating
// system's service manager end it.

import * as os from "node:os";

import { DaemonProcess, resolveDataFolder } from "./daemon/process.js";
import { LOGIN_SHELL_DEADLINE_MS } from "./daemon/login-shell-environment.js";
import { createNodeMachineNameSources } from "./daemon/machine/name.js";
import { readProcessTreeUsage } from "./daemon/process-tree-usage.js";
import { DaemonStartStoppedError } from "./daemon/start-stopped-error.js";
import { openServiceLog } from "./daemon/service-log.js";
import { readServiceVersion } from "./daemon/service-version.js";
import { readVolumeFreeBytes } from "./daemon/volume-free-space.js";
import { NODE_SYSTEM_ACCESS } from "./node-system-access.js";
import { selectDaemonOperatingSystem } from "./operating-system/selection.js";
import { describeRejection } from "./rejection.js";
import { selectPtyHost } from "./pty/host/selector.js";
import { openOrphanGuard } from "./pty/orphan/guard.js";

// First, so every service-log line from here on is kept in the file too.
const homeDirectory = os.homedir();
const serviceLog = openServiceLog({
  dataFolder: resolveDataFolder(homeDirectory),
  now: () => new Date(),
  standardError: process.stderr,
});
const writeServiceLog = serviceLog.write;

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

// Picked once; every part of the daemon takes what it needs of the system from here.
const operatingSystem = selectDaemonOperatingSystem(process.platform, process.env);

// One reader for the daemon's own process and its terminal children, so the boot is read once.
const readProcessIdentity = operatingSystem.createProcessIdentityReader(NODE_SYSTEM_ACCESS);
// Read once: the reading of a running process never changes.
const processIdentity = await readProcessIdentity(process.pid);
if (processIdentity === undefined) {
  throw new Error("The system finds no process with the daemon's own id");
}
const account = os.userInfo();
// Opened before the start, so the socket never takes a connection it cannot name the caller of.
const callerProcessReader = await operatingSystem.openCallerProcessReader();
const daemon = await DaemonProcess.start({
  stopSignal: stopRequest.signal,
  homeDirectory,
  operatingSystem,
  callerProcessReader,
  runFolder: operatingSystem.resolveRunFolder({
    platform: operatingSystem.platform,
    runtimeDirectory: process.env["XDG_RUNTIME_DIR"],
    homeDirectory,
  }),
  openOrphanGuard: async (dataFolder) =>
    openOrphanGuard({
      dataFolder,
      bootId: processIdentity.bootId,
      readProcessIdentity,
      operatingSystem: await operatingSystem.openOrphanOperatingSystem((error) => {
        writeServiceLog(`The watch on terminal children's exits stopped: ${error.message}`);
      }),
      diskFlush: operatingSystem.diskFlush,
      writeServiceLog,
    }),
  createPtyHost: (orphanGuard) => selectPtyHost(orphanGuard, operatingSystem.terminal),
  readMachineName: () => operatingSystem.readMachineName(createNodeMachineNameSources()),
  captureProviderBaseEnvironment: (startAbort) =>
    operatingSystem.captureProviderBaseEnvironment({
      shell: account.shell,
      homeDirectory: account.homedir,
      userName: account.username,
      deadlineMs: LOGIN_SHELL_DEADLINE_MS,
      serviceEnvironment: process.env,
      writeServiceLog,
      readTextFile: NODE_SYSTEM_ACCESS.readTextFile,
      signal: AbortSignal.any([stopRequest.signal, startAbort]),
    }),
  commandShell: account.shell,
  // Read from the account's record at each open, so a shell changed with `chsh` opens next.
  readLoginShell: () => os.userInfo().shell,
  serviceVersion: readServiceVersion(),
  processIdentity,
  readProcessTreeUsage: () => readProcessTreeUsage(process.pid),
  readVolumeFreeBytes,
  now: () => new Date(),
  writeServiceLog,
  serviceLogFiles: serviceLog,
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
