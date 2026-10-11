// Windows' console-control events, the signals a console program answers: `node-pty` does not
// expose `GenerateConsoleCtrlEvent`, so it is bound through `koffi`, loaded on the first Windows
// kill.

import { importKoffi } from "./koffi.js";

/** Windows console-control event codes per Win32 `GenerateConsoleCtrlEvent`. */
export type ConsoleCtrlEvent = 0 | 1; // CTRL_C_EVENT | CTRL_BREAK_EVENT

/**
 * Binds `GenerateConsoleCtrlEvent` from `kernel32.dll` through `koffi` on first use.
 * Throws with an install hint when `koffi` cannot be loaded. Only the Windows kill path calls it.
 */
export async function loadGenerateConsoleCtrlEvent(): Promise<
  (event: ConsoleCtrlEvent, pid: number) => void
> {
  // No platform guard: tests inject the FFI seam directly, and a real Windows failure surfaces
  // with its own diagnostics.
  const koffi = await importKoffi("Windows kill-translation");
  const kernel32 = koffi.load("kernel32.dll");
  const binding = kernel32.func(
    "int __stdcall GenerateConsoleCtrlEvent(uint32 dwCtrlEvent, uint32 dwProcessGroupId)",
  );
  return (event: ConsoleCtrlEvent, pid: number): void => {
    binding(event, pid);
  };
}
