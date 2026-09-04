// The React binding for the reveal engine: one engine per feed, and what a view
// reads it through.
//
// `reveal-engine.ts` holds the mechanism — the ordered queue, the per-frame budget
// split across lanes, the rope smoother, the checkpoint tail. This module holds the
// React side of it, on `viewport-binding.ts`' split and for the same reason: the
// engine arms work through the clock seam and knows nothing about renders, and a
// tree that has to repaint when a lane moves needs a notification the engine does
// not owe it.
//
// THREE THINGS THIS BINDING IS RESPONSIBLE FOR:
//
//   • **Ownership.** One engine per feed, minted once and disposed when the feed
//     unmounts, with the re-mint arm `viewport-binding.ts` takes for its own
//     controller — a remount of the same component instance has already run the
//     cleanup, and a disposed engine ingests nothing, so the second mount takes a
//     fresh one rather than a corpse.
//   • **The notification.** A drained frame bumps a revision, which is what makes the
//     feed render; the row bodies then read their own lane through the channel and
//     React's own snapshot comparison decides which of them actually repaints. An
//     ingest bumps it too, because arming a frame is the transition that turns the
//     drain state on and no frame has drained yet to report it.
//   • **Retirement.** A lane whose row the window no longer holds live is dropped, so
//     a finished turn stops costing memory. The predicate is asked of the ENGINE's
//     own lanes rather than of the window's rows: the engine holds at most one lane
//     per streaming row, and walking the window instead would be a pass over the
//     whole log per event.
//
// WHAT FEEDS IT, STATED RATHER THAN INVENTED. A delta carries a body, and no wire
// this console holds carries one: `assistant.*` and `tool.*` payloads are `.strict()`
// over a media type and a byte length, and the body itself is sealed in the daemon's
// own encrypted column behind a read no bridge namespace serves. That read is the
// growth slate's `hydrated-event-read` row, and it is what will call `ingest`. Until
// it lands the engine holds no lane, publishes no text, and reports `isDraining`
// false — which is now a READING of a mounted scheduler rather than the literal the
// feed used to hand the viewport in its place.

import { useCallback, useEffect, useMemo, useState } from "react";

import { type ConsoleClock } from "../../core/index.js";
import { RevealEngine } from "./reveal-engine.js";
import { type LedgerRowRevealChannel } from "./RowRevealProvider.js";
import { type RevealDelta } from "./reveal-vocabulary.js";

/** What a view gets back: the channel its rows read, the drain state, and the acts. */
export interface LedgerRevealBinding {
  /**
   * The channel handed to `LedgerRowRevealProvider`. Stable for the engine's life, so
   * publishing it re-renders no row body on its own.
   */
  readonly channel: LedgerRowRevealChannel;
  /** True while a frame is armed. The viewport defers prune on it. */
  readonly isDraining: boolean;
  /** Take one lane's delta. See this file's header on what will call this. */
  readonly ingest: (delta: RevealDelta) => void;
  /** Drop every lane the predicate names. Asked once per window change. */
  readonly retireLanes: (shouldRetire: (laneId: string) => boolean) => void;
}

export interface UseLedgerRevealOptions {
  /**
   * The clock every frame in this engine is armed through. Fixed for the mount: an
   * engine that swapped clocks mid-life would have work armed on one and cancelled
   * on another.
   */
  readonly clock: ConsoleClock;
}

/** Mint one reveal engine for a feed, and bind it to the tree. */
export function useLedgerReveal(options: UseLedgerRevealOptions): LedgerRevealBinding {
  const { clock } = options;
  const [engine, setEngine] = useState<RevealEngine>(() => new RevealEngine({ clock }));
  // The engine owns its own state and is not React state; the revision is how the
  // tree finds out it moved. Nothing renders the number — see `viewport-binding.ts`'
  // lease revision, which is the same idiom for the same reason.
  const [frameRevision, setFrameRevision] = useState(0);

  useEffect(() => {
    if (engine.isDisposed) {
      setEngine(new RevealEngine({ clock }));
      return;
    }
    return () => {
      engine.dispose();
    };
  }, [engine, clock]);

  useEffect(
    () =>
      engine.subscribe(() => {
        setFrameRevision((current) => current + 1);
      }),
    [engine],
  );

  const channel = useMemo<LedgerRowRevealChannel>(
    () => ({
      publishedTextFor: (laneId: string) => {
        const published = engine.publishedText(laneId);
        return published === "" ? undefined : published;
      },
      subscribe: (sink: () => void) =>
        engine.subscribe(() => {
          sink();
        }),
    }),
    [engine],
  );

  // Read here rather than ignored: this render happened because a frame drained or a
  // delta armed one, and the drain state below is what that render is for.
  void frameRevision;

  return {
    channel,
    isDraining: engine.isDraining,
    ingest: useCallback(
      (delta: RevealDelta) => {
        engine.ingest(delta);
        // Arming is a state change no frame has reported yet: without this the
        // viewport would not see the drain until the frame that ends it.
        setFrameRevision((current) => current + 1);
      },
      [engine],
    ),
    retireLanes: useCallback(
      (shouldRetire: (laneId: string) => boolean) => {
        for (const lane of engine.lanes()) {
          if (shouldRetire(lane.laneId)) {
            engine.retireLane(lane.laneId);
          }
        }
      },
      [engine],
    ),
  };
}
