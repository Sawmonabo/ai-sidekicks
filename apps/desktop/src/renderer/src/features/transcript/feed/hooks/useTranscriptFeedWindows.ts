// Every window this feed derives, in the one order they may be derived in.
//
// WHAT THIS MODULE OWNS. A transcript pane holds a chain of windows, not one: the whole
// unfurled projection, that projection with finished run groups folded, and finally the
// part the viewport reconciled onto the screen. Each stage is somebody else's derivation
// — `transcript-window.ts`', `run-group-fold.ts`', `useTranscriptViewport.ts`',
// `useVisibleTranscriptWindow.ts`' — and what this module adds is the ORDER and nothing
// else. It folds no log, measures no row and writes no `scrollTop`.
//
// AND WHY EACH STAGE'S OWN REPORT LEAVES WITH IT. The counts beside the find
// field are made of exactly these separations — a match the cap took and one a folded
// chapter holds are two states with two different exits — so the stage that removed
// the rows is the one that publishes them.
// Re-deriving the difference downstream re-walked the whole projection on every
// appended row for as long as a query sat in the field.
//
// WHY THE VIEWPORT BINDING IS DERIVED HERE RATHER THAN BESIDE THE ARRANGEMENT. The
// last window in the chain is read back off the viewport's own reconciled snapshot,
// so find looks at what is on screen rather than at the log behind it — which puts
// the binding INSIDE the chain rather than downstream of it. There is exactly one
// binding, minted here: a second one would leave the find walk reading a virtualizer
// with no element under it, which is a jump that reports success and scrolls
// nothing. The reveal engine is minted here for the same reason
// in a different register — a lane is a row of THIS window, so a second engine would
// publish a second answer for one row's text — and it is disposed with the mount
// that holds this chain.

import { useEffect } from "react";

import { consoleLedgerWindows } from "@renderer/lib/transcript-window-diagnostics.js";
import { type ConsoleClock } from "@renderer/lib/clock.js";
import { useLedgerFrameCoordinator } from "../../hooks/useAnimationFrameCoordinator.js";
import { useLedgerReveal, type RevealBinding } from "../../reveal/hooks/useReveal.js";
import {
  useTranscriptViewport,
  type TranscriptViewportBinding,
} from "../../viewport/hooks/useTranscriptViewport.js";
import { useTranscriptFirstReadSettled } from "../../window/hooks/useTranscriptFirstReadSettled.js";
import { useTranscriptProjection } from "../../window/hooks/useTranscriptProjection.js";
import {
  useVisibleTranscriptWindow,
  type VisibleTranscriptWindow,
} from "../../window/hooks/useVisibleTranscriptWindow.js";
import {
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type RunGroupDisclosure } from "../run-group-fold.js";
import { useFoldedRunGroups } from "./useFoldedRunGroups.js";
import { useRunGroupDisclosure } from "./useRunGroupDisclosure.js";

/** What the window chain is derived from: the session's store and the frame's clock. */
export interface TranscriptFeedWindowsInputs {
  readonly sessionStore: SessionStore;
  /** The frame coordinator's clock, minted once by the mount that holds this chain. */
  readonly clock: ConsoleClock;
}

/**
 * The chain, with every stage's own report beside it.
 *
 * Published as separate members rather than as the last window alone, because the
 * surfaces above read from two different points in it: find classifies an id against
 * every stage to say WHICH one is the reason a row is not on screen, and the rows
 * render the folded one.
 */
export interface TranscriptFeedWindows {
  readonly firstReadSettled: boolean;
  readonly chapterDisclosure: RunGroupDisclosure;
  /** Every member row of every chapter, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  readonly chapterFold: TranscriptPipelineStage;
  /** The last model window: chapter-folded. */
  readonly ledgerWindow: TranscriptWindowModel;
  readonly reveal: RevealBinding;
  readonly viewport: TranscriptViewportBinding;
  /** What the viewport reconciled onto the screen, with both absences separable. */
  readonly visible: VisibleTranscriptWindow;
}

