// The held arm, with the holder's place on the session's own hue wheel resolved.
//
// A COMPONENT RATHER THAN A BRANCH INSIDE THE LINE, and the reason is a hook rule
// rather than taste: the wheel lives on the session's store, `useSessionInitialised`
// is one of the console's sanctioned reads of one, and a hook cannot be called
// conditionally — so the store's presence has to be decided by which component is
// rendered. The block above makes that decision; this module is the arm that has a
// store.
//
// ONE WHEEL, NEVER A SECOND. `ParticipantHueAllocator` allocates in join-log order and
// resolves collisions across the twelve steps, so a hue computed from the identifier
// alone would collide differently from the wheel every other surface reads and put two
// people on one colour in one window and not in the next. `assignmentFor` READS and
// never allocates: an identity the wheel has not admitted answers `undefined`, which
// the line draws as the neutral boundary rather than as somebody else's colour.
//
// WHY THE SUBSCRIPTION IS `initialised` AND NOT THE WHEEL ITSELF. The wheel is a side
// table on the store rather than part of its immutable state, so no selector can
// return an assignment as a stored reference — and the console admits exactly one
// selector-shaped read of a session store, so reaching for `useSyncExternalStore` to
// watch the allocator would be the second subscription path that rule exists to
// prevent. What IS on the state is the flip this depends on: the whole join log is
// admitted to the wheel inside `initialise`, in the same act that sets `initialised`,
// so re-reading on that transition is re-reading at the one moment that fills the
// wheel for every participant the session opened with. A later admission — a
// participant who joins while this page is open — reaches the mark on the block's
// next render, which the roster seam pushes on every re-read; until then the holder
// draws neutral, which is the same fail-closed shape as an identity the wheel has
// genuinely never seen.

import { useMemo, type ReactNode } from "react";

import type { ParticipantId } from "@ai-sidekicks/contracts";

import { useSessionInitialised, type SessionStore } from "../../../store/index.js";
import { ControlHolderLine } from "./ControlHolderLine.js";

export function HeldControlHolderLine(props: {
  readonly participantId: ParticipantId;
  readonly sessionStore: SessionStore;
}): ReactNode {
  const sessionInitialised = useSessionInitialised(props.sessionStore);
  const hueAllocator = props.sessionStore.hueAllocator;
  const hueAssignment = useMemo(
    () => (sessionInitialised ? hueAllocator.assignmentFor(props.participantId) : undefined),
    [hueAllocator, props.participantId, sessionInitialised],
  );

  return (
    <ControlHolderLine
      reading={{ kind: "held", participantId: props.participantId }}
      hueAssignment={hueAssignment}
    />
  );
}
