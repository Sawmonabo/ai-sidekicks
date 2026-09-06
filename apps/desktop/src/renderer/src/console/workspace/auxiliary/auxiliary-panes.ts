// The hand-off, wired: what the deck is told about panes that are in windows.
//
// ITS OWN MODULE BECAUSE IT IS A DIFFERENT SUBJECT FROM THE ARRANGEMENT. `Workspace.tsx`
// composes a cast bar, a deck, a sidebar and a composer, and owns the split between
// them. This file owns one thing: the lifecycle of `AuxiliaryHandoff` inside a
// surface — constructing it, following what it publishes, opening and closing the
// crashed-window signal with the detached set, and turning the four acts a slot
// offers into calls. Neither half reads the other's state, which is why the cut is
// here rather than at a line count.
//
// WHAT IT PUBLISHES, AND WHY THE TWO SETS NEVER OVERLAP. A pane whose body is in a
// window of its own is in `paneIds`; a pane whose window was LOST is not — its body
// is back in the deck — and carries a notice instead. One slot renders both, so a
// pane in both sets would be a slot asked to draw a placeholder and a crash note for
// the same moment. The hand-off is what keeps them disjoint, and this module reads
// them from it rather than deriving either.

import { useCallback, useEffect, useState } from "react";

import { type ConsoleBridge } from "../../bridge/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import { useSubjectScopedResource, type SubjectScopedDisposal } from "../../store/index.js";
import {
  lostWindowNotice,
  refuseHandoffFromRejection,
  type AuxiliaryHandoffRefusal,
} from "./aux-handoff-contract.js";
import { AuxiliaryHandoff } from "./aux-handoff.js";
import type { DeckPane } from "../deck/deck-model.js";

/**
 * No pane is carrying a crash note, once.
 *
 * A fresh empty `Map` per read would give the deck a new prop identity on every
 * publish — and the deck's slots are memoised precisely so a four-lane session does
 * not re-render four pane bodies for one event.
 */
const NO_LOST_WINDOW_NOTICES: ReadonlyMap<string, ConsoleRefusal> = new Map();

/**
 * What a retired hand-off gives back: the crashed-window subscription, and nothing else.
 *
 * THE RELEASING ARM, BECAUSE THE HAND-OFF SURVIVES ITS OWN DISPOSAL. Stopping the
 * watch is what `watchPaneErrors` restarts when the next pane goes into a window, so
 * there is no closed state to read and no way for the holder to be handed a corpse —
 * which is exactly what the two arms distinguish, and why supplying a reading here
 * would be a claim about a lifetime that does not end.
 *
 * Declared once at module scope rather than minted per render — the hook holds the
 * disposal on a dependency of its own, so a fresh literal every pass would be churn
 * and never a lifetime.
 */
const HANDOFF_DISPOSAL: SubjectScopedDisposal<AuxiliaryHandoff> = {
  release: (retired) => {
    retired.stopWatchingPaneErrors();
  },
};

/** Which panes are showing in windows of their own, and what the signal refused. */
export interface DetachedPaneProjection {
  readonly paneIds: readonly string[];
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
  readonly bridge: ConsoleBridge;
  readonly sessionId: string | undefined;
  readonly onRefused: (refusal: ConsoleRefusal) => void;
}): AuxiliaryPaneWiring {
  const { bridge, onRefused, sessionId } = options;
  // THE BRIDGE IS THE SUBJECT, not a value a mount-lifetime cell captured once. A
  // hand-off holds a subscription opened over one bridge's growth port, so a
  // scenario switch that replaces the bridge has to retire it: a cell seeded on the
  // first render would keep plumbing the retired resolution, and the watch it holds
  // would go on draining a signal nothing reads.
  const { value: handoff } = useSubjectScopedResource(
    bridge,
    undefined,
    () => new AuxiliaryHandoff({ growth: bridge.growth }),
    HANDOFF_DISPOSAL,
  );
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
 * Follow the hand-off's published state, and watch the crashed-window signal while
 * something is detached.
 *
 * The signal is opened on the first detach and closed when the last pane comes back,
 * rather than held for the surface's lifetime: a subscription over an empty set can
 * report nothing, and its refusal would sit on screen as a permanent notice about a
 * hazard this window does not currently have.
 */
function useDetachedPanes(handoff: AuxiliaryHandoff): DetachedPaneProjection {
  const [projection, setProjection] = useState<DetachedPaneProjection>({
    paneIds: [],
    signalRefusal: undefined,
    lostWindowNoticesByPaneId: NO_LOST_WINDOW_NOTICES,
  });

  useEffect(() => {
    const read = (): void => {
      const lost = handoff.lostWindows();
      setProjection({
        paneIds: handoff.detached().map((pane) => pane.paneId),
        signalRefusal: handoff.paneErrorRefusal,
        lostWindowNoticesByPaneId:
          lost.length === 0
            ? NO_LOST_WINDOW_NOTICES
            : new Map(lost.map((window) => [window.paneId, lostWindowNotice(window)])),
      });
    };
    const unsubscribe = handoff.subscribe(read);
    read();
    // The watch itself is NOT stopped here: it is the resource's own disposal, run
    // by `HANDOFF_DISPOSAL` whether this hand-off is retired by a bridge that moved
    // or by the surface unmounting. Stopping it here too would be a second place
    // that decides when a subscription ends.
    return unsubscribe;
  }, [handoff]);

  const hasDetachedPane = projection.paneIds.length > 0;
  useEffect(() => {
    if (!hasDetachedPane) {
      handoff.stopWatchingPaneErrors();
      return;
    }
    // No arm here, and that is the design rather than the omission this used to be:
    // the watch installs from an effect with no surface to refuse into, so it settles
    // its own failures into the placeholder's refusal slot and resolves either way.
    // An arm on a promise that cannot reject would be a branch nothing can reach.
    void handoff.watchPaneErrors();
  }, [handoff, hasDetachedPane]);

  return projection;
}