/** Derive every window this feed draws from, in the one order they may be derived in. */
export function useTranscriptFeedWindows(
  inputs: TranscriptFeedWindowsInputs,
): TranscriptFeedWindows {
  // The same reading `<TranscriptReadState>` draws its shells from, so the empty
  // sentence and the loading shells cannot both be on screen.
  const firstReadSettled = useTranscriptFirstReadSettled(inputs.sessionStore);
  // The fold is the MOUNT's, not the log's: which finished chapters a person has
  // opened is a fact about who is reading, so it is held here and handed to the
  // derivation rather than folded into it.
  const chapterDisclosure = useRunGroupDisclosure(inputs.sessionStore.sessionId);
  // THE UNFURLED PROJECTION — every member row of every chapter, before any fold.
  const unfurledWindow = useTranscriptProjection(inputs.sessionStore);
  const chapterFold = useFoldedRunGroups(
    unfurledWindow,
    chapterDisclosure.openedTerminalRunIds,
    inputs.sessionStore.sessionId,
  );
  const ledgerWindow = chapterFold.window;
  // THE REVEAL ENGINE IS THIS FEED'S, minted once and disposed with it. What it
  // publishes reaches a row through the frame's own channel; what it is DOING reaches
  // the viewport as the drain state, which used to be the literal `false` — a default
  // standing in for a reading of a scheduler nothing had mounted.
  // THE FRAME IS MINTED HERE, above both holders, because that is the only place one
  // object can order the whole paint: phase one is the viewport's scroll writes and
  // phase two is the reveal drain, and a coordinator minted inside either would order
  // that half against nothing.
  const frameCoordinator = useLedgerFrameCoordinator(inputs.clock);
  const reveal = useLedgerReveal({ frameCoordinator });
  const viewport = useTranscriptViewport({
    clock: inputs.clock,
    rows: ledgerWindow.viewportRows,
    hasActiveTurn: ledgerWindow.hasActiveTurn,
    isRevealDraining: reveal.isDraining,
  });

  // WHAT THIS WINDOW IS SHOWING, PUBLISHED FOR A DRIVER PROCESS TO READ. Registered
  // here because this is where the session id and the one binding meet. The reading
  // exists for the endurance tier, which drives a real window from outside the
  // renderer and can otherwise tell "the ledger mounted nothing" from "the ledger has
  // nothing to mount" only by guessing; it reaches the page only through the session
  // diagnostics a fixture composition installs. The reader is stable, so this registers
  // once per mount rather than once per render.
  const readWindowDiagnostics = viewport.readWindowDiagnostics;
  const diagnosticsSessionId = inputs.sessionStore.sessionId;
  useEffect(
    () => consoleLedgerWindows.register(diagnosticsSessionId, readWindowDiagnostics),
    [diagnosticsSessionId, readWindowDiagnostics],
  );

  // A lane whose row this window no longer holds, or holds only inside a chapter that
  // has reached its terminal, is a turn that is over: the engine drops it so a
  // finished lane stops costing memory. Asked of the engine's own lanes, which are at
  // most one per streaming row — walking the window instead would be a pass over the
  // whole log on every event.
  const retireRevealLanes = reveal.retireLanes;
  useEffect(() => {
    retireRevealLanes(
      (laneId) => !ledgerWindow.rowsByKey.has(laneId) || ledgerWindow.collapsedRowIds.has(laneId),
    );
  }, [retireRevealLanes, ledgerWindow]);

  // Read back off the viewport's own reconciled snapshot, so find is looking at the
  // window on screen rather than at the log behind it. What the cap took is the
  // difference between the two.
  const visible = useVisibleTranscriptWindow(ledgerWindow, viewport.snapshot.rows);

  return {
    firstReadSettled,
    chapterDisclosure,
    unfurledWindow,
    chapterFold,
    ledgerWindow,
    reveal,
    viewport,
    visible,
  };
}
