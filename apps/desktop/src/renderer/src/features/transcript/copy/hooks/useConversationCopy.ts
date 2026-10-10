import { useEffect, useMemo, useRef, useState } from "react";

import type { TextClipboardContent } from "#shared/preload-api.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { primarySelectionFor } from "#renderer/services/platform/primary-selection/host.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { readRunWindowEdgeKey } from "../../runs/call-window.js";
import { type RowSelection } from "../../viewport/selection/record.js";
import { type ViewportSelectionTracker } from "../../viewport/selection/tracker.js";
import { rowSourceSpanReader, type RowSourceWindows } from "../../window/row-sources.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import { readRowSpanSelection, type SelectedPart } from "../conversation-selection.js";
import {
  readSelectedEvents,
  SelectionEventSpanRecord,
  type HeldTranscript,
  type SelectionEventSpan,
} from "../selection-events.js";

/** Where a copy of the conversation reads its selection and its rows' text. */
export interface ConversationCopySource {
  /** The viewport's record of the selection, kept while rows it runs through are let go. */
  readonly selectionTracker: ViewportSelectionTracker;
  /**
   * The keys of the rows the selection runs across, in log order; empty unless the log holds both
   * of its ends.
   */
  readonly selectedRowKeys: () => readonly string[];
  /** The windows the viewport was handed, which the events of a selection's ends are read from. */
  readonly rowSourceWindows: RowSourceWindows;
  /** A whole row's text from the source it is drawn from, as `transcriptWindow` holds it. */
  readonly rowText: (
    rowKey: string,
    transcriptWindow: TranscriptWindowModel,
  ) => SelectedPart | undefined;
  /** How rows the store let go are read back, or `undefined` for a composition with no history. */
  readonly history: ConversationCopyHistory | undefined;
}

/** What a copy reads the rows the store let go through. */
export interface ConversationCopyHistory {
  readonly sessionStore: SessionStore;
  readonly readPage: TranscriptPageRead;
  /** The window the feed would draw over `events`, folded and cut as the reader's runs stand. */
  readonly deriveDrawnWindow: (events: readonly ProjectedSessionEvent[]) => TranscriptWindowModel;
}

/** A copy whose rows the store let go, as it stood when the key was pressed. */
interface HistoryCopy {
  readonly selection: RowSelection;
  readonly span: SelectionEventSpan;
  /** Each end row as it was drawn, taken before anything waits. */
  readonly endRows: ReadonlyMap<string, Element>;
  readonly held: HeldTranscript;
}

const COPY_FAILED_ANNOUNCEMENT = "Could not copy";

/**
 * Answers the page's `copy` for one conversation while it is mounted. A copy of a selection in the
 * conversation, or crossing it, goes through main as its flavors, read from the viewport's record
 * of it, while focus may sit in the message box; the page's text around a crossing selection is
 * joined in document order. A selection that misses the conversation is left to the platform. The
 * first conversation that writes a copy takes it, so with several open, one write reaches the
 * clipboard. A selection the store let rows of go is read back a page at a time between the
 * events its ends sit in, then written whole in one write, or not at all when a page is refused;
 * the newest copy wins. A selection settled in the conversation, by a drag or the keys, hands the
 * same text to the system's primary selection. A refused write or read is said aloud.
 */
