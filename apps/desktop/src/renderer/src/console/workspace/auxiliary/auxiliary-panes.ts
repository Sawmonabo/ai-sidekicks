// The hand-off, wired: what the deck is told about panes that are in windows.
//
// ITS OWN MODULE BECAUSE IT IS A DIFFERENT SUBJECT FROM THE ARRANGEMENT. `Workspace.tsx`
// composes a cast bar, a deck, a sidebar and a composer, and owns the split between
// them. This file owns one thing: the lifecycle of `AuxiliaryHandoff` inside a
// surface — constructing it, following what it publishes, opening and closing the
// window signals with the detached set, and turning the four acts a slot offers into
// calls. Neither half reads the other's state, which is why the cut is here rather
// than at a line count.
//
// AND IT NO LONGER OWNS THE HAND-OFF'S LIFE, WHICH IS THE HALF THAT MOVED. A surface
// is unmounted the moment a route leaves it, and a pane that is in a window of its own
// is still in one — so a hand-off held for this mount lost its detached set on every
// navigation while the shell kept the windows open. The registry lives at the window's
// lifetime on the frame-binding seat (`DetachedPaneBinding.tsx`), this module RESOLVES
// one from it by session, and the two subscriptions are the hand-off's own —
// `aux-handoff.ts` opens them before it asks for a window and closes them when its
// last pane comes back, which a reader of the published projection could only ever do
// one commit late.
//
// SO THE HAND-OFF IS READ AS AN EXTERNAL STORE AND NOT COPIED INTO STATE. It survives
// this mount, which means a surface remounting for a session that already has panes in
// windows is reading a record that is ALREADY there — and a projection seeded empty and
// corrected by a passive effect painted that pane's BODY in the deck for one committed
// frame while its own auxiliary window drew the same pane. `useSyncExternalStore` reads
// it during the render instead, so the first frame is already right; the hand-off holds
// its published snapshot by identity, which is what makes that read settle.
//
// WHAT IT PUBLISHES, AND WHY THE TWO SETS NEVER OVERLAP. A pane whose body is in a
// window of its own is in `paneIds`; a pane whose window was LOST is not — its body
// is back in the deck — and carries a notice instead. One slot renders both, so a
// pane in both sets would be a slot asked to draw a placeholder and a crash note for
// the same moment. The hand-off is what keeps them disjoint, and this module reads
// them from it rather than deriving either.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { type ConsoleRefusal } from "../../core/index.js";
import {
  lostWindowNotice,
  refuseHandoffFromRejection,
  type AuxiliaryHandoffRefusal,
  type AuxiliaryHandoffSnapshot,
} from "./aux-handoff-contract.js";
import { type AuxiliaryHandoff } from "./aux-handoff.js";
import { useAuxiliaryHandoffRegistry } from "./DetachedPaneBinding.js";
import type { DeckPane } from "../deck/deck-model.js";

/**
 * No pane is carrying a crash note, once.
 *
 * A fresh empty `Map` per read would give the deck a new prop identity on every
 * publish — and the deck's slots are memoised precisely so a four-lane session does
 * not re-render four pane bodies for one event.
 */
const NO_LOST_WINDOW_NOTICES: ReadonlyMap<string, ConsoleRefusal> = new Map();

/** Which panes are showing in windows of their own, and what a signal refused. */
export interface DetachedPaneProjection {
  readonly paneIds: readonly string[];
  /**
   * Why a window signal is not being received, where one is not.
   *
   * ONE SLOT FOR TWO SIGNALS, and the crash signal is read first — not because the
   * return signal matters less, but because the slot renders one line and a window
   * whose crash signal is down loses its pane outright, while one whose return signal
   * is down keeps a placeholder it can still clear by hand. Both are refusals of the
   * same reach, so a second slot would be a second banner about one subsystem.
   */
  readonly signalRefusal: ConsoleRefusal | undefined;
  /**
   * The crash note each returned pane carries, by pane id.
   *
   * A pane in here is NOT in `paneIds` — its body is back in the deck. The two are
   * read together because one slot renders both: the placeholder while the window is
   * open, and the note about the window that stopped being open.
   */
  readonly lostWindowNoticesByPaneId: ReadonlyMap<string, ConsoleRefusal>;
}

/** Everything a deck needs from the hand-off: what to draw, and what it may do. */
export interface AuxiliaryPaneWiring extends DetachedPaneProjection {
  readonly openInWindow: (pane: DeckPane) => void;
  readonly focusWindow: (paneId: string) => void;
  readonly returnToDeck: (paneId: string) => void;
  readonly dismissLostWindow: (paneId: string) => void;
}

/**
 * Hold the hand-off for one surface, follow it, and offer its four acts.
 *
 * The refusals a detach or a focus produces change what the whole surface can do, so
 * they are raised to the caller rather than rendered here — `Spec-023 §Meridian, the
 * design language` puts a refusal of that reach in a banner across the workspace, and
 * this module renders nothing.
 */
