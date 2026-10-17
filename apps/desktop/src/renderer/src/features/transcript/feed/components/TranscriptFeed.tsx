// The transcript, composed: the find field and the feed. Derivations belong to
// `useTranscriptFeedWindows` and every scroll to the viewport binding; this file arranges the
// pieces and wires their callbacks. There is one viewport binding: a second would leave the find
// walk reading a virtualizer with no element under it, a jump that scrolls nothing. The rows are
// first shown once the first read has landed and the faces they draw in have settled; until then
// they are laid out hidden, so they ask for those faces and measure in them, and the body shows
// `Loading…` past the loading line's delay, or nothing while the line under the session header
// says the window is behind.

import "./TranscriptFeed.css";

import { useCallback, useMemo } from "react";

import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { useUntilNextAct } from "#renderer/hooks/useUntilNextAct.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { useClockLocale } from "#renderer/services/platform/hooks/useClockLocale.js";
import { RowRevealProvider } from "../../reveal/components/RowRevealProvider.js";
import { TranscriptViewport } from "../../viewport/components/TranscriptViewport.js";
import { LoadEarlier } from "../../history/components/LoadEarlier.js";
import { type TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { TranscriptFeedHeader } from "./TranscriptFeedHeader.js";
import { useTranscriptRowRenderer } from "../hooks/useTranscriptRowRenderer.js";
import { useFullBodyReads } from "../hooks/useFullBodyReads.js";
import { FullBodyReadsContext } from "../../rows/full-body-reads.js";
import { OffListTableFrames } from "../../rows/bodies/OffListTableFrames.js";
import { ListedBodiesContext } from "../../rows/markdown/table-window/context.js";
import { PreparedBodiesContext } from "../../rows/prepared-bodies.js";
import { DrawnWindowSourcesContext } from "#renderer/components/TranscriptBodyViewport/drawn-window-sources.js";
import {
  useDependentReadFailed,
  useSessionDegraded,
} from "#renderer/store/session/hooks/useSessionInitialized.js";
import { type ProjectedFullBody } from "#renderer/store/session/entities/vocabulary.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { useTranscriptFeedWindows } from "../hooks/useTranscriptFeedWindows.js";
import { useTranscriptFindAndJump } from "../hooks/useTranscriptFindAndJump.js";
import { useTranscriptStructureActs } from "../hooks/useTranscriptStructureActs.js";
import { useTypefacesSettled } from "../../hooks/useTypefacesSettled.js";
import { useConversationCopy } from "../../copy/hooks/useConversationCopy.js";
import {
  readLargeBodyRowId,
  readRowBodyText,
  readRowText,
  type RowTextSources,
} from "../../copy/row-text.js";
import { RowToggleProvider, type RowToggle } from "../../rows/RowToggleProvider.js";
import { densityFor } from "../fold-state.js";
import { rowBesideRunWindowEdge, type RunWindowEdge } from "../../runs/call-window.js";
import { type RunGroup } from "../../runs/groups.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";

/** The line a link draws when the message it names is nowhere in the session's history. */
const MESSAGE_NOT_FOUND_WORDS = "Message not found";

/** What the feed is a log of and the row body it draws each row through. */
export interface TranscriptFeedProps {
  readonly sessionStore: SessionStore;
  /** The registered row renderer. Resolved by the pane, so this file reads no registry. */
  readonly rowRenderer: TranscriptRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
  /**
   * The `transcript.read` the history past the store's window is read with. A composition with
   * none mounts no `Load earlier` and reads nothing past the rows it was given.
   */
  readonly readTranscriptPage?: TranscriptPageRead | undefined;
  /**
   * The `transcript.bodyRead` a large body is read in full with when its control is pressed. A
   * composition with none offers no control and draws a large body as not read.
   */
  readonly readTranscriptBody?: TranscriptBodyRead | undefined;
  /**
   * The event cursor of the message to open at, or `undefined` to open at the bottom. A message
   * older than the window is reached by reading back through `readTranscriptPage`; a cursor no
   * read holds, down to the start of history, opens at the bottom too.
   */
  readonly messageAnchorCursor?: string | undefined;
}

/**
 * The session's log: the find field and the rows. A component of
 * its own because it cannot exist without a session store, so the pane holds the no-session arm
 * as an ordinary render instead of a conditional hook.
 */
export function TranscriptFeed(props: TranscriptFeedProps): React.JSX.Element {
  const clock = useClock();
  const windows = useTranscriptFeedWindows({
    sessionStore: props.sessionStore,
    clock,
    messageAnchorCursor: props.messageAnchorCursor,
    readTranscriptPage: props.readTranscriptPage,
    drawsBody: props.rowRenderer.drawsBody,
    prepareRow: props.rowRenderer.prepareRow,
  });
  const { folds, transcriptWindow, viewport, history } = windows;
  // The first rows are in the document once the virtualizer holds some, or there are none to hold,
  // and no row still held out would join the rows drawn.
  const areRowsCommitted =
    windows.firstReadSettled &&
    (transcriptWindow.viewportRows.length === 0 || viewport.virtualItems.length > 0) &&
    !windows.holdsRowJoiningView();
  const isDrawable = useTypefacesSettled(areRowsCommitted);
  // The line under the session header stands whenever either holds, and nothing repeats it.
  // A link whose message the whole history does not hold says so in `Jump to latest`'s place
  // instead of moving the page, until the next act.
  const isMessageNotFoundStanding = useUntilNextAct(
    windows.messageReadBack === "not-in-history" ? props.messageAnchorCursor : undefined,
  );
  const isWindowDegraded = useSessionDegraded(props.sessionStore);
  const isDependentReadFailed = useDependentReadFailed(props.sessionStore);
  const fullBodyReads = useFullBodyReads(props.sessionStore, props.readTranscriptBody);
  const jumpToRow = viewport.jumpToRow;
  const findAndJump = useTranscriptFindAndJump({
    foldedAwayRows: windows.runGroupFold.removedRows,
    systemMessageByRowId: windows.unfurledWindow.systemMessageByRowId,
    drawsBody: props.rowRenderer.drawsBody,
    rows: transcriptWindow.rows,
    areRowsShown: isDrawable,
    jumpToRow,
    focusTranscriptViewport: viewport.focusScrollContainer,
  });
  const find = findAndJump.find;

  // The store's wheel, so one agent wears one color on every row. `assignmentFor` never
  // allocates: an actor the wheel never admitted, the person or a device among them, gets
  // `undefined` and the row renders unattributed.
  const hueForAgent = useCallback(
    (actorId: string) => props.sessionStore.hueAllocator.assignmentFor(actorId),
    [props.sessionStore],
  );

  // Every fold is held, then made: the viewport reads where the pressed row stands before the
  // press changes the rows, and keeps it there once they are laid out again.
  const { holdRowInPlace, holdRowNearestMiddle } = viewport;
  const {
    foldedRunGroupKeys,
    foldedCallRowIds,
    toggleCall,
    openedOutputRowIds,
    openOutput,
    foldEveryRunGroup,
    unfoldEveryRunGroup,
  } = folds;
  const toggleFoldedRunGroup = folds.toggleRunGroup;
  // A header's key is the key of the run group it heads.
  const toggleRunGroup = useCallback(
    (runGroupKey: string) => {
      holdRowInPlace(runGroupKey);
      toggleFoldedRunGroup(runGroupKey);
    },
    [holdRowInPlace, toggleFoldedRunGroup],
  );
  // The row beside the pressed edge holds where it stands while the next stretch lands past it.
  const runCallWindows = folds.runCallWindows;
  const openWindowedRunStretch = windows.openRunStretch;
  const openRunStretch = useCallback(
    (runGroup: RunGroup, edge: RunWindowEdge) => {
      const window = runCallWindows.resolvedWindowOf(runGroup.key);
      const besideRowId =
        window === undefined ? undefined : rowBesideRunWindowEdge(runGroup, window, edge);
      if (besideRowId !== undefined) {
        holdRowInPlace(besideRowId);
      }
      openWindowedRunStretch(runGroup, edge);
    },
    [runCallWindows, holdRowInPlace, openWindowedRunStretch],
  );
  const toggleCallOncePrepared = windows.toggleCall;
  const rowToggle = useMemo<RowToggle>(
    () => ({
      toggleCallFold: (rowId) => {
        toggleCallOncePrepared(rowId, () => {
          holdRowInPlace(rowId);
          toggleCall(rowId);
        });
      },
      openOutput: (rowId) => {
        holdRowInPlace(rowId);
        openOutput(rowId);
      },
      holdRowInPlace,
    }),
    [toggleCallOncePrepared, holdRowInPlace, toggleCall, openOutput],
  );
  // Named off the props object because the callback below keys on it and `props` is a fresh
  // object every render; depending on the whole object rebuilt `renderRow` on every render and
  // re-rendered every mounted row.
  const renderTranscriptRow = props.rowRenderer.render;
  const renderRow = useTranscriptRowRenderer({
    transcriptWindow,
    foldedRunGroupKeys,
    foldedCallRowIds,
    openedOutputRowIds,
    hueForAgent,
    toggleRunGroup,
    runCallWindows,
    openRunStretch,
    renderTranscriptRow,
  });

  // The palette's chords cannot import this component, so the feed adopts the mounted transcript
  // for its lifetime; what each act does is its own module's. A press that would change no group
  // holds nothing, so it leaves a reader following the tail where they are.
  const runGroupByHeaderKey = transcriptWindow.runGroupByHeaderKey;
  const foldEveryRun = useCallback(() => {
    const runGroupKeys = [...runGroupByHeaderKey.keys()];
    if (runGroupKeys.every((runGroupKey) => foldedRunGroupKeys.has(runGroupKey))) {
      return;
    }
    // A member row leaves with its group; a header or a row outside every group stays.
    holdRowNearestMiddle((rowKey) => !transcriptWindow.runGroupKeyByRowId.has(rowKey));
    foldEveryRunGroup(runGroupKeys);
  }, [
    runGroupByHeaderKey,
    foldedRunGroupKeys,
    holdRowNearestMiddle,
    transcriptWindow,
    foldEveryRunGroup,
  ]);
  const unfoldEveryRun = useCallback(() => {
    const runGroupKeys = [...runGroupByHeaderKey.keys()];
    if (!runGroupKeys.some((runGroupKey) => foldedRunGroupKeys.has(runGroupKey))) {
      return;
    }
    holdRowNearestMiddle(() => true);
    unfoldEveryRunGroup(runGroupKeys);
  }, [runGroupByHeaderKey, foldedRunGroupKeys, holdRowNearestMiddle, unfoldEveryRunGroup]);
  useTranscriptStructureActs(
    { find, jumpToRow, jumpToTail: viewport.jumpToTail, foldEveryRun, unfoldEveryRun },
    runGroupByHeaderKey.size > 0,
  );
  const clockLocale = useClockLocale();
  const ownerWindow = useOwnerWindow();
  const revealChannel = windows.reveal.channel;
  const rowTextSources = useCallback(
    (
      rowTextWindow: TranscriptWindowModel,
      fullBodyOf: (rowId: string) => ProjectedFullBody | undefined,
    ): RowTextSources => ({
      transcriptWindow: rowTextWindow,
      reveal: revealChannel,
      densityOf: (rowId) => densityFor(rowId, foldedCallRowIds),
      fullBodyOf,
      clockLocale,
      view: ownerWindow,
    }),
    [revealChannel, foldedCallRowIds, clockLocale, ownerWindow],
  );
  const rowText = useCallback(
    (
      rowKey: string,
      rowTextWindow: TranscriptWindowModel,
      fullBodyOf: (rowId: string) => ProjectedFullBody | undefined,
    ) => readRowText(rowKey, rowTextSources(rowTextWindow, fullBodyOf)),
    [rowTextSources],
  );
  const rowBodyText = useCallback(
    (
      rowKey: string,
      rowTextWindow: TranscriptWindowModel,
      fullBodyOf: (rowId: string) => ProjectedFullBody | undefined,
    ) => readRowBodyText(rowKey, rowTextSources(rowTextWindow, fullBodyOf)),
    [rowTextSources],
  );
  const largeBodyRowIdOf = useCallback(
    (rowKey: string, rowTextWindow: TranscriptWindowModel) =>
      readLargeBodyRowId(rowKey, {
        transcriptWindow: rowTextWindow,
        reveal: revealChannel,
        densityOf: (rowId) => densityFor(rowId, foldedCallRowIds),
      }),
    [revealChannel, foldedCallRowIds],
  );
  const readPage = props.readTranscriptPage;
  const deriveRowSourceWindows = windows.deriveRowSourceWindows;
  const copyHistory = useMemo(
    () =>
      readPage === undefined
        ? undefined
        : { sessionStore: props.sessionStore, readPage, deriveRowSourceWindows },
    [props.sessionStore, readPage, deriveRowSourceWindows],
  );
  useConversationCopy({
    selectionTracker: viewport.selectionTracker,
    selectedRowKeys: viewport.selectedRowKeys,
    rowSourceWindows: { unfurledWindow: windows.unfurledWindow, transcriptWindow },
    rowText,
    rowBodyText,
    largeBodyRowIdOf,
    fullBodyReads,
    drawnWindowSources: windows.drawnWindowSources,
    history: copyHistory,
  });

  // `Load earlier` comes from `history/`, over the daemon's verdict about the log before the head.
  return (
    <div className="meridian-transcript-feed">
      <div className="meridian-transcript-feed__head">
        <TranscriptFeedHeader findAndJump={findAndJump} />
      </div>
      <div className="meridian-transcript-feed__body">
        <RowToggleProvider rowToggle={rowToggle}>
          <RowRevealProvider channel={revealChannel}>
            <FullBodyReadsContext value={fullBodyReads}>
              <ListedBodiesContext value={windows.offListTables}>
                <PreparedBodiesContext value={windows.preparedBodies}>
                  <DrawnWindowSourcesContext value={windows.drawnWindowSources}>
                    <TranscriptViewport
                      binding={viewport}
                      renderRow={renderRow}
                      feedLabel={props.feedLabel}
                      firstReadSettled={windows.firstReadSettled}
                      isShown={isDrawable}
                      hasActiveTurn={transcriptWindow.liveRunIds.size > 0}
                      earlierHistoryControl={
                        history === undefined ? undefined : <LoadEarlier history={history} />
                      }
                      {...(isMessageNotFoundStanding
                        ? { missingTargetWords: MESSAGE_NOT_FOUND_WORDS }
                        : {})}
                    />
                  </DrawnWindowSourcesContext>
                </PreparedBodiesContext>
              </ListedBodiesContext>
            </FullBodyReadsContext>
          </RowRevealProvider>
        </RowToggleProvider>
        {isDrawable || isWindowDegraded || isDependentReadFailed ? null : (
          <div className="meridian-transcript-feed__loading">
            <LoadingNotice title="Loading…" clock={clock} />
          </div>
        )}
        <OffListTableFrames offList={windows.offListTables} />
      </div>
    </div>
  );
}
