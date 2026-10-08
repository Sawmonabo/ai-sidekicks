// Every window this feed derives, in the one order they may be derived in: the unfurled
// projection, the run-group fold, and the rows the feed draws anything for, which the viewport
// holds a window of. The fold publishes the rows it removed, since re-deriving the difference
// downstream re-walked the projection on every append; nothing counts a row the feed never draws,
// so that stage publishes its window alone. The one viewport binding, reveal engine and history
// reader are minted here, since the reader is asked by the viewport and measured in it.

import { useCallback, useEffect } from "react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { transcriptWindowDiagnostics } from "#renderer/lib/transcript-window-diagnostics.js";
import { type Clock } from "#renderer/lib/clock.js";
import { useAnimationFrameScheduler } from "../../hooks/useAnimationFrameScheduler.js";
import { useReveal, type RevealBinding } from "../../reveal/hooks/useReveal.js";
import {
  useTranscriptViewport,
  type TranscriptViewportBinding,
} from "../../viewport/hooks/useTranscriptViewport.js";
import { useDuplicateRowKeyCapture } from "../../viewport/hooks/useDuplicateRowKeyCapture.js";
import { useTranscriptFirstReadSettled } from "../../window/hooks/useTranscriptFirstReadSettled.js";
import { useTranscriptProjection } from "../../window/hooks/useTranscriptProjection.js";
import {
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { useHistoryLookAhead } from "../../history/hooks/useHistoryLookAhead.js";
import { useReleaseOutsideWindow } from "../../history/hooks/useReleaseOutsideWindow.js";
import { useStretchMeasure } from "../../history/hooks/useStretchMeasure.js";
import {
  useTranscriptHistory,
  type TranscriptHistory,
} from "../../history/hooks/useTranscriptHistory.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript-page.js";
import { isDrawnRow } from "../drawn-rows.js";
import { rowBodyLengthOf, rowHeightKindOf } from "../row-height-inputs.js";
import { useFoldedRunGroups } from "./useFoldedRunGroups.js";
import { useDrawnRows } from "./useDrawnRows.js";
import { classifyTranscriptRow } from "../../rows/kind.js";
import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { useMessageAnchorRowKey } from "./useMessageAnchorRowKey.js";
import { useTranscriptFolds, type TranscriptFolds } from "./useTranscriptFolds.js";

/** What the window chain is derived from: the session's store and the frame's clock. */
export interface TranscriptFeedWindowsInputs {
  readonly sessionStore: SessionStore;
  /** The frame scheduler's clock, minted once by the mount that holds this chain. */
  readonly clock: Clock;
  /** The event cursor of the message a link opened the session at, or `undefined` for none. */
  readonly messageAnchorCursor: string | undefined;
  /**
   * The `transcript.read` the history past the store's window is read with. A composition with
   * none offers no history, and the store keeps every row it was given.
   */
  readonly readTranscriptPage: TranscriptPageRead | undefined;
  /** The registered row renderer's answer to whether it draws anything for a row. */
  readonly drawsBody: TranscriptRowRenderer["drawsBody"];
}

/**
 * The chain, with every stage's own report beside it. Published as separate members because find
 * classifies an id against every stage to say which one removed a row, while the rows render the
 * folded one.
 */
export interface TranscriptFeedWindows {
  readonly firstReadSettled: boolean;
  /** What this session's reader folded, and the acts that fold and open. */
  readonly folds: TranscriptFolds;
  /** Every member row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  readonly runGroupFold: TranscriptPipelineStage;
  /** The last model window: folded by run group, its lists holding only rows the feed draws. */
  readonly transcriptWindow: TranscriptWindowModel;
  /** Whether the feed draws a row at all, asked of any row of the log, folded away or not. */
  readonly drawsRow: (row: TranscriptEventRow) => boolean;
  readonly reveal: RevealBinding;
  readonly viewport: TranscriptViewportBinding;
  /** The history past the store's window, or `undefined` for a composition with no read. */
  readonly history: TranscriptHistory | undefined;
}

/** Derive every window this feed draws from, in the one order they may be derived in. */
export function useTranscriptFeedWindows(
  inputs: TranscriptFeedWindowsInputs,
): TranscriptFeedWindows {
  // The same reading `TranscriptWindowSkeleton` draws from, so the empty sentence and the
  // skeleton rows cannot both be on screen.
  const firstReadSettled = useTranscriptFirstReadSettled(inputs.sessionStore);
  // What a person folded is a fact about who is reading, so it is held here and handed to the
  // derivation rather than folded into it.
  const folds = useTranscriptFolds(inputs.sessionStore.sessionId);
  const unfurledWindow = useTranscriptProjection(inputs.sessionStore);
  const runGroupFold = useFoldedRunGroups(
    unfurledWindow,
    folds.foldedRunIds,
    inputs.sessionStore.sessionId,
  );
  const drawsBody = inputs.drawsBody;
  const transcriptWindow = useDrawnRows(
    runGroupFold.window,
    drawsBody,
    inputs.sessionStore.sessionId,
  );
  // Over the unfurled window's system messages, which name the rows a fold hides as well.
  const drawsRow = useCallback(
    (row: TranscriptEventRow) => isDrawnRow(row, unfurledWindow.systemMessageByRowId, drawsBody),
    [unfurledWindow, drawsBody],
  );
  // The reveal engine is this feed's, minted once and disposed with it. The frame scheduler is
  // minted above both holders so one object orders the paint: the reveal drain runs in its second
  // phase, while the viewport writes `scrollTop` at once and submits nothing to the first.
  const frameScheduler = useAnimationFrameScheduler(inputs.clock);
  const reveal = useReveal({ frameScheduler, clock: inputs.clock });
  const history = useTranscriptHistory(inputs.sessionStore, inputs.readTranscriptPage);
  // Resolved from the same windows the viewport is handed, so the landing reaches it on the
  // render that brings the row.
  const landingRowKey = useMessageAnchorRowKey({
    sessionStore: inputs.sessionStore,
    messageAnchorCursor: inputs.messageAnchorCursor,
    history,
    unfurledWindow,
    transcriptWindow,
    drawsRow,
    openRunGroup: folds.openRunGroup,
  });
  // One reader of each for the mount, over the window, folds and reveal engine of the last
  // render: a new reader would mint a new viewport, and the viewport asks for a row's kind and
  // body length only for rows that window holds.
  const committedTranscriptWindow = useLatestRef(transcriptWindow);
  const committedFoldedCallRowIds = useLatestRef(folds.foldedCallRowIds);
  const isRevealingRow = useLatestRef(reveal.isRevealing);
  const heightKindOf = useCallback(
    (rowKey: string) =>
      rowHeightKindOf(
        committedTranscriptWindow.current,
        committedFoldedCallRowIds.current,
        isRevealingRow.current,
        rowKey,
      ),
    [committedTranscriptWindow, committedFoldedCallRowIds, isRevealingRow],
  );
  const bodyLengthOf = useCallback(
    (rowKey: string) =>
      rowBodyLengthOf(committedTranscriptWindow.current, isRevealingRow.current, rowKey),
    [committedTranscriptWindow, isRevealingRow],
  );
  const viewport = useTranscriptViewport({
    clock: inputs.clock,
    rows: transcriptWindow.viewportRows,
    liveRunGroupKeys: transcriptWindow.liveRunGroupKeys,
    landingRowKey,
    rememberedRowHeights: inputs.sessionStore.rememberedRowHeights,
    heightKindOf,
    bodyLengthOf,
    readBeyondLogEdge: history?.readStretch,
  });
  const stretchMeasure = useStretchMeasure({
    history,
    viewport,
    drawsBody,
    foldedRunIds: folds.foldedRunIds,
    foldedCallRowIds: folds.foldedCallRowIds,
  });
  useHistoryLookAhead({
    history,
    sessionStore: inputs.sessionStore,
    measure: stretchMeasure,
    drawnRowCount: transcriptWindow.viewportRows.length,
  });
  useReleaseOutsideWindow({
    history,
    sessionStore: inputs.sessionStore,
    snapshot: viewport.snapshot,
    unfurledWindow,
    transcriptWindow,
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

  // A lane whose row has left this window is dropped, keeping a reply row's text for its foot; a
  // run that settles keeps its lanes while its rows stay drawn. Asked of the engine's own lanes
  // (at most one per streaming row) rather than walking the whole log on every event. What a row
  // drew is forgotten once the log's window lets the row go; a row only folded away is still held.
  const { retireLanes: retireRevealLanes, forgetDrawnTextOutside } = reveal;
  useEffect(() => {
    retireRevealLanes(
      (laneId) => !transcriptWindow.rowsByKey.has(laneId),
      (laneId) => {
        const row = unfurledWindow.rowsByKey.get(laneId);
        return row !== undefined && classifyTranscriptRow(row)?.kind === "agent-message";
      },
    );
    forgetDrawnTextOutside((rowId) => unfurledWindow.rowsByKey.has(rowId));
  }, [retireRevealLanes, forgetDrawnTextOutside, transcriptWindow, unfurledWindow]);

  return {
    firstReadSettled,
    folds,
    unfurledWindow,
    runGroupFold,
    transcriptWindow,
    drawsRow,
    reveal,
    viewport,
    history,
  };
}
