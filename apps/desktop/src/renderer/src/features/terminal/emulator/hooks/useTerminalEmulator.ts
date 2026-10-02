// Where the emulator's code got to, as a reading the mount point can render.
//
// Separate from `XtermMountPoint.tsx` so the loader is a parameter: the mount point resolves the
// page's one loader, so a refusing fetch can only be driven here. A failed fetch offers a retry,
// which asks the loader again; the loader drops a failed fetch's memo, so the retry is a real
// request.

import { useEffect, useState } from "react";

import type { TerminalEmulatorLoader, TerminalEmulatorModule } from "../emulator-loader.js";

/** Where the emulator's code is: still coming, here, or failed with a way to ask again. */
export type TerminalEmulatorState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly module: TerminalEmulatorModule }
  | { readonly status: "failed"; readonly retry: () => void };

/**
 * The state before the fetch has answered; one shared value so an unchanged re-render returns
 * the same object.
 */
export const LOADING_EMULATOR: TerminalEmulatorState = { status: "loading" };

/**
 * Fetch the emulator's chunk and say where it got to. A hook because `import()` is a side
 * effect a discarded render pass must not start. A chunk arriving after an unmount sets state
 * React drops; the loader's memo means the next mount reuses that fetch.
 */
export function useTerminalEmulator(loader: TerminalEmulatorLoader): TerminalEmulatorState {
  const [emulator, setEmulator] = useState<TerminalEmulatorState>(LOADING_EMULATOR);
  // Raised by a retry, so the effect below asks the loader again.
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    loader.load().then(
      (module) => {
        setEmulator({ status: "loaded", module });
      },
      () => {
        setEmulator({
          status: "failed",
          retry: () => {
            setEmulator(LOADING_EMULATOR);
            setLoadAttempt((attempt) => attempt + 1);
          },
        });
      },
    );
  }, [loader, loadAttempt]);

  return emulator;
}
