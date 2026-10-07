// The transcript, composed: the find field and the feed. Derivations belong to
// `useTranscriptFeedWindows` and every scroll to the viewport binding; this file arranges the
// pieces and wires their callbacks. There is one viewport binding: a second would leave the find
// walk reading a virtualizer with no element under it, a jump that scrolls nothing.

import "./TranscriptFeed.css";

import { useCallback, useMemo } from "react";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { RetainedRowStateProvider } from "../../viewport/components/RetainedRowStateProvider.js";
import { RowRevealProvider } from "../../reveal/components/RowRevealProvider.js";
import { TranscriptViewport } from "../../viewport/components/TranscriptViewport.js";
import { LoadEarlier } from "../../history/components/LoadEarlier.js";
import { type EarlierPageRead } from "../../history/earlier-reader.js";
import { useEarlierHistory } from "../../history/hooks/useEarlierHistory.js";
import { TranscriptFeedHeader } from "./TranscriptFeedHeader.js";
import { TranscriptWindowSkeleton } from "../../window/components/TranscriptWindowSkeleton.js";
import { useTranscriptRowRenderer } from "../hooks/useTranscriptRowRenderer.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptRowRenderer } from "../../rows/renderer.js";
import { useTranscriptFeedWindows } from "../hooks/useTranscriptFeedWindows.js";
import { useTranscriptFindAndJump } from "../hooks/useTranscriptFindAndJump.js";
import { useTranscriptStructureActs } from "../hooks/useTranscriptStructureActs.js";
import { useConversationCopy } from "../../copy/hooks/useConversationCopy.js";

/** What the feed is a log of and the row body it draws each row through. */
export interface TranscriptFeedProps {
  readonly sessionStore: SessionStore;
  /** The registered row renderer. Resolved by the pane, so this file reads no registry. */
  readonly rowRenderer: TranscriptRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
  /** The backward page read. A composition with none mounts no `Load earlier`. */
  readonly readEarlierPage?: EarlierPageRead | undefined;
  /**
   * The event cursor of the message to open at, or `undefined` to open at the bottom. A message
   * older than the window is reached by paging back through `readEarlierPage`; a cursor no page
   * holds, down to the start of history, opens at the bottom too.
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
  const earlierHistory = useEarlierHistory(props.sessionStore, props.readEarlierPage);
  const windows = useTranscriptFeedWindows({
    sessionStore: props.sessionStore,
    clock,
    messageAnchorCursor: props.messageAnchorCursor,
    earlierHistory,
    drawsBody: props.rowRenderer.drawsBody,
  });
  const { runGroupDisclosure, transcriptWindow, viewport } = windows;
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

  const toggleRunGroup = runGroupDisclosure.toggle;
  const openedTerminalRunIds = runGroupDisclosure.openedTerminalRunIds;
  const retainedRowState = viewport.retainedRowState;
  const setRetainedRowState = viewport.setRetainedRowState;
  // Named off the props object because the callback below keys on it and `props` is a fresh
  // object every render; depending on the whole object rebuilt `renderRow` on every render and
  // re-rendered every mounted row.
  const renderTranscriptRow = props.rowRenderer.render;
  const retainedStateChannel = useMemo(
    () => ({ setRetainedState: setRetainedRowState }),
    [setRetainedRowState],
  );
  const renderRow = useTranscriptRowRenderer({
    transcriptWindow,
    openedTerminalRunIds,
    hueForAgent,
    toggleRunGroup,
    retainedRowState,
    renderTranscriptRow,
  });

  // The palette's chords cannot import this component, so the feed adopts the mounted transcript
  // for its lifetime; what each act does is its own module's.
  const collapseAllTerminal = runGroupDisclosure.collapseAllTerminal;
  const collapseAllTerminalRunGroups = useCallback(() => {
    collapseAllTerminal([...transcriptWindow.runGroupByHeaderKey.values()]);
  }, [collapseAllTerminal, transcriptWindow]);
  useTranscriptStructureActs({
    find,
    jumpToRow,
    jumpToTail: viewport.jumpToTail,
    collapseAllTerminalRunGroups,
  });
  const copySelection = useConversationCopy();

  // `Load earlier` comes from `history/`, over the producer's verdict about the log. The find box
  // offers none: the rows the window let go are rows the store still holds, and find reaches them.
  return (
    <div className="meridian-transcript-feed">
      <div className="meridian-transcript-feed__head">
        <TranscriptFeedHeader findAndJump={findAndJump} />
      </div>
      <div className="meridian-transcript-feed__body" onCopy={copySelection}>
        <RetainedRowStateProvider channel={retainedStateChannel}>
          <RowRevealProvider channel={windows.reveal.channel}>
            <TranscriptViewport
              binding={viewport}
              renderRow={renderRow}
              feedLabel={props.feedLabel}
              firstReadSettled={windows.firstReadSettled}
              hasActiveTurn={transcriptWindow.hasActiveTurn}
              earlierHistoryControl={
                earlierHistory === undefined ? undefined : (
                  <LoadEarlier earlierHistory={earlierHistory} />
                )
              }
            />
          </RowRevealProvider>
        </RetainedRowStateProvider>
        <TranscriptWindowSkeleton sessionStore={props.sessionStore} />
      </div>
    </div>
  );
}
