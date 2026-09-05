// One pane's frame, and the body the deck resolves for it.
//
// ITS OWN MODULE BECAUSE IT IS A DIFFERENT SUBJECT. `Deck.tsx` decides which panes
// exist, in what order, at what widths, and which one has focus — questions about
// the SET. This file answers one question about a SINGLE member: given a pane and
// the registry, what is drawn, and what is drawn when nothing is registered for its
// kind. Neither half reads the other's state, which is why the cut is here and not
// at a line count.
//
// Nothing here leaves the family: both symbols are reached only from `Deck.tsx`,
// so the workspace door carries neither.

import { memo, useCallback, useMemo, useState } from "react";
import { Panel } from "react-resizable-panels";

import { type ConsoleRefusal } from "../../core/index.js";
import {
  isDetachablePaneKind,
  type ConsolePaneContext,
  type ConsolePaneRegistry,
} from "../../seats/index.js";
import { DetachedPaneBody } from "./DetachedPaneBody.js";
import { LostWindowNotice } from "./LostWindowNotice.js";
import { MissingPaneBody } from "./MissingPaneBody.js";
import { PaneBody } from "./PaneBody.js";
import { PERMILLE_PER_PERCENT, type DeckPane } from "./deck-model.js";
import { type DeckDensity } from "../workspace-bounds.js";
import { minimumPaneWidthPx } from "./density.js";
import {
  usePaneDragSource,
  usePaneDropTarget,
  type DeckDragCoordinator,
  type PaneDropIndicator,
} from "./pane-drag.js";
import { PaneControlsContext, type PaneControls } from "./pane-controls.js";

export interface DeckPaneSlotProps {
  readonly pane: DeckPane;
  readonly isFocused: boolean;
  readonly density: DeckDensity;
  readonly registry: ConsolePaneRegistry;
  /**
   * What this pane's body is handed, or why its address cannot be served.
   *
   * A pane's kind and its entity reference come off a restored snapshot or a route,
   * so the pair is not known to be an address any body admits until it is parsed. The
   * refusal arm is what a slot draws instead of a body — never a throw, which would
   * take the whole deck down for one pane, and never a body handed an address it
   * cannot serve, which would query a partition that has never held the row.
   */
  readonly paneContextFor: (pane: DeckPane) => ConsolePaneContext | ConsoleRefusal;
  readonly dragCoordinator: DeckDragCoordinator;
  /** The edge a drop would land on, when a drag is currently over this pane. */
  readonly dropIndicator: PaneDropIndicator["edge"] | undefined;
  readonly onFocus: (paneId: string) => void;
  readonly onClose: (paneId: string) => void;
  readonly onOpenInWindow?: (pane: DeckPane) => void;
  /** True while this pane's body is showing in a window of its own
   * (`Spec-023 §The surface set`). */
  readonly isDetached: boolean;
  readonly onFocusDetachedWindow?: (paneId: string) => void;
  readonly onReturnToDeck?: (paneId: string) => void;
  /** Why the crashed-window signal is not being received, where it is not. */
  readonly detachedSignalRefusal?: ConsoleRefusal;
  /**
   * The crash this pane came back from, where it came back from one.
   *
   * `Spec-023 §The surface set`: "a crashed auxiliary window returns the pane to the
   * deck with the crash noted in the pane's error slot". The body is drawn as usual
   * — the pane works again — and the note sits above it until it is dismissed.
   */
  readonly lostWindowNotice?: ConsoleRefusal;
  readonly onDismissLostWindow?: (paneId: string) => void;
  readonly trackElement: (paneId: string, element: Element) => void;
  readonly untrackElement: (paneId: string) => void;
}

/**
 * One pane's frame, and the body resolved through the deck's single mount door.
 *
 * Memoised on purpose: `Spec-023 §Console Design (Meridian)`'s budgets are written
 * against a four-lane streaming session, and an unmemoised map re-renders four pane
 * bodies for every event that touches one of them.
 */
export const DeckPaneSlot: React.NamedExoticComponent<DeckPaneSlotProps> = memo(
  function DeckPaneSlot(props: DeckPaneSlotProps): React.JSX.Element {
    const {
      dragCoordinator,
      pane,
      onClose,
      onFocus,
      onOpenInWindow,
      trackElement,
      untrackElement,
    } = props;
    const descriptor = props.registry.descriptorFor(pane.kind);
    // Whether this pane may be torn off is a property of its KIND, answered once by the
    // window model's own closed set — never a member the descriptor carries, which
    // would let a family advertise a detach path no auxiliary route can serve.
    const canOpenInWindow = isDetachablePaneKind(pane.kind) && onOpenInWindow !== undefined;

    // The panel's own root element, which is the one the library sizes. It is the
    // element the rect discipline measures and the element a drop is aimed at, so
    // both hold the same node rather than one holding a wrapper of the other.
    const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
    const registerDragHandle = usePaneDragSource(dragCoordinator, pane.paneId);
    usePaneDropTarget(dragCoordinator, pane.paneId, panelElement);

    const controls = useMemo<PaneControls>(
      () => ({
        onClose: () => {
          onClose(pane.paneId);
        },
        registerDragHandle,
        ...(canOpenInWindow
          ? {
              onOpenInWindow: (): void => {
                onOpenInWindow?.(pane);
              },
            }
          : {}),
      }),
      [canOpenInWindow, onClose, onOpenInWindow, pane, registerDragHandle],
    );

    const onFocusCapture = useCallback(() => {
      onFocus(pane.paneId);
    }, [onFocus, pane.paneId]);

    const attachElement = useCallback(
      (element: HTMLDivElement | null) => {
        setPanelElement(element);
        if (element === null) {
          untrackElement(pane.paneId);
          return;
        }
        trackElement(pane.paneId, element);
      },
      [pane.paneId, trackElement, untrackElement],
    );

    const paneClassName = [
      "meridian-deck__pane",
      props.isFocused ? "meridian-deck__pane--focused" : undefined,
      props.dropIndicator === undefined
        ? undefined
        : `meridian-deck__pane--drop-${props.dropIndicator}`,
    ]
      .filter((token): token is string => token !== undefined)
      .join(" ");

    return (
      <Panel
        id={pane.paneId}
        className={paneClassName}
        elementRef={attachElement}
        minSize={minimumPaneWidthPx(props.density)}
        defaultSize={`${String(pane.sizePermille / PERMILLE_PER_PERCENT)}%`}
        onFocusCapture={onFocusCapture}
      >
        <PaneControlsContext.Provider value={controls}>
          {props.lostWindowNotice === undefined ? null : (
            <LostWindowNotice
              paneId={pane.paneId}
              notice={props.lostWindowNotice}
              {...(props.onDismissLostWindow === undefined
                ? {}
                : { onDismiss: props.onDismissLostWindow })}
            />
          )}
          {props.isDetached ? (
            <DetachedPaneBody
              paneId={pane.paneId}
              {...(props.onFocusDetachedWindow === undefined
                ? {}
                : { onFocusWindow: props.onFocusDetachedWindow })}
              {...(props.onReturnToDeck === undefined
                ? {}
                : { onReturnToDeck: props.onReturnToDeck })}
              {...(props.detachedSignalRefusal === undefined
                ? {}
                : { signalRefusal: props.detachedSignalRefusal })}
            />
          ) : descriptor === undefined ? (
            <MissingPaneBody kind={pane.kind} />
          ) : (
            <PaneBody descriptor={descriptor} context={props.paneContextFor(pane)} />
          )}
        </PaneControlsContext.Provider>
      </Panel>
    );
  },
);
