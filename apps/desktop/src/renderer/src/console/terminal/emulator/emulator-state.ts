// Where the emulator's code got to, as a reading a surface can render.
//
// Split out of `XtermHost.tsx` because the mount point renders it and this decides
// it, and because the arm that matters is not reachable from that component at all:
// the host resolves the page's one loader, so a fetch that REFUSES can only be
// driven where the loader is a parameter. It is one here, which is the same seam
// `emulator-loader.ts` opened when it made the memo a private field rather than a
// module-level promise.
//
// THE REJECTION IS NORMALIZED AND NEVER STRINGIFIED. `import()` rejects with
// whatever the bundler, the network layer, or the module body raised — an `Error`,
// a wire envelope, a null-prototype object, a value whose `toString` throws — and
// this arm used to hand it to `String()`. Two failures came out of that: an
// ordinary non-`Error` rendered `[object Object]` as the reason a person was meant
// to act on, and a hostile one threw INSIDE the rejection handler, so nothing was
// ever recorded and the pane sat on "Loading the terminal emulator" for the life of
// the mount, with no refusal anywhere. `core/wire-rejection.ts` is total by
// construction and is what every other rejection tail in this family already
// reaches for, so the answer is a `ConsoleRefusal` for every input and a throw for
// none.
//
// NO CALLER FALLBACK IS SUPPLIED, and that is a choice rather than an omission. The
// fallback arm runs BEFORE the terminal arm, so naming one here would replace a
// chunk loader's own message — "Failed to fetch dynamically imported module", the
// one sentence that says which fetch died — with a sentence written in this file.
// A codeless rejection still names its seam through the synthesized code, and a
// value that carries no readable sentence renders the total stringifier's constant
// rather than a serialization of itself.

import { useEffect, useState } from "react";

import { normalizeWireRejection, type ConsoleRefusal } from "../../core/index.js";
import type { TerminalEmulatorLoader, TerminalEmulatorModule } from "./emulator-loader.js";

/**
 * The subsystem name a refusal raised by the emulator's own fetch carries.
 *
 * `output-stream.ts`'s reason, for the other deferred edge in this family: the code
 * a person reads names the seam that failed, so a chunk that never arrived and a
 * shell that never answered are two different next moves rather than one generic
 * sentence.
 */
const EMULATOR_REFUSAL_ORIGIN = "terminal-emulator";

/** Where the emulator's code is: still coming, here, or refused. */
export type TerminalEmulatorState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly module: TerminalEmulatorModule }
  | { readonly status: "failed"; readonly refusal: ConsoleRefusal };

/**
 * The state before the fetch has answered.
 *
 * One frozen value rather than a fresh literal, so a re-render that has not moved
 * hands the same object back.
 */
export const LOADING_EMULATOR: TerminalEmulatorState = { status: "loading" };

/**
 * Fetch the emulator's chunk and say where it got to.
 *
 * A hook rather than a call in a render body, on `apps/desktop/AGENTS.md`'s rule
 * and for a concrete reason: `import()` is a side effect, and a render body that
 * started one would start a second on every discarded pass.
 *
 * UNMOUNT BEFORE THE CHUNK ARRIVES is the arm worth naming. A pane opened and
 * closed inside one fetch leaves a promise still in flight over a component React
 * has already dropped, and settling it into state would be a write against a
 * disposed host. The flag below is read on both arms, so a late resolution and a
 * late rejection are each ignored rather than one of them handled — and the memo
 * inside the loader means the fetch itself is not wasted: the next mount gets the
 * chunk this one paid for.
 */
export function useTerminalEmulator(loader: TerminalEmulatorLoader): TerminalEmulatorState {
  const [emulator, setEmulator] = useState<TerminalEmulatorState>(LOADING_EMULATOR);

  useEffect(() => {
    let isMounted = true;
    loader.load().then(
      (module) => {
        if (isMounted) {
          setEmulator({ status: "loaded", module });
        }
      },
      (loadError: unknown) => {
        if (isMounted) {
          setEmulator({
            status: "failed",
            refusal: normalizeWireRejection(EMULATOR_REFUSAL_ORIGIN, loadError),
          });
        }
      },
    );
    return () => {
      isMounted = false;
    };
  }, [loader]);

  return emulator;
}
