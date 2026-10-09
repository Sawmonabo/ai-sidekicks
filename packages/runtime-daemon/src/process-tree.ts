// Ending a child the service started together with every process it started in turn: git's
// transport helpers, a setup command's own children. The child must lead its own process group
// (`detached: true` outside Windows).

import { defaultSpawnTaskkill } from "./pty/taskkill-windows.js";

// `taskkill` exits 128 when no process has the id: the tree is already gone.
const TASKKILL_NO_SUCH_PROCESS_EXIT_CODE = 128;

/**
 * Sends `signal` to the process group `pid` leads; on Windows, where no signal reaches a tree,
 * `taskkill /T /F` ends it at once. A group already gone is no failure; any other is thrown,
 * a `taskkill` that could not run or failed included.
 */
export async function endProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === "win32") {
    const { exitCode } = await defaultSpawnTaskkill(pid);
    if (exitCode !== 0 && exitCode !== TASKKILL_NO_SUCH_PROCESS_EXIT_CODE) {
      throw new Error(`taskkill could not end process ${String(pid)} (exit ${String(exitCode)})`);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
