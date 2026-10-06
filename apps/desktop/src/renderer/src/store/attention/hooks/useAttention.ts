import { createContext, useContext, type Context } from "react";

import { RefusalError, refuse } from "#renderer/lib/refusal/contract.js";
import type { SessionDirectoryState } from "../../session/directory/state.js";
import type { AttentionReading } from "../summary.js";

/**
 * What this window holds about the sessions it can name, read once: the destination renders
 * the reading and can ask for the directory again.
 */
export interface WindowAttention {
  /** The service's session list, as the read settled it. */
  readonly directory: SessionDirectoryState;
  readonly reading: AttentionReading;
  /** Ask for the session list again, as it now stands. */
  readonly recheckDirectory: () => void;
}

/** What the attention provider holds; `undefined` outside it, which the hook refuses. */
export const WindowAttentionContext: Context<WindowAttention | undefined> = createContext<
  WindowAttention | undefined
>(undefined);

/** The subsystem a missing provider names as the author of its refusal. */
const SESSION_ATTENTION_ORIGIN = "attention-provider";

/**
 * What the binding above holds. Raises rather than substitutes: a component reaching for a
 * binding no composition mounted is a wiring defect, and an empty reading would render
 * "nothing needs you" over a projection nobody read while a second read would be the second
 * answer this binding exists to prevent.
 */
export function useAttention(): WindowAttention {
  const held = useContext(WindowAttentionContext);
  if (held === undefined) {
    throw new RefusalError(
      refuse(
        SESSION_ATTENTION_ORIGIN,
        "binding-unmounted",
        "This component reads the window's attention " +
          "binding, and no composition mounted one above it.",
      ),
    );
  }
  return held;
}
