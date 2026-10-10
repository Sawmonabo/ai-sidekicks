// One pane's frame, and the body the pane layout resolves for it. `SessionPaneLayout.tsx`
// decides which panes exist, their order, widths and focus (questions about the set); this
// file answers what is drawn for a single pane, including when nothing is registered for its
// kind, and the frame alone while the session's store has not opened. Both symbols are reached
// only from `SessionPaneLayout.tsx`.

import { memo, useCallback, useMemo } from "react";
import { Panel } from "react-resizable-panels";

import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { type ReorderDrag } from "#renderer/lib/reorder-drag.js";
import { PaneControlsContext, type PaneControls } from "#renderer/components/PaneFrame/controls.js";
import { PaneFrame } from "#renderer/components/PaneFrame/PaneFrame.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { type PaneRegistry } from "#renderer/registries/panes/registry.js";
import { PaneBody } from "./PaneBody.js";
import { PERMILLE_PER_PERCENT, type SessionPane } from "../state.js";
import { type PaneLayoutDensity } from "../measures.js";
import { minimumPaneWidthPx } from "../density.js";

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
  /**
   * Whether the session's store has opened. Until it has, the pane draws its frame alone, at its
   * place and width with its address's trail, since its body reads the session.
   */
  readonly isSessionOpen: boolean;
  /** The session the pane is about, which its frame names while it draws no body. */
  readonly sessionId: string | undefined;
  /** The pane row's reorder: the panel is the item that moves, the pane's header its grip. */
  readonly paneDrag: ReorderDrag<string>;
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
    const { paneDrag, pane, onClose, onFocus } = props;
    const descriptor = props.registry.descriptorFor(pane.kind);
    const registerDragHandle = paneDrag.handleRef(pane.paneId);

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
    // The address comes from the saved arrangement, so the frame's trail is drawn before the
    // session opens just as the open pane draws it.
    const context = props.paneContextFor(pane);

    return (
      <Panel
        id={pane.paneId}
        className="meridian-pane-layout__pane"
        elementRef={paneDrag.itemRef(pane.paneId)}
        minSize={minimumPaneWidthPx(props.density)}
        defaultSize={`${String(pane.sizePermille / PERMILLE_PER_PERCENT)}%`}
        onFocusCapture={onFocusCapture}
      >
        <PaneControlsContext.Provider value={controls}>
          {props.isSessionOpen ? (
            <PaneBody descriptor={descriptor} context={context} />
          ) : "code" in context ? (
            // An address that could not be read names no session, as its refusal does once open.
            <PaneFrame kind={pane.kind} sessionId={undefined} />
          ) : (
            <PaneFrame
              kind={pane.kind}
              sessionId={props.sessionId}
              entity={"entity" in context ? context.entity : undefined}
            />
          )}
        </PaneControlsContext.Provider>
      </Panel>
    );
  },
);
