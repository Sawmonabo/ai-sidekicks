import { createContext, useContext, type Context } from "react";

import { RefusalError, refuse } from "@renderer/lib/refusal.js";
import type { SessionDirectoryState } from "../../session-directory/session-directory.js";
import type { AttentionReading } from "../attention-summary.js";

/**
 * What this window holds about the sessions it can name, read once.
 *
 * The members are what the consumers between them need, and no more: the destination
 * renders the reading and can ask for the directory again.
 */
export interface WindowAttention {
  /** The node's own session list, as the read settled it. */
  readonly directory: SessionDirectoryState;
  readonly reading: AttentionReading;
  /** Declare the node's directory stale, so it is read again. */
  readonly recheckDirectory: () => void;
}

/** What the attention provider holds; `undefined` outside it, which the hook refuses. */
export const WindowAttentionContext: Context<WindowAttention | undefined> = createContext<
  WindowAttention | undefined
>(undefined);

/** The subsystem a missing provider names as the author of its refusal. */
const SESSION_ATTENTION_ORIGIN = "attention-provider";

/**
 * What the binding above holds.
 *
 * RAISES RATHER THAN SUBSTITUTES. A surface reaching for a binding no composition
 * mounted is a wiring defect, and the honest answers a fallback could give are both
 * wrong: an empty reading would render "nothing needs you" over a projection nobody
 * read, and a second read here would be the second answer this binding exists to
 * prevent. It is the rule `useConsoleBridge` already follows one layer down.
 */
export function useAttention(): WindowAttention {
  const held = useContext(WindowAttentionContext);
  if (held === undefined) {
    throw new RefusalError(
      refuse(
        SESSION_ATTENTION_ORIGIN,
        "binding-unmounted",
        "This surface reads the window's attention binding, and no composition mounted one above it.",
      ),
    );
  }
  return held;
}
