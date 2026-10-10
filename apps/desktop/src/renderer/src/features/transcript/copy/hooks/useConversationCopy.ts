import { useEffect, useMemo, useRef, useState } from "react";

import type { TextClipboardContent } from "#shared/preload-api.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import { startSlice } from "#renderer/lib/work-slices.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { LateClipboardCopy } from "#renderer/services/platform/late-clipboard-copy.js";
import { primarySelectionFor } from "#renderer/services/platform/primary-selection/host.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type FullBodyReads } from "../../rows/full-body-reads.js";
import { readRunWindowEdgeKey } from "../../runs/call-window.js";
import { rowKeyOf, type RowSelection } from "../../viewport/selection/record.js";
import { type ViewportSelectionTracker } from "../../viewport/selection/tracker.js";
import { rowSourceSpanReader, type RowSourceWindows } from "../../window/row-sources.js";
import { type TranscriptWindowModel } from "../../window/transcript-window.js";
import {
  ConversationCopyBuild,
  type ConversationCopyRows,
  type ConversationCopyStep,
  type FullBodyOf,
} from "../conversation-copy.js";
import { type SelectedPart } from "../conversation-selection.js";
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
   * The keys of the rows the log holds of the selection, in log order, an end of the conversation
   * reaching the log's edge row on its side; empty unless the log holds the rows of both ends.
   */
  readonly selectedRowKeys: () => readonly string[];
  /** The windows the viewport was handed, which the events of a selection's ends are read from. */
  readonly rowSourceWindows: RowSourceWindows;
  /**
   * A whole row's text from the source it is drawn from, as `transcriptWindow` holds it, a large
   * body as `fullBodyOf` read it in full.
   */
  readonly rowText: (
    rowKey: string,
    transcriptWindow: TranscriptWindowModel,
    fullBodyOf: FullBodyOf,
  ) => SelectedPart | undefined;
  /** The text of a row's body alone, read as `rowText` reads it. */
  readonly rowBodyText: (
    rowKey: string,
    transcriptWindow: TranscriptWindowModel,
    fullBodyOf: FullBodyOf,
  ) => string | undefined;
  /** The id of the row at `rowKey` when its text reads a large body, read in full first. */
  readonly largeBodyRowIdOf: (
    rowKey: string,
    transcriptWindow: TranscriptWindowModel,
  ) => string | undefined;
  /** What a copy reads a large body in full through, or `undefined` where none is read. */
  readonly fullBodyReads: Pick<FullBodyReads, "readFullBody"> | undefined;
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

/** The rows a copy runs across, in log order, and where each is read from. */
interface RowSpanCopy {
  readonly selection: RowSelection;
  readonly rowKeys: readonly string[];
  readonly transcriptWindow: TranscriptWindowModel;
  /** An end row as it was drawn, or `undefined` when no drawing of it is kept. */
  readonly endRowElement: (rowKey: string) => Element | undefined;
}

/** A copy built at once, or one still building in slices from its end rows as they were drawn. */
type CopyBuilding =
  | Extract<ConversationCopyStep, { isBuilt: true }>
  | { readonly isBuilt: false; readonly build: ConversationCopyBuild };

/**
 * The rest of a copy's build, in slices: it hands the copy's plain text to `onText` as soon as
 * every row is read, and resolves the whole content.
 */
type CopyFinish = (onText: (text: string) => void) => Promise<TextClipboardContent | undefined>;

const COPY_FAILED_ANNOUNCEMENT = "Could not copy";

/**
 * Answers the page's `copy` for one conversation while it is mounted. A copy of a selection in the
 * conversation, or crossing it, goes through main as its flavors, read from the viewport's record
 * of it, while focus may sit in the message box; the page's text around a crossing selection is
 * joined in document order. A selection that misses the conversation is left to the platform. The
 * first conversation that writes a copy takes it, so with several open, one write reaches the
 * clipboard. A selection the store let rows of go is read back a page at a time between the events
 * its ends sit in. A copy is built a slice at a time, so it holds no frame however long, and a
 * large body it takes in is read in full just before its row, opened or not. A copy built at once
 * is written whole in one write. One that builds longer writes its plain text as soon as every row
 * is read, only while the clipboard holds what it held when the key was pressed, then adds its
 * formatted flavor only while the clipboard still holds that text, so a newer copy made meanwhile,
 * here or in another app, stands. Nothing is written when a page or a body is refused; the newest
 * copy wins. A selection settled in the conversation, by a drag or the keys, hands the same text to
 * the system's primary selection. A refused write or read is said aloud.
 */
