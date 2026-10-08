// Every window this feed derives, in the one order they may be derived in: the unfurled
// projection, the run-group fold, and the rows the feed draws anything for, which the viewport
// holds a window of. The fold publishes the rows it removed, since re-deriving the difference
// downstream re-walked the projection on every append; nothing counts a row the feed never draws,
// so that stage publishes its window alone. The one viewport binding and reveal engine are minted
// here.

import { useCallback, useEffect } from "react";

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_PAYLOAD_PLAINTEXT_MAX,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
} from "@ai-sidekicks/contracts/event/declared-variants";
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
import { projectedPayload, readWireCount } from "#renderer/store/session/events/wire-payload.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type EarlierHistoryPaging } from "../../history/hooks/useEarlierHistory.js";
import { densityFor, type RunGroupDisclosure } from "../run-group-fold.js";
import { isDrawnRow } from "../drawn-rows.js";
import { useFoldedRunGroups } from "./useFoldedRunGroups.js";
import { useDrawnRows } from "./useDrawnRows.js";
import { type RowHeightKind } from "../../rows/height-kind.js";
import { classifyTranscriptRow } from "../../rows/kind.js";
import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { useMessageAnchorRowKey } from "./useMessageAnchorRowKey.js";
import { useRunGroupDisclosure } from "./useRunGroupDisclosure.js";

/** What the window chain is derived from: the session's store and the frame's clock. */
export interface TranscriptFeedWindowsInputs {
  readonly sessionStore: SessionStore;
  /** The frame scheduler's clock, minted once by the mount that holds this chain. */
  readonly clock: Clock;
  /** The event cursor of the message a link opened the session at, or `undefined` for none. */
  readonly messageAnchorCursor: string | undefined;
  /** The backward walk a linked message older than the window is reached through, if any. */
  readonly earlierHistory: EarlierHistoryPaging | undefined;
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
  readonly runGroupDisclosure: RunGroupDisclosure;
  /** Every member row of every run group, before any fold. */
  readonly unfurledWindow: TranscriptWindowModel;
  readonly runGroupFold: TranscriptPipelineStage;
  /** The last model window: folded by run group, its lists holding only rows the feed draws. */
  readonly transcriptWindow: TranscriptWindowModel;
  /** Whether the feed draws a row at all, asked of any row of the log, folded away or not. */
  readonly drawsRow: (row: TranscriptEventRow) => boolean;
  readonly reveal: RevealBinding;
  readonly viewport: TranscriptViewportBinding;
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
  // The reveal engine is this feed's, minted once and disposed with it. The frame scheduler is minted above both holders so one object orders the
  // paint: the reveal drain runs in its second phase, while the viewport writes `scrollTop` at
  // once and submits nothing to the first.
  const frameScheduler = useAnimationFrameScheduler(inputs.clock);
  const reveal = useReveal({ frameScheduler, clock: inputs.clock });
  // Resolved from the same windows the viewport is handed, so the landing reaches it on the
  // render that brings the row.
  const landingRowKey = useMessageAnchorRowKey({
    sessionStore: inputs.sessionStore,
    messageAnchorCursor: inputs.messageAnchorCursor,
    earlierHistory: inputs.earlierHistory,
    unfurledWindow,
    transcriptWindow,
    drawsRow,
    runGroupDisclosure,
  });
  // One reader of each for the mount, over the window the tree last committed and the reveal
  // engine of the last render: a new reader would mint a new viewport, and the viewport asks for a
  // row's kind and body length only for rows that window holds.
  const committedTranscriptWindow = useLatestRef(transcriptWindow);
  const isRevealingRow = useLatestRef(reveal.isRevealing);
  const heightKindOf = useCallback(
    (rowKey: string) => rowHeightKindOf(committedTranscriptWindow.current, rowKey),
    [committedTranscriptWindow],
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
  // a turn that is over, so the engine drops it, keeping a reply row's text for its foot. Asked
  // of the engine's own lanes (at most one per streaming row) rather than walking the whole log
  // on every event. What a row drew is forgotten once the log's window lets the row go; a row
  // only folded away is still held.
  const { retireLanes: retireRevealLanes, forgetDrawnTextOutside } = reveal;
  useEffect(() => {
    retireRevealLanes(
      (laneId) =>
        !transcriptWindow.rowsByKey.has(laneId) || transcriptWindow.collapsedRowIds.has(laneId),
      (laneId) => {
        const row = unfurledWindow.rowsByKey.get(laneId);
        return row !== undefined && classifyTranscriptRow(row)?.kind === "agent-message";
      },
    );
    forgetDrawnTextOutside((rowId) => unfurledWindow.rowsByKey.has(rowId));
  }, [retireRevealLanes, forgetDrawnTextOutside, transcriptWindow, unfurledWindow]);

  return {
    firstReadSettled,
    runGroupDisclosure,
    unfurledWindow,
    runGroupFold,
    transcriptWindow,
    drawsRow,
    reveal,
    viewport,
  };
}

/**
 * The height kind the feed draws a key of its list as, decided as the row dispatch decides what
 * to draw. A tool row's density is the list's alone: a row whose density a person chose was
 * mounted to be chosen, so it has a measured height and never asks for an estimate.
 */
function rowHeightKindOf(transcriptWindow: TranscriptWindowModel, rowKey: string): RowHeightKind {
  if (transcriptWindow.runGroupByHeaderKey.has(rowKey)) {
    return "run-group-header";
  }
  const row = transcriptWindow.rowsByKey.get(rowKey);
  if (row === undefined) {
    return "not-loaded";
  }
  if (transcriptWindow.systemMessageByRowId.has(row.id)) {
    return "system-message";
  }
  const kind = classifyTranscriptRow(row)?.kind;
  if (kind === undefined) {
    // A card the kind table does not name, which the registered renderer draws: one line until
    // it measures, as a tool row is.
    return "tool-call-collapsed";
  }
  if (kind !== "tool-call") {
    return kind;
  }
  return densityFor(row.id, transcriptWindow.collapsedRowIds) === "collapsed"
    ? "tool-call-collapsed"
    : "tool-call-expanded";
}

/**
 * The UTF-8 byte length of the body a key of the feed's list draws, or `undefined` for a row that
 * reports none. A row the reveal still holds reports none: it pairs its whole body's length with
 * the height of the part drawn so far. A truncated body draws only its stored prefix, which the
 * stored ceiling bounds.
 */
function rowBodyLengthOf(
  transcriptWindow: TranscriptWindowModel,
  isRevealing: RevealBinding["isRevealing"],
  rowKey: string,
): number | undefined {
  const row = transcriptWindow.rowsByKey.get(rowKey);
  if (row === undefined || isRevealing(row.id)) {
    return undefined;
  }
  const payload = projectedPayload(row);
  const contentLength = readWireCount(payload, CONTENT_LENGTH_PAYLOAD_KEY);
  return contentLength !== undefined && payload[CONTENT_TRUNCATED_PAYLOAD_KEY] === true
    ? Math.min(contentLength, CONTENT_PAYLOAD_PLAINTEXT_MAX)
    : contentLength;
}
