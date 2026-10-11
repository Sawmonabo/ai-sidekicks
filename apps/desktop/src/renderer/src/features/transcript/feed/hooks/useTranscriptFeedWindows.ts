// Every window this feed derives, in the one order they may be derived in: the unfurled
// projection, the run-group fold, the rows the feed draws anything for, and of those the rows that
// draw whole, which the viewport holds a window of. The fold publishes the rows it removed, since
// re-deriving the difference downstream re-walked the projection on every append; nothing counts a
// row the feed never draws, so that stage publishes its window alone. The one viewport binding,
// reveal engine and history reader are minted here, since the reader is asked by the viewport and
// measured in it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { transcriptWindowDiagnostics } from "#renderer/lib/transcript-window-diagnostics.js";
import { type Clock } from "#renderer/lib/clock.js";
import { useAnimationFrameScheduler } from "../../hooks/useAnimationFrameScheduler.js";
import { useReveal, type RevealBinding } from "../../reveal/hooks/useReveal.js";
import {
  useTranscriptViewport,
  type TranscriptViewportBinding,
} from "../../viewport/hooks/useTranscriptViewport.js";
import { type MessageReadBack } from "../../viewport/controller.js";
import { useDuplicateRowKeyCapture } from "../../viewport/hooks/useDuplicateRowKeyCapture.js";
import { useTranscriptFirstReadSettled } from "../../window/hooks/useTranscriptFirstReadSettled.js";
import { useTranscriptProjection } from "../../window/hooks/useTranscriptProjection.js";
import { ChangingRowIndex } from "../../window/changing-rows.js";
import {
  deriveTranscriptWindow,
  type TranscriptPipelineStage,
  type TranscriptWindowModel,
} from "../../window/transcript-window.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { useHistoryLookAhead } from "../../history/hooks/useHistoryLookAhead.js";
import { useReleaseOutsideWindow } from "../../history/hooks/useReleaseOutsideWindow.js";
import { useStretchMeasure } from "../../history/hooks/useStretchMeasure.js";
import {
  useTranscriptHistory,
  type TranscriptHistory,
} from "../../history/hooks/useTranscriptHistory.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { DrawnRowFilter, isDrawnRow } from "../drawn-rows.js";
import {
  rowBodyLengthOf,
  rowHeightKindOf,
  runWindowMeasureOf,
  type RowDrawing,
  type RunWindowEstimates,
} from "../row-height-inputs.js";
import { RunGroupFold, type RunWindowInputs } from "../run-group-fold.js";
import { type RunWindowEdge, type RunWindowMeasure } from "../../runs/call-window.js";
import { type RunGroup } from "../../runs/groups.js";
import { useFoldedRunGroups } from "./useFoldedRunGroups.js";
import { useDrawnRows } from "./useDrawnRows.js";
import { usePreparedRows } from "./usePreparedRows.js";
import { classifyTranscriptRow } from "../../rows/kind.js";
import { DrawnLongTables } from "../../rows/markdown/table-window/drawn-tables.js";
import { OffListTables } from "../../rows/markdown/table-window/off-list.js";
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
  /** The registered row renderer's start of what a row's first frame waits on. */
  readonly prepareRow: TranscriptRowRenderer["prepareRow"];
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
  /**
   * The last model window: folded by run group, its lists holding only rows the feed draws and
   * only once each draws whole.
   */
  readonly transcriptWindow: TranscriptWindowModel;
  readonly reveal: RevealBinding;
  readonly viewport: TranscriptViewportBinding;
  /** The long tables of rows not yet listed, measured off the list at the listed rows' width. */
  readonly offListTables: OffListTables;
  /** The long tables the feed draws, which a copy reads their undrawn rows from. */
  readonly drawnLongTables: DrawnLongTables;
  /** The history past the store's window, or `undefined` for a composition with no read. */
  readonly history: TranscriptHistory | undefined;
  /** How reading back toward a linked message the log lacks stands, or `undefined` for none. */
  readonly messageReadBack: MessageReadBack | undefined;
  /** Open the next stretch of a long run beyond `edge`, measured as the fold measures it. */
  readonly openRunStretch: (runGroup: RunGroup, edge: RunWindowEdge) => void;
  /**
   * The window the feed would draw over `events`, folded and cut as the reader's runs stand now,
   * without moving them: a copy reads the rows the store let go through it.
   */
  readonly deriveDrawnWindow: (events: readonly ProjectedSessionEvent[]) => TranscriptWindowModel;
}

