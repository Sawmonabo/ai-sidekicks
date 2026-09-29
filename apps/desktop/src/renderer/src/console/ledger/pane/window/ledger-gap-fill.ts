// Replay from here: what a window that was told about entries it never received can
// ask for, and what it asks with.
//
// THE FACT THIS IS ABOUT. The store's reconciler counts the rows between the position
// it was rebased to and the next delivery it admits. A jump is a real hole — named
// rows the daemon says exist and this window does not hold — and the store records it
// as a `sequence-gap` cause that only a completed re-pull clears. The pane beside this
// one already says the window is behind. What it does not say, because nothing could,
// is that the repair available to this console is the WHOLE window re-read: a fresh
// snapshot at the top of the log, paid for in full every time one row goes missing.
//
// WHAT WOULD MAKE IT A REPLAY INSTEAD. `timeline.subscribe` takes an `afterCursor` and
// opens the stream after the position it names, so a window holding a kept position
// could ask for exactly the rows it lost. The call that puts the ask is the caller's,
// taken as an argument, so this module keeps only its own logic: when to ask, and where
// the ask got to.
//
// AND THE PANE NEVER OWNS THE STREAM. The answer is the acknowledgement the registered
// reply carries and nothing else: the rows arrive on the subscription the store
// already holds, which is the console's one subscriber to the wire. A value that
// handed this surface a stream to drain would make a pane the owner of the log's
// delivery, which is the rule `store/session/session-hooks.ts` states and the reason
// this module reads a decision rather than opening anything.
//
// WHY THE POSITION IS THE ACKNOWLEDGED CURSOR AND NOT THE LAST ROW ON SCREEN. The
// obvious anchor — the newest row in front of the hole — is an event id, and an event
// id is not a cursor. `store/session/timeline-resume.ts` says why in as many words: the cursor
// is opaque, its structure is the daemon's, and this console orders nothing by it. The
// one position this console legitimately holds is the one a read acknowledged and the
// store already submits on its next read, so a replay asks with that or asks with
// nothing.

import { useSubjectRead } from "../../../store/index.js";
import type { TimelineResubscribeRequest, TimelineSubscribeCall } from "../../../bridge/index.js";

/**
 * Whether this window can ask for a replay, and what it would ask with.
 *
 * A discriminated union rather than a request that may be absent, because the two
 * absences are different facts a surface says differently: a window with nothing
 * missing has no reason to ask, and a window that IS missing rows and holds no kept
 * position cannot ask at all — its only repair is the whole-window re-read, which is
 * worth saying rather than leaving as a request that quietly never went out.
 */
export type LedgerGapFillIntent =
  | { readonly outcome: "whole" }
  | { readonly outcome: "unanchored"; readonly missingFromSequence: number }
  | {
      readonly outcome: "resumable";
      readonly missingFromSequence: number;
      readonly request: TimelineResubscribeRequest;
    };

/** The three facts the decision is taken over, and nothing else. */
export interface LedgerGapFillInput {
  readonly sessionId: string;
  /**
   * The first log position of the oldest hole standing, or nothing where none is.
   *
   * The OLDEST rather than the newest: a replay opens after one position and runs
   * forward, so asking from the newest hole would leave every earlier one unfilled
   * while reporting a repair.
   */
  readonly missingFromSequence: number | undefined;
  /** The position a read acknowledged, held by the store. Never derived from a row. */
  readonly keptCursor: string | undefined;
}

/** Where the fill for the hole standing now has got to. */
export type LedgerGapFillState =
  | { readonly status: "whole" }
  | { readonly status: "unanchored" }
  | { readonly status: "asking" }
  | { readonly status: "replaying" };

/**
 * Decide what this window can ask for. Pure: it holds nothing and it calls nothing.
 *
 * Separate from the hook below for the reason `store/session/timeline-resume.ts` is separate
 * from the entry that acts on it — the rule is checkable on its own, and the surface
 * that renders it is then a projection of a decision rather than a second copy of one.
 */
export function resolveLedgerGapFill(input: LedgerGapFillInput): LedgerGapFillIntent {
  if (input.missingFromSequence === undefined) {
    return { outcome: "whole" };
  }
  if (input.keptCursor === undefined) {
    return { outcome: "unanchored", missingFromSequence: input.missingFromSequence };
  }
  return {
    outcome: "resumable",
    missingFromSequence: input.missingFromSequence,
    request: { sessionId: input.sessionId, afterCursor: input.keptCursor },
  };
}

/**
 * The subject one fill is put under: this session's hole, and not this session.
 *
 * Keyed on the hole so exactly one ask goes out per hole. Keyed on the session alone
 * it would be one ask per session and a second hole would go unasked; keyed on the
 * store's revision it would be one ask per row admitted, which is the polling this
 * console forbids wearing a read's clothes.
 */
export function ledgerGapFillSubjectKey(sessionId: string, missingFromSequence: number): string {
  return `${sessionId}:${String(missingFromSequence)}`;
}

/** The four arms, minted once: each is one identity across every render. */
const WHOLE: LedgerGapFillState = { status: "whole" };
const UNANCHORED: LedgerGapFillState = { status: "unanchored" };
const ASKING: LedgerGapFillState = { status: "asking" };
const REPLAYING: LedgerGapFillState = { status: "replaying" };

/**
 * Put one replay ask per hole, and report where it got to. `call` must be referentially
 * stable: it scopes the read and is an effect dependency, so an inline lambda would ask
 * again on every render.
 *
 * AND NO POLLING, on the session header's rule: the ask goes out once from the effect the
 * read chokepoint arms, and again only when the call or the hole moves. A hole that
 * closes re-addresses the holder to `undefined`, which re-seeds this to `whole` — so
 * the surface clears with the store's own repair rather than on a timer of its own.
 *
 * The input is three facts rather than a store and a registry, so the rule above and
 * the settlement here are both drivable without mounting either. The component next
 * door is what reads them off the store and the registry, which is the one place both
 * are in hand.
 */
export function useLedgerGapFill(
  input: LedgerGapFillInput,
  call: TimelineSubscribeCall,
): LedgerGapFillState {
  const intent = resolveLedgerGapFill(input);
  const request = intent.outcome === "resumable" ? intent.request : undefined;
  const subjectKey =
    intent.outcome === "resumable"
      ? ledgerGapFillSubjectKey(input.sessionId, intent.missingFromSequence)
      : undefined;
  // A subject to ask about IS an ask in flight, because the read's effect runs on the
  // commit that seeded this. The two unsettled arms are the two ways there is nothing
  // to ask, and they are told apart by the intent rather than by the key — which
  // cannot tell them apart, both being unaddressed.
  const unsettled = intent.outcome === "whole" ? WHOLE : UNANCHORED;
  const { value } = useSubjectRead<{ readonly subscriptionId: string }, LedgerGapFillState>(
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
