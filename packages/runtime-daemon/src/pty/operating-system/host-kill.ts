// Killing a terminal host process alone, as Node's own kill does on every system.

import type { TerminalHostProcess } from "./contract.js";

/** Kills `host` alone with SIGKILL; a failure is logged, since its exit may already have come. */
export function killTerminalHostAlone(host: TerminalHostProcess): Promise<void> {
  try {
    host.kill("SIGKILL");
  } catch (killError: unknown) {
    console.warn("SIGKILL to the terminal host that stopped answering failed.", {
      cause: killError,
    });
  }
  return Promise.resolve();
}
