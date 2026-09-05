// The workspace's follow seat, filled by whichever ledger is mounted.
//
// SPLIT FROM THE PALETTE'S ACTS, which share this module's shape and not its
// subject. Both resolve their target at ACT time because the caller is composed long
// before any feed exists — but the palette's nine acts are values over state the feed
// already holds, driven with no render at all, while this is a REGISTRATION with a
// lifetime: a seat claimed on mount, released on unmount, and read from outside React
// at any moment in between. The two answer different questions and their cases ask
// different things of a renderer, so they are two modules and two suites.

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { type TimelineRow } from "@ai-sidekicks/contracts";

import {
  actorFollowHandler,
  registerActorFollowHandler,
  unregisterActorFollowHandler,
  type ActorFollowHandler,
  type ActorFollowOutcome,
  type ActorFollowRequest,
} from "../../seats/index.js";

/** What the follow handler resolves a request against. */
export interface ActorFollowInputs {
  /** The rows the viewport holds — the only rows a jump can arrive at. */
  readonly visibleRows: readonly TimelineRow[];
  readonly jumpToRow: (rowId: string) => void;
}

/**
 * Resolve a cast chip's follow request against this window's own rows.
 *
 * The request carries a wire `sequence` rather than a row id, because row identity
 * is minted by this family's projection and the workspace holds none of it. So the
 * resolution is a lookup over the VISIBLE rows — not the loaded log — for the
 * reason find's walk is: `jumpToRow` scrolls to what the viewport reconciled, and a
 * row the cap has taken out would report a reveal and move nothing.
 *
 * The participant id is deliberately not re-checked against the row. The workspace
 * resolved this sequence from that participant's newest event over the same log,
 * and asking the projection to agree would be a second derivation of attribution —
 * which is exactly what the seat exists to keep out of two families at once.
 */
export function buildActorFollowHandler(inputs: ActorFollowInputs): ActorFollowHandler {
  return (request: ActorFollowRequest): ActorFollowOutcome => {
    const row = inputs.visibleRows.find(
      (candidate) => candidate.sequence === request.newestSequence,
    );
    if (row === undefined) {
      return "row-not-in-view";
    }
    inputs.jumpToRow(row.id);
    return "revealed";
  };
}

/** The owner string the ledger's follow claim carries, on `registerLedger`'s terms. */
const LEDGER_FOLLOW_SEAT_OWNER = "ledger";

/**
 * Fill the workspace's follow seat for as long as the feed is mounted.
 *
 * The registered handler reads the live inputs through a ref rather than being
 * re-registered whenever the window moves — `useMountedLedger`'s shape, for its
 * reason: a feed rebuilds its callbacks on every render, and a seat re-claimed on
 * each pass would churn a registry whose whole job is to hold one occupant.
 *
 * AND THE REF IS WRITTEN FROM THE LAYOUT PHASE, NEVER FROM THE RENDER BODY. The
 * usual justification for a render-phase ref write — "it is only read from an effect,
 * which runs after commit" — is false here, and that is the whole reason this hook is
 * written the way it is. The reader is a MODULE-SCOPE REGISTRY the command palette
 * invokes at any moment, including the moment between a render pass React began and
 * the commit that never came for it. A pass React discards still runs the render
 * body, so a body-written ref would leave the seat resolving a window that never
 * reached the screen: the palette's "follow this actor" would scroll against rows the
 * viewport is not showing, and report that it revealed one. Written from a layout
 * effect, only a COMMITTED window is ever visible to the seat.
 *
 * Release is CONDITIONAL, unlike the palette seat's, because this seat's own
 * release takes no argument: a feed unmounting after a second one had claimed the
 * seat would otherwise empty it under the ledger still on screen.
 */
export function useActorFollowSeat(inputs: ActorFollowInputs): void {
  const committedInputsRef = useRef(inputs);
  useLayoutEffect(() => {
    committedInputsRef.current = inputs;
  });
  const forwarding = useMemo<ActorFollowHandler>(
    () => (request) => buildActorFollowHandler(committedInputsRef.current)(request),
    [],
  );
  useEffect(() => {
    registerActorFollowHandler(LEDGER_FOLLOW_SEAT_OWNER, forwarding);
    return () => {
      if (actorFollowHandler() === forwarding) {
        unregisterActorFollowHandler();
      }
    };
  }, [forwarding]);
}