export function useAuxiliaryPanes(options: {
  readonly sessionId: string | undefined;
  readonly onRefused: (refusal: ConsoleRefusal) => void;
}): AuxiliaryPaneWiring {
  const { onRefused, sessionId } = options;
  // RESOLVED, NEVER CONSTRUCTED. The registry is the window's and its subject is the
  // bridge — a scenario switch that replaces the transport retires the whole registry,
  // which is where that reasoning belongs — and this surface asks it for the hand-off
  // for the session it is a view of. A hand-off minted here instead would be one per
  // mount, which is the state every navigation used to throw away.
  const handoff = useAuxiliaryHandoffRegistry().handoffFor(sessionId);
  const projection = useDetachedPanes(handoff);

  // Every act below is dispatched from an event handler, so a promise that rejects
  // reaches nobody: no refusal renders, the control answers the press by doing
  // nothing, and the fault surfaces only as an unhandled rejection a shipped window
  // never reports. The hand-off settles its own wire calls into refusals, so this arm
  // is the backstop for a defect rather than the wire path — and a defect a person
  // sees stated is strictly better than one nothing records.
  const stateRefusal = useCallback(
    (refusal: AuxiliaryHandoffRefusal | undefined) => {
      if (refusal !== undefined) {
        onRefused(refusal);
      }
    },
    [onRefused],
  );
  const stateRejection = useCallback(
    (rejection: unknown) => {
      onRefused(refuseHandoffFromRejection(rejection));
    },
    [onRefused],
  );

  const openInWindow = useCallback(
    (pane: DeckPane) => {
      void handoff
        .detach({
          paneId: pane.paneId,
          kind: pane.kind,
          sessionId,
          ...(pane.entity?.kind === "agent" ? { agentId: pane.entity.id } : {}),
        })
        .then((outcome) => {
          if (outcome.outcome === "refused") {
            onRefused(outcome.refusal);
          }
          // The pane STAYS, with its body suppressed. `Spec-023 §The surface set`
          // keeps the slot as a placeholder rather than closing it: a closed pane
          // loses its width and its position, and the window closing would then have
          // nowhere to put the pane back.
        }, stateRejection);
    },
    [handoff, onRefused, sessionId, stateRejection],
  );

  const focusWindow = useCallback(
    (paneId: string) => {
      void handoff.focus(paneId).then(stateRefusal, stateRejection);
    },
    [handoff, stateRefusal, stateRejection],
  );

  const returnToDeck = useCallback(
    (paneId: string) => {
      void handoff.returnToDeck(paneId).then(stateRefusal, stateRejection);
    },
    [handoff, stateRefusal, stateRejection],
  );

  const dismissLostWindow = useCallback(
    (paneId: string) => {
      handoff.dismissLostWindow(paneId);
    },
    [handoff],
  );

  return { ...projection, openInWindow, focusWindow, returnToDeck, dismissLostWindow };
}

/**
 * Follow the hand-off's published state.
 *
 * READ-ONLY OVER A LIFETIME IT DOES NOT OWN, and read DURING THE RENDER. The hand-off
 * may already be holding detached panes when this surface mounts — that is what the
 * window-lifetime registry buys — so the opening value has to be the record as it
 * stands rather than an empty one a passive effect corrects a frame later.
 *
 * The watches are NOT opened or closed here, and that is a rule rather than an
 * omission. They are the hand-off's own — opened before it asks the shell for a window,
 * closed in the same act that empties its records — so nothing decides a subscription's
 * life from a projection that is always one commit behind the act.
 */
function useDetachedPanes(handoff: AuxiliaryHandoff): DetachedPaneProjection {
  const subscribe = useCallback(
    (onStoreChange: () => void) => handoff.subscribe(onStoreChange),
    [handoff],
  );
  const readSnapshot = useCallback(() => handoff.snapshot, [handoff]);
  const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  // Keyed on the snapshot rather than run per render, so the deck's memoised slots are
  // handed one projection identity for as long as the hand-off has not moved.
  return useMemo(() => projectDetachedPanes(snapshot), [snapshot]);
}

/**
 * One published snapshot, as the deck reads it.
 *
 * WHERE THE TWO SIGNAL REFUSALS ARE FUSED, and the choice is stated on
 * {@link DetachedPaneProjection.signalRefusal}: the hand-off publishes both and this is
 * the one line that renders one of them.
 */
function projectDetachedPanes(snapshot: AuxiliaryHandoffSnapshot): DetachedPaneProjection {
  return {
    paneIds: snapshot.detached.map((pane) => pane.paneId),
    signalRefusal: snapshot.paneErrorRefusal ?? snapshot.paneReturnRefusal,
    lostWindowNoticesByPaneId:
      snapshot.lostWindows.length === 0
        ? NO_LOST_WINDOW_NOTICES
        : new Map(snapshot.lostWindows.map((window) => [window.paneId, lostWindowNotice(window)])),
  };
}
