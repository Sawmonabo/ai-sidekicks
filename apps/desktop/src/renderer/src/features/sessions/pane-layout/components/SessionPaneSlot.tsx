// One pane's place in the block: its frame and body, its width by its kind's rule, and its drag
// edge. `SessionPaneLayout.tsx` decides which panes exist, their order and focus; this file answers
// what is drawn for a single pane, including when nothing is registered for its kind.

import { memo, useCallback, useMemo, useRef } from "react";

import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { rootFontSizePx } from "#renderer/lib/root-font-size.js";
import { PaneControlsContext, type PaneControls } from "#renderer/components/PaneFrame/controls.js";
import { TITLE_BY_PANE_KIND } from "#renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { type PaneRegistry } from "#renderer/registries/panes/registry.js";
import type { BlockPaneKind } from "#renderer/routing/panes/kinds.js";
import { PaneBody } from "./PaneBody.js";
import { PaneEdge, type PaneEdgeReading } from "./PaneEdge.js";
import { type PaneBlockSide, type SessionPane, type TerminalPlace } from "../state.js";
import { PANE_WIDTH_RULE_BY_KIND } from "../widths.js";

/**
 * Where a pane stands: in the row, the terminal alone in the block at its own width, or the
 * terminal stacked against the row and as wide as it.
 */
export type PaneSlotPlacement = "row" | "terminal-alone" | "terminal-stacked";

/** What a pane slot is handed: the pane, where it stands, its registry and its handlers. */
export interface SessionPaneSlotProps {
  readonly pane: SessionPane;
  readonly placement: PaneSlotPlacement;
  readonly side: PaneBlockSide;
  readonly terminalPlace: TerminalPlace;
  /** The width a person set for this kind, in CSS px, or `undefined` at its rule's width. */
  readonly widthPx: number | undefined;
  readonly isFullWidth: boolean;
  readonly registry: PaneRegistry;
  /**
   * What this pane's body is handed, or why its address cannot be served. The kind and entity
   * come off a restored snapshot or a route, so the pair is not known to be an address until
   * it is parsed. The refusal arm is drawn instead of a body: a throw would take the whole
   * block down for one pane, and a body handed an address it cannot serve would query a
   * partition that never held the row.
   */
  readonly paneContextFor: (pane: SessionPane) => PaneContext | Refusal;
  /**
   * Whether the session's store has opened. Until it has, the pane draws its frame alone, at its
   * place and width with its address's trail, since its body reads the session.
   */
  readonly isSessionOpen: boolean;
  /** The session the pane is about, which its frame names while it draws no body. */
  readonly sessionId: string | undefined;
  /** Registers the element its drag moves. */
  readonly registerItem: (element: HTMLElement | null) => void;
  /** Registers the pane's header as the grip it is dragged by; absent while it cannot move. */
  readonly registerDragHandle: ((element: HTMLElement | null) => void) | undefined;
  /** The widest a pane may be dragged, in CSS px, measured at the moment of asking. */
  readonly measureWidthCeilingPx: () => number;
  /** The stacked terminal's height and its limits, for the divider between it and the row. */
  readonly measureTerminalHeight: () => PaneEdgeReading;
  readonly previewTerminalHeight: (heightPx: number | undefined) => void;
  readonly onSetWidth: (kind: BlockPaneKind, widthPx: number | undefined) => void;
  readonly onSetTerminalHeight: (heightPx: number | undefined) => void;
  readonly onResizingChange: (isResizing: boolean) => void;
  readonly onFocus: (paneId: string) => void;
  readonly onClose: (paneId: string) => void;
  readonly onToggleFullWidth: (paneId: string) => void;
}

/**
 * One pane's slot. Memoized because a session streams into several panes at once, and an
 * unmemoized map would re-render every pane body for every event that touches one.
 */
