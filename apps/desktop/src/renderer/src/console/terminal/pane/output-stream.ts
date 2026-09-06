// The terminal pane's question about its output stream, and what the answer was.
//
// WHAT IS LIVE HERE AND WHAT IS NOT. The byte stream, the scrollback, and the resize
// report are `Plan-023 §Console growth slate` row 3, which the growth port refuses by
// name. So this read ASKS, and renders the refusal it gets, rather than assuming the
// answer: the port is what says whether a wire is registered, and a surface that
// skipped the call and hard-coded the absence would keep rendering it for a day after
// the wire landed. While the call is out the honest reading is that nothing has been
// established, which is the "computing" absence rather than an empty stream.
//
// DELETION OBLIGATION. When slate row 3 leaves the table, the served arm drains into
// the emulator (an addition to `XtermHost`, which owns the adapter) and the refusal
// reading below goes with the row.
//
// WHOSE READING IT IS. The reading is a fact about ONE shell on ONE bridge, and the
// pane holding it outlives both: a deck that hands the same instance a different
// bridge or a different session store replaces the effect while the state still holds
// the previous terminal's answer, and a mount flag cannot help — it is the flag of the
// effect that is being torn down, and its cleanup runs a pass AFTER the render that
// has already put the previous shell's absence or refusal on screen for the
// replacement. A promise from the retired subject can also settle in that same window,
// before the cleanup that would have flipped the flag. So the reading is held for its
// `(bridge, terminalId)` subject by the console's one holder, which answers on the
// render that mounts the emulator rather than one after it: a replacement subject
// reads `ASKING_FOR_OUTPUT` — the honest state for a question that has just been put
// and not yet answered — rather than the previous shell's.

import { useEffect } from "react";

import type { ConsoleBridge } from "../../bridge/index.js";
import { normalizeWireRejection, type ConsoleRefusal } from "../../core/index.js";
import { useSubjectScopedState } from "../../store/index.js";

/** What the output line says, as data — so the effect sets a value, not a tree. */
export interface TerminalOutputAbsence {
  readonly kind: "computing" | "not-checked";
  readonly title: string;
  /** Always present: every arm here has something to say, and a silent one would
   *  leave the reader with a state name and no next move. */
  readonly detail: string;
}

/**
 * What the read settled as: an ABSENCE the console can describe, or a REFUSAL the
 * wire authored.
 *
 * Two arms rather than a third `kind` on the absence, because they are two
 * different renderings under rule 9 — an absence says what is not here, a refusal
 * carries a machine-readable code the operator acts on — and folding a refusal
 * into an absence is what threw that code away.
 *
 * AND NOT `ReadingState`, which its neighbours in this family now are. That
 * vocabulary closes over how completely a reading that ARRIVED answered — `served`
 * is its only completeness claim and every other arm renders a notice ABOVE rows
 * that are on screen. This union is the case where nothing arrived at all, which is
 * rule 8's, and its `not-checked` arm has no member there to borrow. Expressing it
 * as a reading state would put a rule-8 absence inside the one union whose whole
 * discipline is that six kinds each have a sentence, and `readingNoticeFor` would
 * owe a seventh for a state that renders through `Nothing` instead. What this union
 * does share is the WORD: a refusal here is spelled `refused`, as it is everywhere
 * else in the console, rather than a fourth local spelling of it.
 */
export type TerminalOutputReading =
  | { readonly status: "absent"; readonly absence: TerminalOutputAbsence }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * The subsystem name every refusal this read raises itself carries.
 *
 * `LeaseLine`'s reason, applied to the other half of the pane: `core/refusal.ts`
 * is the console's one normalizer, and it is what keeps the wire's own code on
 * screen. This arm used to build its own title-plus-stringified-payload pair, so a
 * `permission_denied` and a torn-down transport reached the operator as the same
 * generic sentence with the actionable half serialized into JSON beside it.
 */
const OUTPUT_STREAM_REFUSAL_ORIGIN = "terminal-output";

/**
 * What a rejection carrying NO code of its own says instead.
 *
 * The normalizer spends this only on its fourth arm — a wire envelope, a console
 * refusal, and a `ConsoleRefusalError` all keep what they came with. A codeless
 * rejection here means the bridge never answered at all, and naming the next move
 * beats reporting a transport's own message about a channel a person cannot see.
 */
const OUTPUT_STREAM_REJECTION_FALLBACK = {
  code: "terminal-output-unreachable",
  detail:
    "The console asked this session's shell for its output stream and the bridge never answered. Reopening this pane asks again.",
} as const;

function absent(absence: TerminalOutputAbsence): TerminalOutputReading {
  return { status: "absent", absence };
}

const ASKING_FOR_OUTPUT: TerminalOutputReading = absent({
  kind: "computing",
  title: "Asking for the output stream",
  detail:
    "The console has asked the bridge whether this session's shell streams output here, and is waiting for the answer.",
});

/** Ask for the output stream and hold what the answer was, per terminal. */
export function useTerminalOutputStream(
  bridge: ConsoleBridge,
  terminalId: string,
): TerminalOutputReading {
  const { value: reading, publish } = useSubjectScopedState<TerminalOutputReading>(
    bridge,
    terminalId,
    () => ASKING_FOR_OUTPUT,
  );

  useEffect(() => {
    let isMounted = true;
    void bridge.growth
      .terminalSubscribeOutput({ terminalId })
      .then((outcome) => {
        if (outcome.status === "served") {
          // Unreachable at this revision, and not silently dropped: the stream is
          // closed rather than leaked. The deletion obligation in this file's
          // header is what replaces this arm with a drain into the emulator.
          outcome.value.close();
        }
        if (!isMounted) {
          return;
        }
        publish(
          outcome.status === "unavailable"
            ? absent({ kind: "not-checked", title: "No output stream", detail: outcome.detail })
            : absent({
                kind: "not-checked",
                title: "Output stream not drained",
                detail:
                  "The stream was served, and this revision has no consumer for it. The pane closed it rather than holding a subscription nothing reads.",
              }),
        );
      })
      .catch((failure: unknown) => {
        if (isMounted) {
          publish({
            status: "refused",
            refusal: normalizeWireRejection(
              OUTPUT_STREAM_REFUSAL_ORIGIN,
              failure,
              OUTPUT_STREAM_REJECTION_FALLBACK,
            ),
          });
        }
      });
    return () => {
      isMounted = false;
    };
  }, [bridge, terminalId, publish]);

  return reading;
}
