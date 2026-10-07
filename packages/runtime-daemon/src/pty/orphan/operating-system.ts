// What the orphan defense takes from the operating system it runs on. Each system supplies what it
// has built; a part it lacks is absent, and the defense then relies on the registry alone: a child
// is retired when the terminal host sees it end, and an intent with no recorded process is
// discarded at the next start, with nothing signaled.

import { userInfo } from "node:os";

import { DarwinProcessExitWatch } from "./darwin/exit-watch.js";
import { findDarwinProcessesCarryingNonces } from "./darwin/nonce-search.js";
import { loadDarwinSystemLibrary } from "./darwin/system-library.js";

/** The kernel's own watch on processes' exits, immune to a reused process id. */
export interface ProcessExitWatch {
  /**
   * Calls `onExit` once the process ends, at once when it already has. Throws when the system
   * refuses the watch.
   */
  watch(processId: number, onExit: () => void): void;
  /** Stops watching; no `onExit` is called once it resolves. */
  close(): Promise<void>;
}

/** The parts of the orphan defense this system supplies. */
export interface OrphanOperatingSystem {
  readonly exitWatch?: ProcessExitWatch | undefined;
  /** Finds this user's processes whose environment carries one of `nonces`, by process id. */
  readonly findProcessesCarryingNonces?:
    | ((nonces: ReadonlySet<string>) => Promise<Map<number, string>>)
    | undefined;
}

/**
 * Opens what `platform` supplies: on macOS the kernel exit watch and the nonce search, whose
 * failures to load throw; elsewhere nothing yet. `onWatchFailure` hears a watch that stopped.
 */
export async function openOrphanOperatingSystem(
  platform: NodeJS.Platform,
  onWatchFailure: (error: Error) => void,
): Promise<OrphanOperatingSystem> {
  if (platform !== "darwin") {
    return {};
  }
  const library = await loadDarwinSystemLibrary();
  const userId = userInfo().uid;
  return {
    exitWatch: new DarwinProcessExitWatch(library, onWatchFailure),
    findProcessesCarryingNonces: (nonces) =>
      Promise.resolve(findDarwinProcessesCarryingNonces(library, userId, nonces)),
  };
}
