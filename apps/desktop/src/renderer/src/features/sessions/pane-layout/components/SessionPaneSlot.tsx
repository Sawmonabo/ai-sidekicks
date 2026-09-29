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

import { type ConsoleRefusal } from "@renderer/lib/refusal.js";
import {
  PaneControlsContext,
  type PaneContext,
  type PaneRegistry,
  type PaneControls,
} from "@renderer/console/seats/index.js";
import { PaneBody } from "./PaneBody.js";
import { PERMILLE_PER_PERCENT, type SessionPane } from "../pane-layout.js";
import { type PaneLayoutDensity } from "../pane-layout-measures.js";
import { minimumPaneWidthPx } from "../pane-layout-density.js";
import { usePaneDragSource } from "../hooks/usePaneDragSource.js";
import { usePaneDropTarget } from "../hooks/usePaneDropTarget.js";
import { type PaneLayoutDragCoordinator, type PaneDropIndicator } from "../pane-drag.js";

export interface SessionPaneSlotProps {
  readonly pane: SessionPane;
  readonly isFocused: boolean;
  readonly density: PaneLayoutDensity;
  readonly registry: PaneRegistry;
  /**
   * What this pane's body is handed, or why its address cannot be served.
   *
   * A pane's kind and its entity reference come off a restored snapshot or a route,
   * so the pair is not known to be an address any body admits until it is parsed. The
   * refusal arm is what a slot draws instead of a body — never a throw, which would
   * take the whole deck down for one pane, and never a body handed an address it
   * cannot serve, which would query a partition that has never held the row.
   */
  readonly paneContextFor: (pane: SessionPane) => PaneContext | ConsoleRefusal;
  readonly dragCoordinator: PaneLayoutDragCoordinator;
  /** The edge a drop would land on, when a drag is currently over this pane. */
  readonly dropIndicator: PaneDropIndicator["edge"] | undefined;
  readonly onFocus: (paneId: string) => void;
  readonly onClose: (paneId: string) => void;
  readonly trackElement: (paneId: string, element: Element) => void;
  readonly untrackElement: (paneId: string) => void;
}

/**
 * One pane's frame, and the body resolved through the deck's single mount door.
 *
 * Memoised on purpose: the console's frame budgets are written against a four-lane
 * streaming session, and an unmemoised map re-renders four pane bodies for every
 * event that touches one of them.
 */
export const SessionPaneSlot: React.NamedExoticComponent<SessionPaneSlotProps> = memo(
  function DeckPaneSlot(props: SessionPaneSlotProps): React.JSX.Element {
    const { dragCoordinator, pane, onClose, onFocus, trackElement, untrackElement } = props;
    const descriptor = props.registry.descriptorFor(pane.kind);

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
      }),
      [onClose, pane.paneId, registerDragHandle],
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

    // A kind with no registered body is a composition defect, not something to draw around.
    if (descriptor === undefined) {
      throw new Error(`no body is registered for the ${pane.kind} pane kind`);
    }

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
          <PaneBody descriptor={descriptor} context={props.paneContextFor(pane)} />
        </PaneControlsContext.Provider>
      </Panel>
    );
  },
);
