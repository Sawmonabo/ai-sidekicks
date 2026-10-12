import { useEffect, useMemo, useRef, useState } from "react";

import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import type { PiecedText } from "#renderer/lib/text-pieces.js";
import { startSlice } from "#renderer/lib/work-slices.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import {
  copyOnceBuilt,
  copyReadyContent,
  type PiecedTextClipboardContent,
} from "#renderer/services/platform/clipboard/late-copy.js";
import { primarySelectionFor } from "#renderer/services/platform/primary-selection/host.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type FullBodyReads } from "../../rows/full-body-reads.js";
import { ANSI_OUTPUT_KEY_ATTRIBUTE } from "../../rows/ansi/lines/markers.js";
import {
  type DrawnWindowSource,
  type DrawnWindowSources,
} from "../../rows/drawn-window-sources.js";
import { MARKDOWN_TABLE_KEY_ATTRIBUTE } from "../../rows/markdown/block-window/markers.js";
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
import { hasRunWindowEdge, rowKeysWithRunWindowCuts } from "../run-window-cuts.js";
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
   * body as `fullBodyOf` read it in full: at once, or once it is read in slices.
   */
  readonly rowText: (
    rowKey: string,
    transcriptWindow: TranscriptWindowModel,
    fullBodyOf: FullBodyOf,
  ) => SelectedPart | Promise<SelectedPart> | undefined;
  /**
   * The text of a row's body alone, read as `rowText` reads it: at once, or once a long output is
   * stripped of its escape sequences in slices.
   */
  readonly rowBodyText: (
    rowKey: string,
    transcriptWindow: TranscriptWindowModel,
    fullBodyOf: FullBodyOf,
  ) => string | Promise<string> | undefined;
  /** The id of the row at `rowKey` when its text reads a large body, read in full first. */
  readonly largeBodyRowIdOf: (
    rowKey: string,
    transcriptWindow: TranscriptWindowModel,
  ) => string | undefined;
  /** What a copy reads a large body in full through, or `undefined` where none is read. */
  readonly fullBodyReads: Pick<FullBodyReads, "readFullBody"> | undefined;
  /** What the feed's windows draw from, which a copy reads a spacer's undrawn items from. */
  readonly drawnWindowSources: DrawnWindowSources;
  /** How rows the store let go are read back, or `undefined` for a composition with no history. */
  readonly history: ConversationCopyHistory | undefined;
}

/** What a copy reads the rows the store let go through. */
export interface ConversationCopyHistory {
  readonly sessionStore: SessionStore;
  readonly readPage: TranscriptPageRead;
  /**
   * The windows over `events`: unfolded, and as the feed would draw them, folded and cut as the
   * reader's runs stand.
   */
  readonly deriveRowSourceWindows: (events: readonly ProjectedSessionEvent[]) => RowSourceWindows;
}

/** A copy whose rows the store let go, as it stood when the key was pressed. */
interface HistoryCopy {
  readonly selection: RowSelection;
  readonly span: SelectionEventSpan;
  /** Each end row as it was drawn, taken before anything waits. */
  readonly endRows: KeptEndRows;
  readonly held: HeldTranscript;
}

/** A copy's end rows as they were drawn, and the sources their spacers name, kept. */
interface KeptEndRows {
  readonly elements: ReadonlyMap<string, Element>;
  readonly drawnSources: ReadonlyMap<string, DrawnWindowSource>;
}

/** The rows a copy runs across, in log order, and where each is read from. */
interface RowSpanCopy {
  readonly selection: RowSelection;
  /** The rows' keys, each edge line of a run's window in place of the rows it cut. */
  readonly rowKeys: readonly string[];
  /** The log unfolded, which holds every row a key names, a run's cut rows among them. */
  readonly unfurledWindow: TranscriptWindowModel;
  /** An end row as it was drawn, or `undefined` when no drawing of it is kept. */
  readonly endRowElement: (rowKey: string) => Element | undefined;
  /** The source a spacer of an end row names, as it is drawn or was kept. */
  readonly drawnSourceOf: (sourceKey: string) => DrawnWindowSource | undefined;
}

/** A copy built at once, or one still building in slices from its end rows as they were drawn. */
type CopyBuilding =
  | Extract<ConversationCopyStep, { isBuilt: true }>
  | { readonly isBuilt: false; readonly build: ConversationCopyBuild };

/**
 * The rest of a copy's build, in slices: it hands the copy's plain text to `onText` as soon as
 * every row is read, and resolves the whole content.
 */
type CopyFinish = (
  onText: (text: PiecedText) => void,
) => Promise<PiecedTextClipboardContent | undefined>;

const COPY_FAILED_ANNOUNCEMENT = "Could not copy";

