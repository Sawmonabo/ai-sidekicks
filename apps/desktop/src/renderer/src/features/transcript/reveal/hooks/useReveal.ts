// The React binding for the reveal engine: one per feed, disposed on unmount and re-minted on a
// remount, since a disposed engine ingests nothing. A drained frame or an ingest bumps a
// revision so the feed renders; each row reads its own lane through the channel and React's
// snapshot comparison decides which rows repaint. What the engine reports (a quarantined lane, a
// retracted source) goes to the window's diagnostic capture. The record of what each reply row
// drew is the feed's, so it outlives a re-minted engine.

import { useCallback, useEffect, useMemo, useState } from "react";

import { type Clock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { type AnimationFrameScheduler } from "../../animation-frame-scheduler.js";
import { DrawnReplyText, replyCopyFlavorOf } from "../../copy/drawn-reply-text.js";
import { RevealEngine } from "../engine.js";
import { type RowRevealContextValue } from "../components/RowRevealProvider.js";
import { type RevealDelta } from "../model.js";

/** What a view gets back: the channel its rows read, the drain state, and the acts. */
export interface RevealBinding {
  /**
   * The channel handed to `RowRevealProvider`. Stable for the engine's life, so
   * publishing it re-renders no row body on its own.
   */
  readonly channel: RowRevealContextValue;
  /** True while a frame is armed. The viewport defers prune on it. */
  readonly isDraining: boolean;
  /** Take one lane's delta and arm a frame to reveal it. */
  readonly ingest: (delta: RevealDelta) => void;
  /**
   * Drop every lane `shouldRetire` names, first recording the text of each that `isReplyRow`
   * names, so the reply's foot keeps it. Asked of the engine's own lanes (at most one per
   * streaming row) instead of walking the window's rows on every event.
   */
  readonly retireLanes: (
    shouldRetire: (laneId: string) => boolean,
    isReplyRow: (laneId: string) => boolean,
  ) => void;
  /** Forgets what every row the window no longer holds drew. */
  readonly forgetDrawnTextOutside: (isHeld: (rowId: string) => boolean) => void;
  /**
   * Whether the engine still holds a lane for this row, so the row draws live text that may still
   * grow, until the lane is retired. A map lookup; the same function for the engine's life.
   */
  readonly isRevealing: (rowId: string) => boolean;
  /**
   * Moves whenever `isRevealing` would answer differently for some row: a lane first held or
   * retired. A drained frame leaves it, so a reader keyed on it re-asks once per lane, not per
   * frame.
   */
  readonly laneRevision: number;
}

/** Inputs to `useReveal`. */
export interface UseRevealOptions {
  /**
   * The feed's frame scheduler, which orders every drain. It can be replaced: the feed
   * re-mints it when the window's clock is replaced, and the effect below then re-mints the
   * engine (dropping lane text published so far) rather than submit drains to a scheduler
   * nothing arms.
   */
  readonly frameScheduler: AnimationFrameScheduler;
  /** The clock a diagnostic is stamped with. */
  readonly clock: Clock;
}

/** Mint one reveal engine for a feed, and bind it to the tree. */
export function useReveal(options: UseRevealOptions): RevealBinding {
  const { frameScheduler, clock } = options;
  const [engine, setEngine] = useState<RevealEngine>(() => new RevealEngine({ frameScheduler }));
  const [drawnReplyText] = useState(() => new DrawnReplyText());
  // The engine is not React state; bumping the revision is how the tree learns it moved, so the
  // drain state read below is current. Nothing reads the number itself.
  const [, setFrameRevision] = useState(0);

  useEffect(() => {
    if (engine.isDisposed) {
      setEngine(new RevealEngine({ frameScheduler }));
      return;
    }
    return () => {
      engine.dispose();
    };
  }, [engine, frameScheduler]);

  useEffect(
    () =>
      engine.subscribe(() => {
        setFrameRevision((current) => current + 1);
      }),
    [engine],
  );

  useEffect(
    () =>
      engine.subscribeToDiagnostics((diagnostic) => {
        windowDiagnosticCapture.record({
          at: diagnosticStampAt(clock),
          severity: diagnostic.kind === "transition-failed" ? "error" : "warning",
          source: "features/transcript",
          kind: `reveal-${diagnostic.kind}`,
          detail: `lane ${diagnostic.laneId}: ${diagnostic.detail}`,
        });
      }),
    [engine, clock],
  );

  const channel = useMemo<RowRevealContextValue>(
    () => ({
      publishedTextFor: (laneId: string) => {
        const published = engine.publishedText(laneId);
        return published === undefined || published.length === 0 ? undefined : published;
      },
      drawnReplyText,
      subscribe: (sink: () => void) =>
        engine.subscribe(() => {
          sink();
        }),
    }),
    [engine, drawnReplyText],
  );

  return {
    channel,
    isDraining: engine.isDraining,
    ingest: useCallback(
      (delta: RevealDelta) => {
        engine.ingest(delta);
        // Arming is a state change no frame has reported yet; without this the viewport would
        // not see the drain until the frame that ends it.
        setFrameRevision((current) => current + 1);
      },
      [engine],
    ),
    retireLanes: useCallback(
      (shouldRetire: (laneId: string) => boolean, isReplyRow: (laneId: string) => boolean) => {
        const laneRevision = engine.laneRevision;
        for (const lane of engine.lanes()) {
          if (!shouldRetire(lane.laneId)) {
            continue;
          }
          if (isReplyRow(lane.laneId)) {
            // The lane's own handle, so the record shares the lane's text rather than copying it.
            const text = lane.publishedText;
            drawnReplyText.note(lane.laneId, {
              text,
              // The row's own flavor, where it drew and noted one; the bytes' otherwise.
              flavor: drawnReplyText.drawnTextOf(lane.laneId)?.flavor ?? replyCopyFlavorOf(text),
            });
          }
          engine.retireLane(lane.laneId);
        }
        // Retiring runs in an effect and drains no frame, so nothing else renders the change.
        if (engine.laneRevision !== laneRevision) {
          setFrameRevision((current) => current + 1);
        }
      },
      [engine, drawnReplyText],
    ),
    forgetDrawnTextOutside: useCallback(
      (isHeld: (rowId: string) => boolean) => {
        drawnReplyText.forgetRowsOutside(isHeld);
      },
      [drawnReplyText],
    ),
    isRevealing: useCallback((rowId: string) => engine.holdsLane(rowId), [engine]),
    laneRevision: engine.laneRevision,
  };
}