/** Derive every window this feed draws from, in the one order they may be derived in. */
export function useTranscriptFeedWindows(
  inputs: TranscriptFeedWindowsInputs,
): TranscriptFeedWindows {
  // The one reading of the first read: the feed draws its loading line until it lands and the
  // viewport, empty sentence included, after.
  const firstReadSettled = useTranscriptFirstReadSettled(inputs.sessionStore);
  // What a person folded is a fact about who is reading, so it is held here and handed to the
  // derivation rather than folded into it.
  const folds = useTranscriptFolds(inputs.sessionStore.sessionId);
  const { unfurledWindow, runEntities, derivation } = useTranscriptProjection(inputs.sessionStore);
  // A long run's window is cut in the viewport's estimates, but the fold runs before the viewport
  // is minted, so they arrive from the layout effect below. Until then every call reads zero
  // high and a window holds one call; the fold cuts it again once they land, which is before any
  // frame paints, and the first rows stay hidden until their faces settle besides.
  // The calls a reader folded and the outputs they opened are read when the fold runs, so a press
  // on a call re-folds nothing.
  const [runWindowEstimates, setRunWindowEstimates] =
    useState<Omit<RunWindowEstimates, "foldedCallRowIds" | "openedOutputRowIds">>();
  const committedFoldedCallRowIds = useLatestRef(folds.foldedCallRowIds);
  const committedOpenedOutputRowIds = useLatestRef(folds.openedOutputRowIds);
  const { runCallWindows, runWindowMoveCount } = folds;
  const runWindowInputs = useMemo<RunWindowInputs>(
    () => ({
      windows: runCallWindows,
      measureOf: (model) =>
        runWindowEstimates === undefined
          ? UNMEASURED_RUN_WINDOW
          : runWindowMeasureOf(model, {
              ...runWindowEstimates,
              foldedCallRowIds: committedFoldedCallRowIds.current,
              openedOutputRowIds: committedOpenedOutputRowIds.current,
            }),
      moveCount: runWindowMoveCount,
    }),
    [
      runCallWindows,
      runWindowEstimates,
      committedFoldedCallRowIds,
      committedOpenedOutputRowIds,
      runWindowMoveCount,
    ],
  );
  const runGroupFold = useFoldedRunGroups(
    unfurledWindow,
    folds.foldedRunGroupKeys,
    runWindowInputs,
    inputs.sessionStore.sessionId,
  );
  const drawsBody = inputs.drawsBody;
  const drawnWindow = useDrawnRows(runGroupFold.window, drawsBody, inputs.sessionStore.sessionId);
  // Over the unfurled window's system messages, which name the rows a fold hides as well.
  const drawsRow = useCallback(
    (row: TranscriptEventRow) => isDrawnRow(row, unfurledWindow.systemMessageByRowId, drawsBody),
    [unfurledWindow, drawsBody],
  );
  // The reveal engine is this feed's, minted once and disposed with it. The frame scheduler is
  // minted above both holders so one object orders the paint: the viewport's reactive writes and
  // eased glides run in its first phase and the reveal drain in its second, while a write the
  // reader's own scroll answers is placed at once.
  const frameScheduler = useAnimationFrameScheduler(inputs.clock);
  const reveal = useReveal({ frameScheduler, clock: inputs.clock });
  // A held row's long tables are laid out at the width the viewport's rows are, which it reads
  // once it is minted below.
  const readRowWidthPxRef = useRef<() => number | undefined>(readNoRowWidth);
  const ownerDocument = useOwnerWindow().document;
  const [offListTables] = useState(
    () => new OffListTables(ownerDocument, () => readRowWidthPxRef.current()),
  );
  const [drawnLongTables] = useState(() => new DrawnLongTables());
  // A row the log lets go takes its streaming tables' handed geometry with it.
  useEffect(() => {
    offListTables.streamingTables.retainRows(unfurledWindow.rowsByKey);
  }, [offListTables, unfurledWindow]);
  // After the reveal engine, whose live text a held reply is read through.
  const preparedRows = usePreparedRows(
    drawnWindow,
    inputs.prepareRow,
    reveal.channel,
    offListTables,
    inputs.sessionStore.sessionId,
  );
  const transcriptWindow = preparedRows.window;
  const history = useTranscriptHistory(inputs.sessionStore, inputs.readTranscriptPage);
  // Resolved from the same windows the viewport is handed, so the landing reaches it on the
  // render that brings the row.
  const { landingRowKey, readBack } = useMessageAnchorRowKey({
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
  const isRevealingRow = useLatestRef(reveal.isRevealing);
  // Read through, so the viewport's many asks for a row's kind allocate nothing.
  const committedRowDrawing = useMemo<RowDrawing>(
    () => ({
      get foldedCallRowIds() {
        return committedFoldedCallRowIds.current;
      },
      get openedOutputRowIds() {
        return committedOpenedOutputRowIds.current;
      },
      isRevealing: (rowId) => isRevealingRow.current(rowId),
    }),
    [committedFoldedCallRowIds, committedOpenedOutputRowIds, isRevealingRow],
  );
  const heightKindOf = useCallback(
    (rowKey: string) =>
      rowHeightKindOf(committedTranscriptWindow.current, committedRowDrawing, rowKey),
    [committedTranscriptWindow, committedRowDrawing],
  );
  const bodyLengthOf = useCallback(
    (rowKey: string) =>
      rowBodyLengthOf(committedTranscriptWindow.current, isRevealingRow.current, rowKey),
    [committedTranscriptWindow, isRevealingRow],
  );
  // The register moves only on an act that also replaces the log, so it is read with the window
  // the log derived rather than subscribed to on its own.
  const waitingOnPerson = inputs.sessionStore.waitingOnPersonRecords;
  // One index per session, as the windows above keep one derivation each.
  const bridge = usePlatformBridge();
  const changingRowIndex = useSubjectScopedState(
    bridge,
    inputs.sessionStore.sessionId,
    () => new ChangingRowIndex(),
  ).value;
  const changingRowIds = useMemo(
    () => changingRowIndex.changingRowIdsOf(unfurledWindow, waitingOnPerson),
    [changingRowIndex, unfurledWindow, waitingOnPerson],
  );
  // The check is re-made when the reveal's held lanes change, since a new check is what has the
  // viewport ask a cut the last check stopped short again.
  const { isRevealing, laneRevision } = reveal;
  const isChangingRow = useCallback(
    (rowKey: string) => changingRowIds.has(rowKey) || isRevealing(rowKey),
    [changingRowIds, isRevealing, laneRevision],
  );
  // One object per change of what it holds, not per render: a frame of arriving text renders the
  // feed, and a fresh object for each was garbage the viewport only reads through a ref.
  const clock = inputs.clock;
  const rememberedRowHeights = inputs.sessionStore.rememberedRowHeights;
  const readBeyondLogEdge = history?.readStretch;
  const jumpToLogEnd = history?.jumpTo;
  const viewportRows = transcriptWindow.viewportRows;
  const viewportOptions = useMemo(
    () => ({
      clock,
      rows: viewportRows,
      isChangingRow,
      landingRowKey,
      messageReadBack: readBack,
      rememberedRowHeights,
      heightKindOf,
      bodyLengthOf,
      readBeyondLogEdge,
      jumpToLogEnd,
      isRowPrepared: preparedRows.isPrepared,
      isRowHeldOut: preparedRows.isHeldOut,
      holdsRowAfter: preparedRows.holdsRowAfter,
      subscribeToRowWork: preparedRows.subscribeToWork,
      isRowRevealing: isRevealing,
      frameScheduler,
    }),
    [
      clock,
      viewportRows,
      isChangingRow,
      landingRowKey,
      readBack,
      rememberedRowHeights,
      heightKindOf,
      bodyLengthOf,
      readBeyondLogEdge,
      jumpToLogEnd,
      preparedRows.isPrepared,
      preparedRows.isHeldOut,
      preparedRows.holdsRowAfter,
      preparedRows.subscribeToWork,
      isRevealing,
      frameScheduler,
    ],
  );
  const viewport = useTranscriptViewport(viewportOptions);
  const readRowWidthPx = viewport.readRowWidthPx;
  // After each render, once the scroll container is attached: a table prepared in this render
  // before the width could be read takes it now, at no cost when none waits.
  useLayoutEffect(() => {
    readRowWidthPxRef.current = readRowWidthPx;
    offListTables.readRowWidth();
  });
  const stretchMeasure = useStretchMeasure({
    history,
    derivation,
    runEntities,
    viewport,
    drawsBody,
    foldedRunGroupKeys: folds.foldedRunGroupKeys,
    foldedCallRowIds: folds.foldedCallRowIds,
    openedOutputRowIds: folds.openedOutputRowIds,
  });
  const { estimatedRowHeightPx } = viewport;
  const screenHeightPx = stretchMeasure.screenHeightPx;
  useLayoutEffect(() => {
    setRunWindowEstimates({ estimatedRowHeightPx, screenHeightPx, isRevealing });
  }, [estimatedRowHeightPx, screenHeightPx, isRevealing]);
  const foldsOpenRunStretch = folds.openRunStretch;
  const openRunStretch = useCallback(
    (runGroup: RunGroup, edge: RunWindowEdge) => {
      foldsOpenRunStretch(runGroup, edge, runWindowInputs.measureOf(unfurledWindow));
    },
    [foldsOpenRunStretch, runWindowInputs, unfurledWindow],
  );
  const foldedRunGroupKeys = folds.foldedRunGroupKeys;
  const deriveDrawnWindow = useCallback(
    (events: readonly ProjectedSessionEvent[]) =>
      new DrawnRowFilter().filter(
        new RunGroupFold().fold(deriveTranscriptWindow(events, runEntities), foldedRunGroupKeys, {
          ...runWindowInputs,
          windows: runCallWindows.clone(),
        }).window,
        drawsBody,
      ),
    [foldedRunGroupKeys, runEntities, runWindowInputs, runCallWindows, drawsBody],
  );
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
    preparingRows: preparedRows.preparingRows,
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
    reveal,
    viewport,
    offListTables,
    drawnLongTables,
    history,
    messageReadBack: readBack,
    openRunStretch,
    deriveDrawnWindow,
  };
}

/** The row width before the viewport is minted: unknown, so a table off the list waits for it. */
function readNoRowWidth(): undefined {
  return undefined;
}

/** The measure before the viewport has estimates: every call reads zero high. */
const UNMEASURED_RUN_WINDOW: RunWindowMeasure = {
  screenHeightPx: () => 0,
  rowHeightPx: () => 0,
};
