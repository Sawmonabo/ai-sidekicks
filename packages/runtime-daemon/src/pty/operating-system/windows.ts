// Windows: the command interpreter `ComSpec` names is the default shell, its shells have no login
// form, a bash reads a posix-mode start's `ENV`, and a terminal child starts as it is, with no
// `/bin/sh` to run a parent check. `node-pty`'s kill signals one process and walks neither console
// control nor the process tree there (microsoft/node-pty#167, #437), so a client's signal is
// translated: SIGINT sends CTRL_C_EVENT; SIGTERM and SIGHUP send CTRL_BREAK_EVENT, then end the
// tree outright after 2 s; SIGKILL ends it outright at once. Every ending ends the child and every
// process it started, since Windows has no signal a program answers, and a terminal host that
// stopped answering is ended with its tree, since Node's kill ends one process and would leave the
// host's terminal children running.

import { importKoffi } from "../../koffi.js";
import {
  defaultSpawnTaskkill,
  runTaskkillWithin,
  type TaskkillRunner,
} from "../../process-tree/windows.js";
import { startBashThroughEnv } from "./bash-env-start.js";
import type { TerminalOperatingSystem } from "./contract.js";
import { killTerminalHostAlone } from "./host-kill.js";

// Win32 console-control event codes, per `GenerateConsoleCtrlEvent`.
const CTRL_C_EVENT = 0;
const CTRL_BREAK_EVENT = 1;

/** A Win32 console-control event code: CTRL_C_EVENT or CTRL_BREAK_EVENT. */
export type ConsoleCtrlEvent = typeof CTRL_C_EVENT | typeof CTRL_BREAK_EVENT;

/** Sends a console-control event to the console process group `pid` leads. */
type ConsoleCtrlEventSender = (event: ConsoleCtrlEvent, pid: number) => void;

// How long a SIGTERM's or a SIGHUP's console event is given before the tree is ended outright.
const CONSOLE_EVENT_GRACE_MS = 2_000;

/** The Windows calls the terminal makes; the real ones unless a test hands in doubles. */
export interface WindowsTerminalProcesses {
  /** Sends a console-control event to the console group a process leads. */
  readonly generateConsoleCtrlEvent: ConsoleCtrlEventSender;
  /** Ends a process and every process it started, through `taskkill /T /F`. */
  readonly runTaskkill: TaskkillRunner;
}

/**
 * What the terminal takes from Windows, given `ComSpec` as the daemon's environment holds it and,
 * from a test, doubles of the Windows calls.
 */
export function windowsTerminalOperatingSystem(
  commandInterpreter: string | undefined,
  processes: Partial<WindowsTerminalProcesses> = {},
): TerminalOperatingSystem {
  const runTaskkill = processes.runTaskkill ?? defaultSpawnTaskkill;
  let loadedSender: ConsoleCtrlEventSender | undefined = processes.generateConsoleCtrlEvent;
  // Bound on the first signal and kept; a failed load is tried again at the next.
  const consoleEventSender = async (): Promise<ConsoleCtrlEventSender> => {
    loadedSender ??= await loadGenerateConsoleCtrlEvent();
    return loadedSender;
  };
  // A failed `taskkill` is logged, not thrown, so the exit is still reported; the log tells a
  // persistent failure (bad PATH, blocked taskkill.exe) from a healthy exit.
  const logRejectedTaskkill =
    (pid: number) =>
    (error: unknown): void => {
      console.warn(`taskkill rejected for pid=${String(pid)}; its exit is reported anyway.`, {
        cause: error,
      });
    };
  return {
    defaultShell: commandInterpreter ?? "cmd.exe",
    loginShellArgs: [],
    defaultXdgDataFolders: [],
    startBash: startBashThroughEnv,
    launchTerminalChild: (command, args) => ({ command, args: [...args] }),
    // The taskkill never rejects, and the child's exit, or its absence, says how it went.
    endTerminalChild: (child) => {
      void runTaskkill(child.pid);
    },
    deliverSignal: async ({ child, signal, escalateAfter, reportForcedEnd }) => {
      if (signal === "SIGINT") {
        (await consoleEventSender())(CTRL_C_EVENT, child.pid);
        return;
      }
      // The terminal host bounds how long the report waits on a stuck `taskkill`.
      const endOutright = (): void => {
        reportForcedEnd(
          runTaskkill(child.pid).then(() => undefined, logRejectedTaskkill(child.pid)),
        );
      };
      if (signal === "SIGKILL") {
        endOutright();
        return;
      }
      (await consoleEventSender())(CTRL_BREAK_EVENT, child.pid);
      escalateAfter(CONSOLE_EVENT_GRACE_MS, endOutright);
    },
    killChildGroup: null,
    killTerminalHost: (host) =>
      host.pid === undefined
        ? killTerminalHostAlone(host)
        : runTaskkillWithin(host.pid, runTaskkill, logRejectedTaskkill(host.pid)),
  };
}

// `node-pty` does not expose `GenerateConsoleCtrlEvent`, so it is bound from `kernel32.dll` through
// `koffi`. Throws with an install hint when `koffi` cannot be loaded.
async function loadGenerateConsoleCtrlEvent(): Promise<ConsoleCtrlEventSender> {
  const koffi = await importKoffi("Windows kill-translation");
  const kernel32 = koffi.load("kernel32.dll");
  const binding = kernel32.func(
    "int __stdcall GenerateConsoleCtrlEvent(uint32 dwCtrlEvent, uint32 dwProcessGroupId)",
  );
  return (event, pid) => {
    binding(event, pid);
  };
}