export function useConversationCopy(source: ConversationCopySource): void {
  const bridge = usePlatformBridge();
  const announce = useAnnounce();
  const ownerWindow = useOwnerWindow();
  const {
    selectionTracker,
    selectedRowKeys,
    rowText,
    rowBodyText,
    largeBodyRowIdOf,
    fullBodyReads,
    history,
  } = source;
  const primarySelection = useMemo(() => primarySelectionFor(bridge), [bridge]);
  const rowSourceWindows = useLatestRef(source.rowSourceWindows);
  const [eventSpan] = useState(() => new SelectionEventSpanRecord());
  // Every copy takes the next number; a read back writes only while its number is the newest.
  const copyCount = useRef(0);
  // So does every settled selection, which puts its text only while its number is the newest.
  const settleCount = useRef(0);
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
    // The rows the log holds between the selection's ends, read where they are drawn now.
    const takeHeldCopy = (): RowSpanCopy | undefined => {
      const selection = selectionTracker.selection;
      const rowKeys = selectedRowKeys();
      return selection === undefined || rowKeys.length === 0 || !holdsEndsOf(selection)
        ? undefined
        : {
            selection,
            rowKeys,
            transcriptWindow: rowSourceWindows.current.transcriptWindow,
            endRowElement: (rowKey) => selectionTracker.endRowElement(rowKey),
          };
    };
    // Whether the store's log holds each end of the conversation the selection reaches; a copy
    // composed with no history holds the whole conversation.
    const holdsEndsOf = (selection: RowSelection): boolean => {
      if (history === undefined) {
        return true;
      }
      const state = history.sessionStore.snapshot();
      return (
        (selection.start.at !== "conversation-start" || !state.transcriptHead.hasMore) &&
        (selection.end.at !== "conversation-end" || state.transcriptTail.following === "live")
      );
    };
    // Each end row as `endRowElement` draws it now, copied, for a copy that waits.
    const keptEndRows = (
      selection: RowSelection,
      endRowElement: (rowKey: string) => Element | undefined,
    ): ReadonlyMap<string, Element> => {
      const endRows = new Map<string, Element>();
      for (const boundary of [selection.start, selection.end]) {
        const rowKey = rowKeyOf(boundary);
        const endRow = rowKey === undefined ? undefined : endRowElement(rowKey);
        if (rowKey !== undefined && endRow !== undefined) {
          endRows.set(rowKey, endRow.cloneNode(true) as Element);
        }
      }
      return endRows;
    };
    const rowsOf = (copy: RowSpanCopy): ConversationCopyRows => ({
      selection: copy.selection,
      rowKeys: copy.rowKeys,
      endRowElement: copy.endRowElement,
      rowText: (rowKey, fullBodyOf) => rowText(rowKey, copy.transcriptWindow, fullBodyOf),
      rowBodyText: (rowKey, fullBodyOf) => rowBodyText(rowKey, copy.transcriptWindow, fullBodyOf),
      largeBodyRowIdOf: (rowKey) => largeBodyRowIdOf(rowKey, copy.transcriptWindow),
      fullBodyReads,
      markdownWorker,
    });
    // A copy of rows drawn now, built at once when the slice taken now holds it all; otherwise the
    // rest is built in slices from its end rows copied now, as their drawing may change meanwhile.
    const buildHeldCopy = (copy: RowSpanCopy): CopyBuilding => {
      let endRowElement = copy.endRowElement;
      const build = new ConversationCopyBuild(
        rowsOf({ ...copy, endRowElement: (rowKey) => endRowElement(rowKey) }),
      );
      const firstSlice = build.buildWhile(startSlice());
      if (firstSlice.isBuilt) {
        return firstSlice;
      }
      const endRows = keptEndRows(copy.selection, copy.endRowElement);
      endRowElement = (rowKey) => endRows.get(rowKey);
      return { isBuilt: false, build };
    };
    // Everything the read back needs is taken here, before anything waits.
    const takeHistoryCopy = (): HistoryCopy | undefined => {
      const selection = selectionTracker.selection;
      if (selection === undefined || history === undefined) {
        return undefined;
      }
      const state = history.sessionStore.snapshot();
      const span = eventSpan.readSpan(
        state.streamAfterCursor === undefined
          ? undefined
          : { sequence: state.cursor, cursor: state.streamAfterCursor },
      );
      if (span === undefined) {
        return undefined;
      }
      return {
        selection,
        span,
        endRows: keptEndRows(selection, (rowKey) => selectionTracker.endRowElement(rowKey)),
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
      onText: (text: string) => void,
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
      const { start, end } = copy.selection;
      const first = start.at === "row" ? rowKeys.indexOf(start.rowKey) : 0;
      const last = end.at === "row" ? rowKeys.indexOf(end.rowKey) : rowKeys.length - 1;
      if (first === -1 || last < first) {
        throw new Error("The rows read back do not hold the selection's ends.");
      }
      const readBackCopy: RowSpanCopy = {
        selection: copy.selection,
        rowKeys: rowKeys.slice(first, last + 1),
        transcriptWindow,
        endRowElement: (rowKey) => copy.endRows.get(rowKey),
      };
      return await new ConversationCopyBuild(rowsOf(readBackCopy)).finish(
        ownerWindow,
        isCurrent,
        onText,
      );
    };
    const sayCopyFailed = (): void => {
      announce(COPY_FAILED_ANNOUNCEMENT, "assertive");
    };
    const write = (content: TextClipboardContent): void => {
      bridge.native.copyToClipboard(content).catch(sayCopyFailed);
    };
    // The plain text first, once every row is read, then its formatted flavor beside it while the
    // clipboard still holds that text; a copy whose text and flavor come together is one write.
    // Each write lands only while no newer copy, from any app, took the clipboard.
    const writeOnceBuilt = (finish: CopyFinish, isCurrent: () => boolean): void => {
      const lateCopy = new LateClipboardCopy(bridge);
      // How the plain text written first went.
      let textWrite: Promise<"written" | "replaced" | "failed"> | undefined;
      finish((text) => {
        if (isCurrent()) {
          textWrite = lateCopy.write({ text }).then(
            (isWritten) => (isWritten ? "written" : "replaced"),
            () => "failed",
          );
        }
      })
        .then(async (content) => {
          if (content === undefined || !isCurrent()) {
            return;
          }
          if (textWrite === undefined) {
            await lateCopy.write(content);
            return;
          }
          // Main compares against the clipboard's text, so the formatting waits for it to land.
          const written = await textWrite;
          if (written === "failed") {
            sayCopyFailed();
            return;
          }
          if (written === "written" && content.html !== undefined) {
            await bridge.native.addClipboardFormatting({ text: content.text, html: content.html });
          }
        })
        .catch(() => {
          // A newer copy stands in for this one, and says how it went.
          if (isCurrent()) {
            sayCopyFailed();
          }
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
      const heldCopy = takeHeldCopy();
      if (heldCopy !== undefined) {
        const building = buildHeldCopy(heldCopy);
        if (!building.isBuilt) {
          event.preventDefault();
          writeOnceBuilt(
            (onText) => building.build.finish(ownerWindow, isCurrent, onText),
            isCurrent,
          );
          return;
        }
        if (building.content !== undefined) {
          event.preventDefault();
          write(building.content);
        }
        return;
      }
      const copy = takeHistoryCopy();
      if (copy === undefined || history === undefined) {
        return;
      }
      event.preventDefault();
      writeOnceBuilt((onText) => readBack(copy, history, isCurrent, onText), isCurrent);
    };
    // A settled selection's text, its large bodies read in full; only the newest settle's is put.
    const readSettledText = async (isCurrent: () => boolean): Promise<string | undefined> => {
      const heldCopy = takeHeldCopy();
      if (heldCopy === undefined) {
        return undefined;
      }
      const building = buildHeldCopy(heldCopy);
      const text = building.isBuilt
        ? building.content?.text
        : await building.build.finishText(ownerWindow, isCurrent);
      return isCurrent() ? text : undefined;
    };
    ownerWindow.document.addEventListener("copy", copySelection);
    const stopHearingSettles = selectionTracker.subscribeToSettledSelection(() => {
      settleCount.current += 1;
      const settleNumber = settleCount.current;
      const isCurrent = (): boolean => settleCount.current === settleNumber;
      primarySelection
        .takeSettledSelection(() => readSettledText(isCurrent))
        .catch(() => {
          if (isCurrent()) {
            announce(COPY_FAILED_ANNOUNCEMENT, "assertive");
          }
        });
    });
    return () => {
      ownerWindow.document.removeEventListener("copy", copySelection);
      stopHearingSettles();
    };
  }, [
    bridge,
    announce,
    ownerWindow,
    primarySelection,
    selectionTracker,
    selectedRowKeys,
    rowText,
    rowBodyText,
    largeBodyRowIdOf,
    fullBodyReads,
    history,
    rowSourceWindows,
    eventSpan,
  ]);
}