/** Where a copy's failures are recorded from in the window's diagnostics. */
const CONVERSATION_COPY_SOURCE = "features/transcript/useConversationCopy";

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
    drawnWindowSources,
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
  // A copy still building once the pane goes stops, and says nothing.
  useEffect(
    () => () => {
      copyCount.current += 1;
      settleCount.current += 1;
    },
    [],
  );
  useEffect(() => {
    // The rows the log holds between the selection's ends, read where they are drawn now. A run's
    // rows its window cut may be let go, so a selection reaching an edge line is read back instead,
    // unless the copy is composed with no history, where the log holds every row.
    const takeHeldCopy = (): RowSpanCopy | undefined => {
      const selection = selectionTracker.selection;
      const drawnKeys = selectedRowKeys();
      const windows = rowSourceWindows.current;
      if (selection === undefined || drawnKeys.length === 0 || !holdsEndsOf(selection)) {
        return undefined;
      }
      if (history !== undefined && hasRunWindowEdge(drawnKeys, windows.transcriptWindow)) {
        return undefined;
      }
      return {
        selection,
        rowKeys: rowKeysWithRunWindowCuts(drawnKeys, windows.transcriptWindow),
        unfurledWindow: windows.unfurledWindow,
        endRowElement: (rowKey) => selectionTracker.endRowElement(rowKey),
        drawnSourceOf: (sourceKey) => drawnWindowSources.sourceOf(sourceKey),
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
    // Each end row as `endRowElement` draws it now, copied, and the sources its spacers name,
    // which a window scrolled away lets go, for a copy that waits.
    const keptEndRows = (
      selection: RowSelection,
      endRowElement: (rowKey: string) => Element | undefined,
    ): KeptEndRows => {
      const elements = new Map<string, Element>();
      const drawnSources = new Map<string, DrawnWindowSource>();
      for (const boundary of [selection.start, selection.end]) {
        const rowKey = rowKeyOf(boundary);
        const endRow = rowKey === undefined ? undefined : endRowElement(rowKey);
        if (rowKey === undefined || endRow === undefined) {
          continue;
        }
        elements.set(rowKey, endRow.cloneNode(true) as Element);
        for (const spacer of endRow.querySelectorAll(SPACER_SELECTOR)) {
          const sourceKey =
            spacer.getAttribute(MARKDOWN_TABLE_KEY_ATTRIBUTE) ??
            spacer.getAttribute(ANSI_OUTPUT_KEY_ATTRIBUTE) ??
            "";
          const drawnSource = drawnWindowSources.sourceOf(sourceKey);
          if (drawnSource !== undefined) {
            drawnSources.set(sourceKey, drawnSource);
          }
        }
      }
      return { elements, drawnSources };
    };
    const rowsOf = (copy: RowSpanCopy): ConversationCopyRows => ({
      selection: copy.selection,
      rowKeys: copy.rowKeys,
      endRowElement: copy.endRowElement,
      rowText: (rowKey, fullBodyOf) => rowText(rowKey, copy.unfurledWindow, fullBodyOf),
      rowBodyText: (rowKey, fullBodyOf) => rowBodyText(rowKey, copy.unfurledWindow, fullBodyOf),
      largeBodyRowIdOf: (rowKey) => largeBodyRowIdOf(rowKey, copy.unfurledWindow),
      fullBodyReads,
      drawnSourceOf: copy.drawnSourceOf,
      markdownWorker,
    });
    // A copy of rows drawn now, built at once when the slice taken now holds it all; otherwise the
    // rest is built in slices from its end rows copied now, as their drawing may change meanwhile.
    const buildHeldCopy = (copy: RowSpanCopy): CopyBuilding => {
      let { endRowElement, drawnSourceOf } = copy;
      const build = new ConversationCopyBuild(
        rowsOf({
          ...copy,
          endRowElement: (rowKey) => endRowElement(rowKey),
          drawnSourceOf: (sourceKey) => drawnSourceOf(sourceKey),
        }),
      );
      const firstSlice = build.buildWhile(startSlice());
      if (firstSlice.isBuilt) {
        return firstSlice;
      }
      const endRows = keptEndRows(copy.selection, copy.endRowElement);
      endRowElement = (rowKey) => endRows.elements.get(rowKey);
      drawnSourceOf = (sourceKey) => endRows.drawnSources.get(sourceKey);
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
          releasedStretches: state.releasedStretches,
        },
      };
    };
    // The copy's events read back, then its build over the windows the feed would draw them in;
    // `undefined` once a newer copy took over.
    const readBack = async (
      copy: HistoryCopy,
      readHistory: ConversationCopyHistory,
      isCurrent: () => boolean,
    ): Promise<ConversationCopyBuild | undefined> => {
      const events = await readSelectedEvents(copy.span, copy.held, {
        readPage: readHistory.readPage,
        sessionId: readHistory.sessionStore.sessionId,
        isCurrent,
      });
      if (events === undefined) {
        return undefined;
      }
      const windows = readHistory.deriveRowSourceWindows(events);
      const drawnKeys = windows.transcriptWindow.viewportRows.map((row) => row.key);
      const { start, end } = copy.selection;
      const first = start.at === "row" ? drawnKeys.indexOf(start.rowKey) : 0;
      const last = end.at === "row" ? drawnKeys.indexOf(end.rowKey) : drawnKeys.length - 1;
      if (first === -1 || last < first) {
        throw new Error("The rows read back do not hold the selection's ends.");
      }
      return new ConversationCopyBuild(
        rowsOf({
          selection: copy.selection,
          rowKeys: rowKeysWithRunWindowCuts(
            drawnKeys.slice(first, last + 1),
            windows.transcriptWindow,
          ),
          unfurledWindow: windows.unfurledWindow,
          endRowElement: (rowKey) => copy.endRows.elements.get(rowKey),
          drawnSourceOf: (sourceKey) => copy.endRows.drawnSources.get(sourceKey),
        }),
      );
    };
    // The person hears that the copy failed; its cause goes to the window's diagnostics.
    const sayCopyFailed = (failure: unknown): void => {
      recordRejectedRequest(CONVERSATION_COPY_SOURCE, "copy-failed", failure);
      announce(COPY_FAILED_ANNOUNCEMENT, "assertive");
    };
    // The plain text first, once every row is read, then its formatted flavor beside it while the
    // clipboard still holds that text; a copy whose text and flavor come together is one write.
    // Each write lands only while no newer copy, from any app, took the clipboard.
    const writeOnceBuilt = (finish: CopyFinish, isCurrent: () => boolean): void => {
      copyOnceBuilt(bridge, ownerWindow, async (lateWrite, addFormatting) => {
        // How the plain text written first went.
        let textWrite: Promise<TextWriteOutcome> | undefined;
        const content = await finish((text) => {
          if (isCurrent()) {
            textWrite = lateWrite({ text }).then(
              (isWritten): TextWriteOutcome => ({ outcome: isWritten ? "written" : "replaced" }),
              (failure: unknown): TextWriteOutcome => ({ outcome: "failed", failure }),
            );
          }
        });
        if (content === undefined || !isCurrent()) {
          return;
        }
        if (textWrite === undefined) {
          await lateWrite(content);
          return;
        }
        // Main compares against the clipboard's text, so the formatting waits for it to land.
        const written = await textWrite;
        if (written.outcome === "failed") {
          sayCopyFailed(written.failure);
          return;
        }
        if (written.outcome === "written" && content.html !== undefined) {
          await addFormatting(content.html);
        }
      }).catch((failure: unknown) => {
        // A newer copy stands in for this one, and says how it went.
        if (isCurrent()) {
          sayCopyFailed(failure);
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
          copyReadyContent(bridge, ownerWindow, building.content).catch((failure: unknown) => {
            sayCopyFailed(failure);
          });
        }
        return;
      }
      const copy = takeHistoryCopy();
      if (copy === undefined || history === undefined) {
        return;
      }
      event.preventDefault();
      writeOnceBuilt(async (onText) => {
        const build = await readBack(copy, history, isCurrent);
        return await build?.finish(ownerWindow, isCurrent, onText);
      }, isCurrent);
    };
    // A settled selection's text, its large bodies read in full, read back where the log does not
    // hold its rows; only the newest settle's is put.
    const readSettledText = async (isCurrent: () => boolean): Promise<PiecedText | undefined> => {
      const heldCopy = takeHeldCopy();
      const historyCopy = heldCopy === undefined ? takeHistoryCopy() : undefined;
      let text: PiecedText | undefined;
      if (heldCopy !== undefined) {
        const building = buildHeldCopy(heldCopy);
        text = building.isBuilt
          ? building.content?.text
          : await building.build.finishText(ownerWindow, isCurrent);
      } else if (historyCopy !== undefined && history !== undefined) {
        const build = await readBack(historyCopy, history, isCurrent);
        text = await build?.finishText(ownerWindow, isCurrent);
      }
      return isCurrent() ? text : undefined;
    };
    ownerWindow.document.addEventListener("copy", copySelection);
    const stopHearingSettles = selectionTracker.subscribeToSettledSelection(() => {
      settleCount.current += 1;
      const settleNumber = settleCount.current;
      const isCurrent = (): boolean => settleCount.current === settleNumber;
      primarySelection
        .takeSettledSelection(() => readSettledText(isCurrent), ownerWindow)
        .catch((failure: unknown) => {
          if (isCurrent()) {
            sayCopyFailed(failure);
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
    drawnWindowSources,
    history,
    rowSourceWindows,
    eventSpan,
  ]);
}

/**
 * How a late copy's plain text, written first, went: written, replaced by a newer copy, or failed.
 */
type TextWriteOutcome =
  | { readonly outcome: "written" | "replaced" }
  | { readonly outcome: "failed"; readonly failure: unknown };

/** Every spacer a window draws in place of items a copy reads from their source. */
const SPACER_SELECTOR = `[${MARKDOWN_TABLE_KEY_ATTRIBUTE}], [${ANSI_OUTPUT_KEY_ATTRIBUTE}]`;
