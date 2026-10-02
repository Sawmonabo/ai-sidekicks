// One pane's frame, and the body the pane layout resolves for it. `SessionPaneLayout.tsx`
// decides which panes exist, their order, widths and focus (questions about the set); this
// file answers what is drawn for a single pane, including when nothing is registered for its
// kind. Both symbols are reached only from `SessionPaneLayout.tsx`.

import { memo, useCallback, useMemo, useState } from "react";
import { Panel } from "react-resizable-panels";

import { type Refusal } from "@renderer/lib/refusal.js";
import {
  PaneControlsContext,
  type PaneControls,
} from "@renderer/components/PaneFrame/pane-controls.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { PaneBody } from "./PaneBody.js";
import { PERMILLE_PER_PERCENT, type SessionPane } from "../pane-layout.js";
import { type PaneLayoutDensity } from "../pane-layout-measures.js";
import { minimumPaneWidthPx } from "../pane-layout-density.js";
import { usePaneDragSource } from "../hooks/usePaneDragSource.js";
import { usePaneDropTarget } from "../hooks/usePaneDropTarget.js";
import { type PaneLayoutDragCoordinator, type PaneDropIndicator } from "../pane-drag.js";

/** What a pane slot is handed: the pane, its registry, its context resolver and its handlers. */
export interface SessionPaneSlotProps {
  readonly pane: SessionPane;
  readonly density: PaneLayoutDensity;
  readonly registry: PaneRegistry;
  /**
   * What this pane's body is handed, or why its address cannot be served. The kind and entity
   * come off a restored snapshot or a route, so the pair is not known to be an address until
   * it is parsed. The refusal arm is drawn instead of a body: a throw would take the whole
   * pane layout down for one pane, and a body handed an address it cannot serve would query a
   * partition that never held the row.
   */
  readonly paneContextFor: (pane: SessionPane) => PaneContext | Refusal;
  readonly dragCoordinator: PaneLayoutDragCoordinator;
  /** The edge a drop would land on, when a drag is currently over this pane. */
  readonly dropIndicator: PaneDropIndicator["edge"] | undefined;
  readonly onFocus: (paneId: string) => void;
  readonly onClose: (paneId: string) => void;
}

/**
 * One pane's frame, and the body the pane registry resolves for it. Memoized because the frame
 * budgets assume a four-lane streaming session, and an unmemoized map would re-render four
 * pane bodies for every event that touches one.
 */
export const SessionPaneSlot: React.NamedExoticComponent<SessionPaneSlotProps> = memo(
  function SessionPaneSlotBody(props: SessionPaneSlotProps): React.JSX.Element {
    const { dragCoordinator, pane, onClose, onFocus } = props;
    const descriptor = props.registry.descriptorFor(pane.kind);

    // The panel's own root element, which the library sizes and a drop is aimed at.
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

    // A kind with no registered body is a composition defect, not something to draw around.
    if (descriptor === undefined) {
      throw new Error(`no body is registered for the ${pane.kind} pane kind`);
    }

    const paneClassName = [
      "meridian-pane-layout__pane",
      props.dropIndicator === undefined
        ? undefined
        : `meridian-pane-layout__pane--drop-${props.dropIndicator}`,
    ]
      .filter((token): token is string => token !== undefined)
      .join(" ");

    return (
      <Panel
        id={pane.paneId}
        className={paneClassName}
        elementRef={setPanelElement}
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
