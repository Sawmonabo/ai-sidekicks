// Every window this feed derives, in the one order they may be derived in: the unfurled
// projection, the run-group fold, and the part the viewport reconciled onto the screen. Each
// stage publishes the rows it removed, since re-deriving the difference downstream re-walked the
// projection on every append. The one viewport binding and reveal engine are minted here.

import { useEffect } from "react";

import { transcriptWindowDiagnostics } from "@renderer/lib/transcript-window-diagnostics.js";
import { type Clock } from "@renderer/lib/clock.js";
import { useAnimationFrameCoordinator } from "../../hooks/useAnimationFrameCoordinator.js";
import { useReveal, type RevealBinding } from "../../reveal/hooks/useReveal.js";
import {
  useTranscriptViewport,
  type TranscriptViewportBinding,
} from "../../viewport/hooks/useTranscriptViewport.js";
import { useDuplicateRowKeyCapture } from "../../viewport/hooks/useDuplicateRowKeyCapture.js";
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
  readonly clock: Clock;
}

/**
 * The chain, with every stage's own report beside it. Published as separate members because find
 * classifies an id against every stage to say which one removed a row, while the rows render the
 * folded one.
 */
export interface TranscriptFeedWindows {
  readonly firstReadSettled: boolean;
  readonly runGroupDisclosure: RunGroupDisclosure;
  /** Every member row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  readonly runGroupFold: TranscriptPipelineStage;
  /** The last model window: folded by run group. */
  readonly transcriptWindow: TranscriptWindowModel;
  readonly reveal: RevealBinding;
  readonly viewport: TranscriptViewportBinding;
  /** What the viewport reconciled onto the screen, with both absences separable. */
  readonly visible: VisibleTranscriptWindow;
}

/** Derive every window this feed draws from, in the one order they may be derived in. */
export function useTranscriptFeedWindows(
  inputs: TranscriptFeedWindowsInputs,
): TranscriptFeedWindows {
  // The same reading `TranscriptWindowSkeleton` draws from, so the empty sentence and the
  // skeleton rows cannot both be on screen.
  const firstReadSettled = useTranscriptFirstReadSettled(inputs.sessionStore);
  // Which finished run groups a person has opened is a fact about who is reading, so it is held
  // here and handed to the derivation rather than folded into it.
  const runGroupDisclosure = useRunGroupDisclosure(inputs.sessionStore.sessionId);
  const unfurledWindow = useTranscriptProjection(inputs.sessionStore);
  const runGroupFold = useFoldedRunGroups(
    unfurledWindow,
    runGroupDisclosure.openedTerminalRunIds,
    inputs.sessionStore.sessionId,
  );
  const transcriptWindow = runGroupFold.window;
  // The reveal engine is this feed's, minted once and disposed with it; its drain state reaches
  // the viewport. The frame coordinator is minted above both holders so one object orders the
  // paint: the reveal drain runs in its second phase, while the viewport writes `scrollTop` at
  // once and submits nothing to the first.
  const frameCoordinator = useAnimationFrameCoordinator(inputs.clock);
  const reveal = useReveal({ frameCoordinator, clock: inputs.clock });
  const viewport = useTranscriptViewport({
    clock: inputs.clock,
    rows: transcriptWindow.viewportRows,
    hasActiveTurn: transcriptWindow.hasActiveTurn,
    isRevealDraining: reveal.isDraining,
  });

  // Registered here, where the session id and the one binding meet, so the session diagnostics a
  // driver process reads can tell a transcript that mounted nothing from one with nothing to
  // mount. The reader is stable, so this registers once per mount rather than once per render.
  const readWindowDiagnostics = viewport.readWindowDiagnostics;
  const diagnosticsSessionId = inputs.sessionStore.sessionId;
  useEffect(
    () => transcriptWindowDiagnostics.register(diagnosticsSessionId, readWindowDiagnostics),
    [diagnosticsSessionId, readWindowDiagnostics],
  );
  useDuplicateRowKeyCapture(
    diagnosticsSessionId,
    viewport.snapshot.keyProjection.duplicateKeyCount,
    inputs.clock,
  );

  // A lane whose row this window no longer holds, or holds only inside a terminal run group, is
  // a turn that is over, so the engine drops it. Asked of the engine's own lanes (at most one
  // per streaming row) rather than walking the whole log on every event.
  const retireRevealLanes = reveal.retireLanes;
  useEffect(() => {
    retireRevealLanes(
      (laneId) =>
        !transcriptWindow.rowsByKey.has(laneId) || transcriptWindow.collapsedRowIds.has(laneId),
    );
  }, [retireRevealLanes, transcriptWindow]);

  // Read back off the viewport's reconciled snapshot, so find sees the window on screen; what
  // the cap took is the difference between the two.
  const visible = useVisibleTranscriptWindow(transcriptWindow, viewport.snapshot.rows);

  return {
    firstReadSettled,
    runGroupDisclosure,
    unfurledWindow,
    runGroupFold,
    transcriptWindow,
    reveal,
    viewport,
    visible,
  };
}
