// What this window can do about the entries it was told about and never received.
//
// BESIDE THE CATCHING-UP MARK AND NOT IN PLACE OF IT. `pane/window/
// LedgerWindowReadState.tsx` says the projection is behind and names the cause. This
// says what is being done about the hole, which is a different fact and the one a
// person can act on: a replay from the position this window kept, or — where no read
// has acknowledged a position — the whole-window re-read the store performs anyway.
//
// FOUR STATES, because two of them render nothing on purpose. A whole window has
// nothing to say. An ask still in flight has nothing to say EITHER, and that is the
// deliberate half: the catching-up mark above is already a `computing` absence
// carrying its own live region, and a second one beside it announces the same sentence
// twice — which is the nested-status-region defect that pane's own header names. The
// ask settles in one turn of the call, so what a person sees is the answer.
//
// WHY IT MOUNTS AT THE FAMILY'S WORKSPACE ROOT. It needs two things that are in hand
// in exactly one place: the store, for the hole, and the registry, for the position a
// read acknowledged. `SessionResumeDegraded` next door is mounted there for the same
// reason and says so — the workspace body is handed everything BUT the registry.

import { Nothing } from "../../../primitives/index.js";
import {
  useSessionStore,
  useTimelineResume,
  type SessionStore,
  type SessionStoreRegistry,
  type SessionStoreState,
} from "../../../store/index.js";
import type { TimelineSubscribeCall } from "../../../bridge/index.js";
import { useLedgerGapFill } from "./ledger-gap-fill.js";

/** The stores the hole and the kept position are read from, and the call that asks. */
export interface LedgerGapFillProps {
  readonly registry: SessionStoreRegistry;
  readonly sessionStore: SessionStore;
  /** Puts the replay ask. */
  readonly fillGap: TimelineSubscribeCall;
}

/**
 * The replay this window can ask for, or nothing at all.
 *
 * `null` for a window with nothing missing, and for the interval an ask is in flight.
 * Both are the ordinary course and neither is this surface's to report.
 */
export function LedgerGapFill(props: LedgerGapFillProps): React.JSX.Element | null {
  const { sessionId } = props.sessionStore;
  const missingFromSequence = useSessionStore(props.sessionStore, readOldestMissingSequence);
  const resume = useTimelineResume(props.registry, sessionId);
  const fill = useLedgerGapFill(
    {
      sessionId,
      missingFromSequence,
      // The one position this console legitimately holds. Every other arm of the resume
      // decision names none — a restart because nothing was ever acknowledged, a refusal
      // because the daemon could not resolve what this console sent — and neither is a
      // position to replay from. The refusal itself is already on screen above, rendered
      // by the surface that owns that reading.
      keptCursor: resume?.outcome === "resume" ? resume.fromCursor : undefined,
    },
    props.fillGap,
  );
  if (fill.status === "whole" || fill.status === "asking") {
    return null;
  }
  if (fill.status === "unanchored") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="There is no position to replay from."
        detail="Entries this window was told about have not arrived, and no read of this session has acknowledged a position the stream could be re-opened after. The whole window is re-read instead, which is the repair already under way."
      />
    );
  }
  return (
    <Nothing
      kind="computing"
      placement="surface"
      title="Replaying the missing entries."
      detail={
        "The stream was re-opened after the last position this window kept. " +
        "The entries it replays arrive on the subscription this session already holds."
      }
    />
  );
}

/**
 * The first log position of the oldest hole standing, or nothing where none is.
 *
 * A number rather than the gap row itself, and the narrowing is what keeps this a
 * stable selector: the store's `gaps` array re-identifies on every transition that
 * touches it, so a selector answering the row would re-render this on transitions that
 * changed nothing about the hole. The oldest is `gaps[0]` — the store records them
 * oldest first — and a replay opens after one position and runs forward, so the oldest
 * is the only one worth asking from.
 */
function readOldestMissingSequence(state: SessionStoreState): number | undefined {
  return state.gaps[0]?.fromSequence;
}
