import { createContext, useContext, type Context } from "react";

import { ConsoleRefusalError, refuse } from "@renderer/lib/refusal.js";
import type { WindowAttention } from "../AttentionProvider.js";

/** What the attention provider holds; `undefined` outside it, which the hook refuses. */
export const SessionAttentionContext: Context<WindowAttention | undefined> = createContext<
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
  const held = useContext(SessionAttentionContext);
  if (held === undefined) {
    throw new ConsoleRefusalError(
      refuse(
        SESSION_ATTENTION_ORIGIN,
        "binding-unmounted",
        "This surface reads the window's attention binding, and no composition mounted one above it.",
      ),
    );
  }
  return held;
}
