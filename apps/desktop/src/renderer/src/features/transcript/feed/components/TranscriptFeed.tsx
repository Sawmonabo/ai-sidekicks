// The transcript, composed: the find field and the feed. Derivations belong to
// `useTranscriptFeedWindows` and every scroll to the viewport binding; this file arranges the
// pieces and wires their callbacks. There is one viewport binding: a second would leave the find
// walk reading a virtualizer with no element under it, a jump that scrolls nothing.

import "./TranscriptFeed.css";

import { useCallback, useMemo } from "react";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { RowRevealProvider } from "../../reveal/components/RowRevealProvider.js";
import { TranscriptViewport } from "../../viewport/components/TranscriptViewport.js";
import { LoadEarlier } from "../../history/components/LoadEarlier.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript-page.js";
import { TranscriptFeedHeader } from "./TranscriptFeedHeader.js";
import { TranscriptWindowSkeleton } from "../../window/components/TranscriptWindowSkeleton.js";
import { useTranscriptRowRenderer } from "../hooks/useTranscriptRowRenderer.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { useTranscriptFeedWindows } from "../hooks/useTranscriptFeedWindows.js";
import { useTranscriptFindAndJump } from "../hooks/useTranscriptFindAndJump.js";
import { useTranscriptStructureActs } from "../hooks/useTranscriptStructureActs.js";
import { useConversationCopy } from "../../copy/hooks/useConversationCopy.js";
import { RowToggleProvider, type RowToggle } from "../../rows/RowToggleProvider.js";
import { readRunGroupKey } from "../../runs/groups.js";

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
  });
  const { folds, transcriptWindow, viewport, history } = windows;
  const jumpToRow = viewport.jumpToRow;
  const findAndJump = useTranscriptFindAndJump({
    foldedAwayRows: windows.runGroupFold.removedRows,
    drawsRow: windows.drawsRow,
    rows: transcriptWindow.rows,
    jumpToRow,
    focusTranscriptViewport: viewport.focusScrollContainer,
  });
  const find = findAndJump.find;

  // The store's wheel, which the session header also reads, so one person wears one color
  // everywhere. `assignmentFor` never allocates: an actor the wheel has never admitted gets
  // `undefined` and the row renders unattributed.
  const hueForAgent = useCallback(
    (actorId: string) => props.sessionStore.hueAllocator.assignmentFor(actorId),
    [props.sessionStore],
  );

  // Every fold is held, then made: the viewport reads where the pressed row stands before the
  // press changes the rows, and keeps it there once they are laid out again.
  const { holdRowInPlace, holdRowNearestMiddle } = viewport;
  const { foldedRunIds, foldedCallRowIds, toggleCall, foldEveryRunGroup, unfoldEveryRunGroup } =
    folds;
  const toggleFoldedRunGroup = folds.toggleRunGroup;
  // A header's key is the run id it heads.
  const toggleRunGroup = useCallback(
    (runId: string) => {
      holdRowInPlace(runId);
      toggleFoldedRunGroup(runId);
    },
    [holdRowInPlace, toggleFoldedRunGroup],
  );
  const rowToggle = useMemo<RowToggle>(
    () => ({
      toggleCallFold: (rowId, control) => {
        holdRowInPlace(rowId, control);
        toggleCall(rowId);
      },
      holdControlInPlace: holdRowInPlace,
    }),
    [holdRowInPlace, toggleCall],
  );
  // Named off the props object because the callback below keys on it and `props` is a fresh
  // object every render; depending on the whole object rebuilt `renderRow` on every render and
  // re-rendered every mounted row.
  const renderTranscriptRow = props.rowRenderer.render;
  const renderRow = useTranscriptRowRenderer({
    transcriptWindow,
    foldedRunIds,
    foldedCallRowIds,
    hueForAgent,
    toggleRunGroup,
    renderTranscriptRow,
  });

  // The palette's chords cannot import this component, so the feed adopts the mounted transcript
  // for its lifetime; what each act does is its own module's. A press that would change no group
  // holds nothing, so it leaves a reader following the tail where they are.
  const runGroupByHeaderKey = transcriptWindow.runGroupByHeaderKey;
  const foldEveryRun = useCallback(() => {
    const runIds = [...runGroupByHeaderKey.keys()];
    if (runIds.every((runId) => foldedRunIds.has(runId))) {
      return;
    }
    // A member row leaves with its group; a header or a row outside every group stays.
    holdRowNearestMiddle((rowKey) => {
      const row = transcriptWindow.rowsByKey.get(rowKey);
      return row === undefined || readRunGroupKey(row) === undefined;
    });
    foldEveryRunGroup(runIds);
  }, [
    runGroupByHeaderKey,
    foldedRunIds,
    holdRowNearestMiddle,
    transcriptWindow,
    foldEveryRunGroup,
  ]);
  const unfoldEveryRun = useCallback(() => {
    const runIds = [...runGroupByHeaderKey.keys()];
    if (!runIds.some((runId) => foldedRunIds.has(runId))) {
      return;
    }
    holdRowNearestMiddle(() => true);
    unfoldEveryRunGroup(runIds);
  }, [runGroupByHeaderKey, foldedRunIds, holdRowNearestMiddle, unfoldEveryRunGroup]);
  useTranscriptStructureActs(
    { find, jumpToRow, jumpToTail: viewport.jumpToTail, foldEveryRun, unfoldEveryRun },
    runGroupByHeaderKey.size > 0,
  );
  const copySelection = useConversationCopy();

  // `Load earlier` comes from `history/`, over the daemon's verdict about the log before the head.
  return (
    <div className="meridian-transcript-feed">
      <div className="meridian-transcript-feed__head">
        <TranscriptFeedHeader findAndJump={findAndJump} />
      </div>
      <div className="meridian-transcript-feed__body" onCopy={copySelection}>
        <RowToggleProvider rowToggle={rowToggle}>
          <RowRevealProvider channel={windows.reveal.channel}>
            <TranscriptViewport
              binding={viewport}
              renderRow={renderRow}
              feedLabel={props.feedLabel}
              firstReadSettled={windows.firstReadSettled}
              hasActiveTurn={transcriptWindow.liveRunGroupKeys.size > 0}
              earlierHistoryControl={
                history === undefined ? undefined : <LoadEarlier history={history} />
              }
            />
          </RowRevealProvider>
        </RowToggleProvider>
        <TranscriptWindowSkeleton sessionStore={props.sessionStore} />
      </div>
    </div>
  );
}
