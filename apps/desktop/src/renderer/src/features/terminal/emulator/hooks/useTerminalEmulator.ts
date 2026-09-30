// Where the emulator's code got to, as a reading the mount point can render.
//
// Separate from `XtermMountPoint.tsx` so the loader is a parameter: the mount point resolves the
// page's one loader, so a refusing fetch can only be driven here. The rejection is normalized,
// never stringified: `import()` can reject with any value, and `String()` on a hostile one
// throws inside the handler and leaves the pane on its loading skeleton. No fallback is passed
// to the normalizer, so a chunk loader's own sentence ("Failed to fetch dynamically imported
// module") reaches the screen.

import { useEffect, useState } from "react";

import { normalizeWireRejection } from "@renderer/lib/wire-rejection.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import type { TerminalEmulatorLoader, TerminalEmulatorModule } from "../emulator-loader.js";

/**
 * The origin a refusal from the emulator's own fetch carries, so the code a person reads names
 * the seam that failed.
 */
const EMULATOR_REFUSAL_ORIGIN = "terminal-emulator";

/** Where the emulator's code is: still coming, here, or refused. */
export type TerminalEmulatorState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly module: TerminalEmulatorModule }
  | { readonly status: "failed"; readonly refusal: Refusal };

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

  useEffect(() => {
    loader.load().then(
      (module) => {
        setEmulator({ status: "loaded", module });
      },
      (loadError: unknown) => {
        setEmulator({
          status: "failed",
          refusal: normalizeWireRejection(EMULATOR_REFUSAL_ORIGIN, loadError),
        });
      },
    );
  }, [loader]);

  return emulator;
}
