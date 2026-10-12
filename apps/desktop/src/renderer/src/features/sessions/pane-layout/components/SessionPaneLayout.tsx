// The session view's pane layout: the conversation and, beside it, the block of panes — the row
// of main panes in the person's order and the terminal above or below it — with the one place
// each pane body is mounted from the pane registry by kind. Layout lives in `PaneLayoutStore`;
// this component subscribes and dispatches.
//
// A pane's header drags it along the row on the shared pointer reorder, or past the middle of the
// conversation to move the whole block to its other side; the terminal's header drags it above or
// below the row. The block scrolls sideways when the row does not fit beside the conversation's
// floor, and a pane just opened is scrolled into view. The window's chords move the focused pane
// (`contributions/commands.ts`); the block's own keys focus and close panes.

import "./SessionPaneLayout.css";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { PaneEdgeDragContext } from "#renderer/components/PaneEdge/drag-context.js";
import { type PaneEdgeReading } from "#renderer/components/PaneEdge/PaneEdge.js";
import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { isEditableTarget, isUnclaimedEscape } from "#renderer/lib/editable-target.js";
import { revealInRow } from "#renderer/lib/scroll/chokepoint.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useDrawOverlayScrollbar } from "#renderer/hooks/useDrawOverlayScrollbar.js";
import { useRootFontSizePx } from "#renderer/hooks/useRootFontSizePx.js";
import { useReorderDrag, type ReorderDragSettings } from "#renderer/hooks/useReorderDrag.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { type PaneRegistry } from "#renderer/registries/panes/registry.js";
import type { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";
import {
  CONVERSATION_FLOOR_REM,
  PANE_ROW_HEIGHT_FLOOR_REM,
  TERMINAL_PANE_HEIGHT_FLOOR_REM,
} from "#renderer/styles/palette.js";
import { usePaneLayoutState } from "../hooks/usePaneLayoutState.js";
import { useKeptPaneSizes } from "../hooks/useKeptPaneSizes.js";
import { type PaneLayoutStore } from "../store.js";
import { paneLayoutActsOn } from "../acts.js";
import { useMountedPaneLayout } from "../hooks/useMountedPaneLayout.js";
import { rowPanes, terminalPane, type SessionPane } from "../state.js";
import { commitPaneDrop } from "../drag.js";
import { PANE_WIDTH_RULE_BY_KIND } from "../widths.js";
import { readSessionWorkspace } from "../../services/session-workspace.js";
import { SessionPaneSlot, paneSlotSelector, type PaneSlotPlacement } from "./SessionPaneSlot.js";

/** What the pane layout needs: its store, its registry, each pane's context, the conversation. */
export interface SessionPaneLayoutProps {
  readonly layout: PaneLayoutStore;
  /** Where pane bodies come from. Passed rather than reached for, so a host picks its own. */
  readonly registry: PaneRegistry;
  /** What each pane's body is handed, or why its address cannot be served. */
  readonly paneContextFor: (pane: SessionPane) => PaneContext | Refusal;
  /** Whether the session's store has opened; until it has, each pane draws its frame alone. */
  readonly isSessionOpen: boolean;
  /** The session the panes are about, which a pane's frame names while it draws no body. */
  readonly sessionId: string | undefined;
  /** The conversation the block stands beside: its header, transcript and composer. */
  readonly conversation: React.ReactNode;
  /** The durable store the pane sizes a person set are kept in, for this install. */
  readonly uiStateStore: UiStateStore;
  /** Told each refusal of the kept sizes: a read that failed, or a write the store refused. */
  readonly onPaneSizesRefused: (refusal: Refusal) => void;
}

/** The conversation and the block of panes beside it, arranged by a `PaneLayoutStore`. */
export function SessionPaneLayout(props: SessionPaneLayoutProps): React.JSX.Element {
  const { layout } = props;
  const state = usePaneLayoutState(layout);
  const layoutRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const drawBlockScrollbar = useDrawOverlayScrollbar(blockRef);
  const [isOverConversation, setIsOverConversation] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  // The pane holding the window's focus, so a pane closed under focus hands it on.
  const focusHolderPaneIdRef = useRef<string | undefined>(undefined);

  // Read here, in the component with the context: outside `LiveAnnouncerProvider` this throws
  // instead of moving panes in a silence nobody can detect.
  const announce = useAnnounce();
  const clock = useClock();
  const row = useMemo(() => rowPanes(state.panes), [state.panes]);
  const terminal = terminalPane(state.panes);
  const isFull = state.fullWidthPaneId !== undefined;
  const sizes = useKeptPaneSizes(props.uiStateStore);
  const { onPaneSizesRefused } = props;
  useEffect(() => {
    if (sizes.lastRefusal !== undefined) {
      onPaneSizesRefused(sizes.lastRefusal);
    }
  }, [sizes.lastRefusal, onPaneSizesRefused]);

  // Focusing a pane moves DOM focus into its frame, and the slot's `focusin` moves the layout's
  // focus with it; the pane is brought into view along the row by the chokepoint, never by the
  // focus itself. A pane hidden behind another's full width takes no DOM focus, so the layout is
  // moved to it directly too.
  const focusPaneFrame = useCallback(
    (paneId: string) => {
      const block = blockRef.current;
      const slot = block?.querySelector<HTMLElement>(paneSlotSelector(paneId));
      if (block !== null && slot !== null && slot !== undefined) {
        slot.querySelector<HTMLElement>(".meridian-pane")?.focus({ preventScroll: true });
        revealInRow(block, slot, "pane-reveal");
      }
      layout.focus(paneId);
    },
    [layout],
  );

  const bridge = usePlatformBridge();
  const { sessionId } = props;
  // Built once per (layout, announcer, session) and shared by this component's keys, the window's
  // chords and the palette rows in `contributions/commands.ts`, so a chord and a row cannot mean
  // two moves.
  const acts = useMemo(
    () =>
      paneLayoutActsOn(layout, announce, {
        focusPane: focusPaneFrame,
        readInspectedCheckout: async () =>
          sessionId === undefined
            ? { status: "served", value: undefined }
            : readSessionWorkspace(bridge, sessionId),
      }),
    [layout, announce, focusPaneFrame, bridge, sessionId],
  );
  useMountedPaneLayout(acts);

  // A pane holding the full width does not move; the order it sits in stays as it was.
  const rowKeys = useMemo(() => (isFull ? [] : row.map((pane) => pane.paneId)), [isFull, row]);
  const commitRowMove = useCallback(
    (paneId: string, toPosition: number) => {
      commitPaneDrop(layout, paneId, { kind: "row", toPosition }, announce);
    },
    [layout, announce],
  );
  const rowSettings: ReorderDragSettings<string> = {
    onDropInPlace: (paneId) => {
      commitPaneDrop(layout, paneId, { kind: "in-place" }, announce);
    },
    beyond: {
      // Past the middle of the conversation, the block would move to its other side.
      contains: (pointerX) => {
        const box = conversationRef.current?.getBoundingClientRect();
        if (box === undefined) {
          return false;
        }
        const middle = box.left + box.width / 2;
        return state.side === "right" ? pointerX < middle : pointerX > middle;
      },
      onHover: setIsOverConversation,
      onDrop: (paneId) => {
        commitPaneDrop(layout, paneId, { kind: "across-conversation" }, announce);
      },
    },
  };
  const rowDrag = useReorderDrag("horizontal", rowKeys, commitRowMove, clock, rowSettings);
  // The block moved sides under a pane let go past the conversation: glide it from where the hand
  // left it. Nothing is waiting after a chord's move, so the settle is then a no-op.
  useLayoutEffect(() => {
    rowDrag.settle();
  }, [rowDrag, state.side]);

  const isStacked = terminal !== undefined && row.length > 0;
  const terminalKeys = useMemo(() => {
    if (terminal === undefined || !isStacked || isFull) {
      return [];
    }
    return state.terminalPlace === "above"
      ? [terminal.paneId, ROW_KEY]
      : [ROW_KEY, terminal.paneId];
  }, [terminal, isStacked, isFull, state.terminalPlace]);
  const commitTerminalMove = useCallback(
    (paneId: string, toIndex: number) => {
      const place = toIndex === 0 ? "above" : "below";
      commitPaneDrop(layout, paneId, { kind: "terminal", place }, announce);
    },
    [layout, announce],
  );
  const terminalDrag = useReorderDrag("vertical", terminalKeys, commitTerminalMove, clock, {
    isHandleRequired: true,
    onDropInPlace: (paneId) => {
      commitPaneDrop(layout, paneId, { kind: "in-place" }, announce);
    },
  });

  // A pane just opened, or brought forward again, is scrolled into view along the row, and one
  // opened while this view is drawn takes the window's focus: the pane focused before it takes
  // the focus back when it closes. One opened before the view was drawn takes none, so drawing
  // the view never moves the focus.
  const lastOpened = state.lastOpened;
  const drawnSinceSerialRef = useRef(lastOpened?.serial ?? 0);
  useLayoutEffect(() => {
    const block = blockRef.current;
    if (lastOpened === undefined || block === null) {
      return;
    }
    if (lastOpened.serial > drawnSinceSerialRef.current) {
      drawnSinceSerialRef.current = lastOpened.serial;
      focusPaneFrame(lastOpened.paneId);
      return;
    }
    const slot = block.querySelector(paneSlotSelector(lastOpened.paneId));
    if (slot !== null) {
      revealInRow(block, slot, "pane-reveal");
    }
  }, [lastOpened, focusPaneFrame]);

  // A pane closed while it held the window's focus hands it to the pane the layout now focuses,
  // rather than leaving it on the document's body.
  const focusedPaneId = state.focusedPaneId;
  useLayoutEffect(() => {
    const holder = focusHolderPaneIdRef.current;
    const activeElement = layoutRef.current?.ownerDocument.activeElement;
    if (
      holder === undefined ||
      focusedPaneId === undefined ||
      state.panes.some((pane) => pane.paneId === holder) ||
      // Focus the person already moved elsewhere stays where they put it.
      (activeElement?.isConnected === true && activeElement !== activeElement.ownerDocument.body)
    ) {
      return;
    }
    focusHolderPaneIdRef.current = undefined;
    focusPaneFrame(focusedPaneId);
  }, [state.panes, focusedPaneId, focusPaneFrame]);

  const onBlockFocus = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    focusHolderPaneIdRef.current =
      event.target.closest<HTMLElement>(paneSlotSelector())?.dataset["paneId"];
  }, []);
  const onBlockBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    // Focus that left for somewhere else is no longer a pane's to hand on.
    if (event.relatedTarget !== null && !event.currentTarget.contains(event.relatedTarget)) {
      focusHolderPaneIdRef.current = undefined;
    }
  }, []);

  const fullWidthPaneId = state.fullWidthPaneId;
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Escape typed into a field, the terminal's shell among them, stays the field's.
      if (
        fullWidthPaneId !== undefined &&
        isUnclaimedEscape(event) &&
        !isEditableTarget(event.target)
      ) {
        layout.setFullWidth(undefined);
        event.preventDefault();
        return;
      }
      // `Alt` alone, so nothing collides with the palette's `$mod` chords or the window's
      // `Alt+Shift` moves.
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      // Not from inside a widget that owns these keys: on macOS Option+Arrow moves the caret
      // by word and Option+Backspace deletes a word, and a find field, composer or listbox
      // bubbles those here. The chords stay available from the pane chrome.
      if (isEditableTarget(event.target)) {
        return;
      }
      switch (event.key) {
        case "ArrowRight":
          acts.focusNextPane();
          event.preventDefault();
          return;
        case "ArrowLeft":
          acts.focusPreviousPane();
          event.preventDefault();
          return;
        case "Backspace":
        case "Delete":
          // Consumed only where there is a pane to close, so an unfocused layout leaves
          // Backspace to whatever else wanted it, as the window's binding table does.
          if (focusedPaneId !== undefined) {
            acts.closeFocusedPane();
            event.preventDefault();
          }
          return;
        default:
          return;
      }
    },
    [acts, layout, fullWidthPaneId, focusedPaneId],
  );

  const focusPane = useCallback(
    (paneId: string) => {
      layout.focus(paneId);
    },
    [layout],
  );
  const closePane = useCallback(
    (paneId: string) => {
      layout.close(paneId);
    },
    [layout],
  );
  const toggleFullWidth = useCallback(
    (paneId: string) => {
      layout.setFullWidth(layout.snapshot().fullWidthPaneId === paneId ? undefined : paneId);
    },
    [layout],
  );
  // Every limit is root-relative, so each measure is a new function at a new text size and the
  // edges read their limits again.
  const rootPx = useRootFontSizePx();
  // A pane may be dragged as wide as leaves the conversation its floor.
  const measureWidthCeilingPx = useCallback((): number => {
    const element = layoutRef.current;
    if (element === null) {
      return 0;
    }
    return element.getBoundingClientRect().width - CONVERSATION_FLOOR_REM * rootPx;
  }, [rootPx]);
  const { terminalHeightPx, setPaneWidth, setTerminalHeight } = sizes;
  // The terminal and the row each keep the height they stop being readable under.
  const measureTerminalHeight = useCallback((): PaneEdgeReading => {
    const block = blockRef.current;
    const stacked = block?.querySelector('[data-placement="terminal-stacked"]');
    if (block === null || stacked === null || stacked === undefined) {
      throw new Error("The terminal's height was measured with no terminal stacked in the block.");
    }
    return {
      sizePx: terminalHeightPx ?? stacked.getBoundingClientRect().height,
      minimumPx: TERMINAL_PANE_HEIGHT_FLOOR_REM * rootPx,
      maximumPx: block.clientHeight - PANE_ROW_HEIGHT_FLOOR_REM * rootPx,
    };
  }, [terminalHeightPx, rootPx]);
  const previewTerminalHeight = useCallback((heightPx: number | undefined) => {
    if (heightPx === undefined) {
      blockRef.current?.style.removeProperty(LIVE_TERMINAL_HEIGHT_PROPERTY);
    } else {
      blockRef.current?.style.setProperty(LIVE_TERMINAL_HEIGHT_PROPERTY, `${String(heightPx)}px`);
    }
  }, []);

  const slotFor = (pane: SessionPane, placement: PaneSlotPlacement): React.JSX.Element => {
    const drag = placement === "row" ? rowDrag : terminalDrag;
    return (
      <SessionPaneSlot
        key={pane.paneId}
        pane={pane}
        placement={placement}
        side={state.side}
        terminalPlace={state.terminalPlace}
        widthPx={sizes.widthsPx[pane.kind]}
        isFullWidth={state.fullWidthPaneId === pane.paneId}
        registry={props.registry}
        paneContextFor={props.paneContextFor}
        isSessionOpen={props.isSessionOpen}
        sessionId={props.sessionId}
        registerItem={drag.itemRef(pane.paneId)}
        registerDragHandle={drag.handleRef(pane.paneId)}
        measureWidthCeilingPx={measureWidthCeilingPx}
        measureTerminalHeight={measureTerminalHeight}
        previewTerminalHeight={previewTerminalHeight}
        onSetWidth={setPaneWidth}
        onSetTerminalHeight={setTerminalHeight}
        onResizingChange={setIsResizing}
        onFocus={focusPane}
        onClose={closePane}
        onToggleFullWidth={toggleFullWidth}
      />
    );
  };

  // The narrowest the block's content gets: every row pane at its floor, or the terminal alone.
  const floorPanes = row.length > 0 ? row : state.panes;
  const blockStyle: PaneBlockStyle = {
    "--meridian-pane-row-floor": `${String(
      floorPanes.reduce((sum, pane) => sum + PANE_WIDTH_RULE_BY_KIND[pane.kind].floorRem, 0),
    )}rem`,
    ...(terminalHeightPx === undefined
      ? {}
      : { "--meridian-terminal-pane-height": `${String(terminalHeightPx)}px` }),
  };
  return (
    <div
      ref={layoutRef}
      className="meridian-pane-layout"
      data-side={state.side}
      data-full-width={isFull ? "" : undefined}
      data-resizing={isResizing ? "" : undefined}
    >
      <div ref={conversationRef} className="meridian-pane-layout__conversation">
        <PaneEdgeDragContext value={isResizing}>{props.conversation}</PaneEdgeDragContext>
      </div>
      {state.panes.length === 0 ? null : (
        <div
          ref={drawBlockScrollbar}
          className="meridian-pane-layout__block"
          data-terminal={terminal === undefined ? undefined : isStacked ? "stacked" : "alone"}
          data-terminal-place={state.terminalPlace}
          style={blockStyle}
          role="group"
          aria-label="Open panes"
          onKeyDown={onKeyDown}
          onFocus={onBlockFocus}
          onBlur={onBlockBlur}
        >
          {row.length === 0 ? null : (
            <div className="meridian-pane-layout__row" ref={terminalDrag.itemRef(ROW_KEY)}>
              {row.map((pane) => slotFor(pane, "row"))}
            </div>
          )}
          {terminal === undefined
            ? null
            : slotFor(terminal, isStacked ? "terminal-stacked" : "terminal-alone")}
        </div>
      )}
      {isOverConversation ? (
        <div className="meridian-pane-layout__side-mark" aria-hidden="true" />
      ) : null}
    </div>
  );
}

/** The terminal drag's key for the row of main panes, which moves with it but is not dragged. */
const ROW_KEY = "$row";

/** The property a dragged divider draws the terminal's height on, ahead of the height it keeps. */
const LIVE_TERMINAL_HEIGHT_PROPERTY = "--meridian-terminal-pane-height-live";

/** Carries the row's floor and the terminal height a person set into the block's sheet. */
interface PaneBlockStyle extends React.CSSProperties {
  readonly "--meridian-pane-row-floor": string;
  readonly "--meridian-terminal-pane-height"?: string;
}
