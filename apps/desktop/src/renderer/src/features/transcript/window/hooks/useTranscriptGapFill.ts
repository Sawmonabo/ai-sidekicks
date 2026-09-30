import { useSubjectRead } from "@renderer/hooks/useSubjectRead.js";
import type { TimelineSubscribeCall } from "@renderer/services/daemon/session-reads.js";
import {
  buildGapFillSubjectKey,
  resolveTranscriptGapFill,
  type TranscriptGapFillInput,
} from "../transcript-gap-fill.js";

/** Where the fill for the hole standing now has got to. */
export type TranscriptGapFillState =
  | { readonly status: "whole" }
  | { readonly status: "unanchored" }
  | { readonly status: "asking" }
  | { readonly status: "replaying" };

/** The four arms, minted once: each is one identity across every render. */
const WHOLE: TranscriptGapFillState = { status: "whole" };
const UNANCHORED: TranscriptGapFillState = { status: "unanchored" };
const ASKING: TranscriptGapFillState = { status: "asking" };
const REPLAYING: TranscriptGapFillState = { status: "replaying" };

/**
 * Put one replay ask per hole, and report where it got to. `call` must be referentially
 * stable: it scopes the read and is an effect dependency, so an inline lambda would ask
 * again on every render.
 *
 * AND NO POLLING, on the session header's rule: the ask goes out once from the effect the
 * read chokepoint arms, and again only when the call or the hole moves. A hole that
 * closes re-addresses the holder to `undefined`, which re-seeds this to `whole` — so
 * the state clears with the store's own repair rather than on a timer of its own.
 *
 * The input is three facts rather than a store and a registry, so the rule above and
 * the settlement here are both drivable without mounting either. `TranscriptGapFill`
 * reads them off the store and the registry, the one place both are in hand.
 */
export function useTranscriptGapFill(
  input: TranscriptGapFillInput,
  call: TimelineSubscribeCall,
): TranscriptGapFillState {
  const intent = resolveTranscriptGapFill(input);
  const request = intent.outcome === "resumable" ? intent.request : undefined;
  const subjectKey =
    intent.outcome === "resumable"
      ? buildGapFillSubjectKey(input.sessionId, intent.missingFromSequence)
      : undefined;
  // A subject to ask about IS an ask in flight, because the read's effect runs on the
  // commit that seeded this. The two unsettled arms are the two ways there is nothing
  // to ask, and they are told apart by the intent rather than by the key — which
  // cannot tell them apart, both being unaddressed.
  const unsettled = intent.outcome === "whole" ? WHOLE : UNANCHORED;
  const { value } = useSubjectRead<{ readonly subscriptionId: string }, TranscriptGapFillState>(
    call,
    subjectKey,
    () => (request === undefined ? undefined : call(request)),
    {
      unsettled: (key) => (key === undefined ? unsettled : ASKING),
      settled: () => REPLAYING,
    },
  );
  return value;
}
