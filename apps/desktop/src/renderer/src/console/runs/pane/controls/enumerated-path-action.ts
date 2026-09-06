// What a person can do with one path a rollback enumerated.
//
// THE DIFF PANE IS NOT REACHABLE FROM HERE, AND IT WOULD NOT HELP. A pane body is
// handed `ConsolePaneContext`, which carries its address, its bridge and its stores
// and no way to open another pane — so a runs surface has no route to the diff pane
// at all. And the route would answer nothing even if it existed: both enumerations
// name paths git does not track. An overwritten IGNORED path is ignored, and a
// divergent gitlink is a submodule pointer, so neither has a diff to open.
//
// SO THE ACTION IS THE ONE THAT HANDS THE PERSON THE PATH ITSELF, on the repos
// family's own precedent for a canonical root: the host copies it, and a host that
// refuses says so rather than leaving a control that looks like it worked. The path
// travels as the wire string it arrived as — it is NOT re-branded into the preload
// contract's opaque path token, which exists precisely so a renderer cannot hand the
// main process a path of its own choosing, and a daemon-supplied string is not one of
// those tokens however true it may be.

import { useCallback, useState } from "react";

import { type ConsoleBridge, type DaemonReplyRefusalCode } from "../../../bridge/index.js";
import { normalizeWireRejection, type ConsoleRefusal } from "../../../core/index.js";

/** The verb this action puts in each path control's accessible name. */
export const ENUMERATED_PATH_ACTION_LABEL = "Copy path";

/** The subsystem every refusal this action raises is attributed to. */
const ENUMERATED_PATH_REFUSAL_ORIGIN = "runs-pane";

/** One path action, and the last refusal the host answered it with. */
export interface EnumeratedPathAction {
  readonly copyPath: (path: string) => void;
  /** Present only where the host refused; rendered beside the enumeration. */
  readonly refusal: ConsoleRefusal | undefined;
}

/**
 * Offer the enumerated paths, through the host's clipboard.
 *
 * The refusal is held rather than thrown: the path is still on screen and still
 * readable, so what the person needs to know is that the copy did not happen — not
 * to lose the surface that was showing it.
 */
export function useEnumeratedPathAction(bridge: ConsoleBridge): EnumeratedPathAction {
  const [refusal, setRefusal] = useState<ConsoleRefusal | undefined>(undefined);
  const copyPath = useCallback(
    (path: string) => {
      setRefusal(undefined);
      bridge.sidekicks.native.copyToClipboard(path).catch((rejection: unknown) => {
        // WHAT THE HOST SAID, NEVER THE CONSOLE'S PARAPHRASE OF IT. The `catch` used
        // to take no parameter and answer with prose of its own, which discarded the
        // one machine-readable thing the refusal carried:
        // `Spec-023 §Console Design (Meridian)` rule 9 puts the other side's code and
        // sentence on screen verbatim and leaves the console the `action` slot alone.
        // The normalizer is the console's one reading of a rejected promise, so this
        // seam invents no second refusal constructor beside it — the fallback below
        // is reached only where the rejection said nothing machine-readable at all.
        //
        // The path itself is deliberately not in the fallback sentence: it is a wire
        // string of unbounded length and a refusal is not the place to repeat it.
        setRefusal(
          normalizeWireRejection(ENUMERATED_PATH_REFUSAL_ORIGIN, rejection, {
            code: "call-rejected" satisfies DaemonReplyRefusalCode,
            detail:
              "native.copyToClipboard was rejected, so the path was not copied. It is still shown above and can be selected by hand.",
          }),
        );
      });
    },
    [bridge],
  );
  return { copyPath, refusal };
}