export const SessionPaneSlot: React.NamedExoticComponent<SessionPaneSlotProps> = memo(
  function SessionPaneSlotBody(props: SessionPaneSlotProps): React.JSX.Element {
    const { pane, onClose, onFocus, onToggleFullWidth, onSetWidth, registerItem } = props;
    const { measureWidthCeilingPx, widthPx, isFullWidth } = props;
    const descriptor = props.registry.descriptorFor(pane.kind);
    const rule = PANE_WIDTH_RULE_BY_KIND[pane.kind];
    const slotRef = useRef<HTMLDivElement | null>(null);

    const registerSlot = useCallback(
      (element: HTMLDivElement | null) => {
        slotRef.current = element;
        registerItem(element);
      },
      [registerItem],
    );

    const controls = useMemo<PaneControls>(
      () => ({
        onClose: () => {
          onClose(pane.paneId);
        },
        ...(props.registerDragHandle === undefined
          ? {}
          : { registerDragHandle: props.registerDragHandle }),
        ...(rule.isResizable
          ? {
              fullWidth: {
                isHeld: isFullWidth,
                toggle: () => {
                  onToggleFullWidth(pane.paneId);
                },
              },
            }
          : {}),
      }),
      [
        onClose,
        onToggleFullWidth,
        pane.paneId,
        props.registerDragHandle,
        rule.isResizable,
        isFullWidth,
      ],
    );

    const onFocusCapture = useCallback(() => {
      onFocus(pane.paneId);
    }, [onFocus, pane.paneId]);

    // A new reading whenever the kept width changes, so the edge reports it again. The pane's
    // own width, not what a narrow view draws it at: a press grows what the person set.
    const measureWidth = useCallback((): PaneEdgeReading => {
      const slot = slotRef.current;
      if (slot === null) {
        throw new Error("A pane edge was measured before its pane was drawn.");
      }
      const rootPx = rootFontSizePx(slot.ownerDocument);
      const minimumPx = rule.floorRem * rootPx;
      return {
        sizePx: widthPx ?? rule.widthRem * rootPx,
        minimumPx,
        maximumPx: Math.max(minimumPx, measureWidthCeilingPx()),
      };
    }, [rule, widthPx, measureWidthCeilingPx]);
    const previewWidth = useCallback((previewPx: number | undefined) => {
      if (previewPx === undefined) {
        slotRef.current?.style.removeProperty(LIVE_WIDTH_PROPERTY);
      } else {
        slotRef.current?.style.setProperty(LIVE_WIDTH_PROPERTY, `${String(previewPx)}px`);
      }
    }, []);
    const setWidth = useCallback(
      (nextPx: number | undefined) => {
        onSetWidth(pane.kind, nextPx);
      },
      [onSetWidth, pane.kind],
    );

    // A kind with no registered body is a composition defect, not something to draw around.
    if (descriptor === undefined) {
      throw new Error(`no body is registered for the ${pane.kind} pane kind`);
    }
    const title = TITLE_BY_PANE_KIND[pane.kind];
    const hasWidthEdge = rule.isResizable && props.placement !== "terminal-stacked";
    const style: PaneSlotStyle =
      props.placement === "terminal-stacked"
        ? {}
        : {
            "--meridian-pane-width":
              widthPx === undefined ? `${String(rule.widthRem)}rem` : `${String(widthPx)}px`,
            "--meridian-pane-floor": `${String(rule.floorRem)}rem`,
          };
    return (
      <div
        className="meridian-pane-layout__pane"
        data-pane-id={pane.paneId}
        data-placement={props.placement}
        data-full-width={isFullWidth ? "" : undefined}
        ref={registerSlot}
        style={style}
        onFocusCapture={onFocusCapture}
      >
        <PaneControlsContext.Provider value={controls}>
          <PaneBody
            descriptor={descriptor}
            context={props.paneContextFor(pane)}
            isSessionOpen={props.isSessionOpen}
            sessionId={props.sessionId}
          />
        </PaneControlsContext.Provider>
        {hasWidthEdge ? (
          <PaneEdge
            label={`Resize the ${title} pane`}
            growKey={props.side === "right" ? "ArrowLeft" : "ArrowRight"}
            measure={measureWidth}
            onPreview={previewWidth}
            onSet={setWidth}
            onResizingChange={props.onResizingChange}
          />
        ) : null}
        {props.placement === "terminal-stacked" ? (
          <PaneEdge
            label={`Resize the ${title} pane's height`}
            growKey={props.terminalPlace === "below" ? "ArrowUp" : "ArrowDown"}
            measure={props.measureTerminalHeight}
            onPreview={props.previewTerminalHeight}
            onSet={props.onSetTerminalHeight}
            onResizingChange={props.onResizingChange}
          />
        ) : null}
      </div>
    );
  },
);

/**
 * The selector of a pane's slot, any pane's or the one of `paneId`, for a reader that finds it in
 * the document: the attribute is written here alone.
 */
export function paneSlotSelector(paneId?: string): string {
  return paneId === undefined ? "[data-pane-id]" : `[data-pane-id="${paneId}"]`;
}

/** The property a dragged edge draws the width on, ahead of the width it keeps on release. */
const LIVE_WIDTH_PROPERTY = "--meridian-pane-width-live";

/** Carries the pane's width rule into its slot's sheet. */
interface PaneSlotStyle extends React.CSSProperties {
  readonly "--meridian-pane-width"?: string;
  readonly "--meridian-pane-floor"?: string;
}