export function useConversationCopy(source: ConversationCopySource): void {
  const bridge = usePlatformBridge();
  const announce = useAnnounce();
  const ownerDocument = useOwnerWindow().document;
  const { selectionTracker, selectedRowKeys, rowText, history } = source;
  const primarySelection = useMemo(() => primarySelectionFor(bridge), [bridge]);
  const rowSourceWindows = useLatestRef(source.rowSourceWindows);
  const [eventSpan] = useState(() => new SelectionEventSpanRecord());
  // Every copy takes the next number; a read back writes only while its number is the newest.
  const copyCount = useRef(0);
  useEffect(
    () =>
      selectionTracker.subscribeToRecord(() => {
        const windows = rowSourceWindows.current;
        const spanOf = rowSourceSpanReader(windows);
        eventSpan.note(selectionTracker.selection, (rowKey) =>
          spanOf(
            readRunWindowEdgeKey(rowKey, windows.transcriptWindow.runGroupByHeaderKey)?.runGroup
              .key ?? rowKey,
          ),
        );
      }),
    [selectionTracker, rowSourceWindows, eventSpan],
  );
  useEffect(() => {
    const readHeld = (): TextClipboardContent | undefined => {
      const selection = selectionTracker.selection;
      const transcriptWindow = rowSourceWindows.current.transcriptWindow;
      return selection === undefined
        ? undefined
        : readRowSpanSelection({
            selection,
            rowKeys: selectedRowKeys(),
            endRowElement: (rowKey) => selectionTracker.endRowElement(rowKey),
            rowText: (rowKey) => rowText(rowKey, transcriptWindow),
          });
    };
    // Everything the read back needs is taken here, before anything waits.
    const takeHistoryCopy = (): HistoryCopy | undefined => {
      const selection = selectionTracker.selection;
      const span = eventSpan.span;
      if (selection === undefined || span === undefined || history === undefined) {
        return undefined;
      }
      const endRows = new Map<string, Element>();
      for (const rowKey of [selection.start.rowKey, selection.end.rowKey]) {
        const endRow = selectionTracker.endRowElement(rowKey);
        if (endRow !== undefined) {
          endRows.set(rowKey, endRow.cloneNode(true) as Element);
        }
      }
      const state = history.sessionStore.snapshot();
      return {
        selection,
        span,
        endRows,
        held: {
          events: state.transcript,
          headCursor: state.transcriptHead.hasMore ? state.transcriptHead.cursor : undefined,
        },
      };
    };
    const readBack = async (
      copy: HistoryCopy,
      readHistory: ConversationCopyHistory,
      isCurrent: () => boolean,
    ): Promise<TextClipboardContent | undefined> => {
      const events = await readSelectedEvents(copy.span, copy.held, {
        readPage: readHistory.readPage,
        sessionId: readHistory.sessionStore.sessionId,
        isCurrent,
      });
      if (events === undefined) {
        return undefined;
      }
      const transcriptWindow = readHistory.deriveDrawnWindow(events);
      const rowKeys = transcriptWindow.viewportRows.map((row) => row.key);
      const first = rowKeys.indexOf(copy.selection.start.rowKey);
      const last = rowKeys.indexOf(copy.selection.end.rowKey);
      if (first === -1 || last < first) {
        throw new Error("The rows read back do not hold the selection's ends.");
      }
      return readRowSpanSelection({
        selection: copy.selection,
        rowKeys: rowKeys.slice(first, last + 1),
        endRowElement: (rowKey) => copy.endRows.get(rowKey),
        rowText: (rowKey) => rowText(rowKey, transcriptWindow),
      });
    };
    const write = (content: TextClipboardContent): void => {
      bridge.native.copyToClipboard(content).catch(() => {
        announce(COPY_FAILED_ANNOUNCEMENT, "assertive");
      });
    };
    const copySelection = (event: ClipboardEvent): void => {
      // Another conversation the selection crosses has written it.
      if (event.defaultPrevented || selectionTracker.selection === undefined) {
        return;
      }
      copyCount.current += 1;
      const copyNumber = copyCount.current;
      const isCurrent = (): boolean => copyCount.current === copyNumber;
      // The log holds both ends, so it holds every row between.
      if (selectedRowKeys().length > 0) {
        const content = readHeld();
        if (content !== undefined) {
          event.preventDefault();
          write(content);
        }
        return;
      }
      const copy = takeHistoryCopy();
      if (copy === undefined || history === undefined) {
        return;
      }
      event.preventDefault();
      readBack(copy, history, isCurrent)
        .then((content) => {
          if (content !== undefined && isCurrent()) {
            write(content);
          }
        })
        .catch(() => {
          // A newer copy stands in for this one, and says how it went.
          if (isCurrent()) {
            announce(COPY_FAILED_ANNOUNCEMENT, "assertive");
          }
        });
    };
    ownerDocument.addEventListener("copy", copySelection);
    const stopHearingSettles = selectionTracker.subscribeToSettledSelection(() => {
      primarySelection
        .takeSettledSelection(() => readHeld()?.text)
        .catch(() => {
          announce(COPY_FAILED_ANNOUNCEMENT, "assertive");
        });
    });
    return () => {
      ownerDocument.removeEventListener("copy", copySelection);
      stopHearingSettles();
    };
  }, [
    bridge,
    announce,
    ownerDocument,
    primarySelection,
    selectionTracker,
    selectedRowKeys,
    rowText,
    history,
    rowSourceWindows,
    eventSpan,
  ]);
}
