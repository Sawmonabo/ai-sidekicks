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

import { InlineRefusal, Nothing } from "../../primitives/index.js";
import { type ConsoleRefusal } from "../../core/index.js";
import {
  type ConsolePaneContext,
  type ConsolePaneRegistry,
  type PaneKind,
} from "../seats/index.js";
import { PERMILLE_PER_PERCENT, type DeckPane } from "./deck-model.js";
import { minimumPaneWidthPx, type DeckDensity } from "./density.js";
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
  readonly paneContextFor: (pane: DeckPane) => ConsolePaneContext;
  readonly dragCoordinator: DeckDragCoordinator;
  /** The edge a drop would land on, when a drag is currently over this pane. */
  readonly dropIndicator: PaneDropIndicator["edge"] | undefined;
  readonly onFocus: (paneId: string) => void;
  readonly onClose: (paneId: string) => void;
  readonly onOpenInWindow?: (pane: DeckPane) => void;
  /** True while this pane's body is showing in a window of its own (§4.5). */
  readonly isDetached: boolean;
  readonly onFocusDetachedWindow?: (paneId: string) => void;
  readonly onReturnToDeck?: (paneId: string) => void;
  /** Why the crashed-window signal is not being received, where it is not. */
  readonly detachedSignalRefusal?: ConsoleRefusal;
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
    const canOpenInWindow = descriptor?.openInWindow === true && onOpenInWindow !== undefined;

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
            descriptor.render(props.paneContextFor(pane))
          )}
        </PaneControlsContext.Provider>
      </Panel>
    );
  },
);

/**
 * The pane whose body is somewhere else.
 *
 * A named absence rather than an empty rectangle, and two controls rather than none:
 * §4.5 keeps the SLOT while the aux window shows the projection, so the widths and
 * the order survive the window's whole life and the pane goes back exactly where it
 * was. Closing the pane instead — which is what this replaced — deleted the position
 * the window's own close would have needed to restore.
 *
 * The signal refusal renders HERE, in the slot it is about. A build that cannot
 * subscribe to the crashed-window signal cannot notice a window that died, and a
 * placeholder that showed nothing would be claiming that none has.
 */
function DetachedPaneBody(props: {
  readonly paneId: string;
  readonly onFocusWindow?: (paneId: string) => void;
  readonly onReturnToDeck?: (paneId: string) => void;
  readonly signalRefusal?: ConsoleRefusal;
}): React.JSX.Element {
  const { onFocusWindow, onReturnToDeck, paneId } = props;
  return (
    <div className="meridian-deck__detached">
      <Nothing
        kind="empty"
        placement="surface"
        title="This pane is open in a window of its own."
        detail="Its contents are shown there, and never in two places at once."
        action={
          <>
            {onFocusWindow === undefined ? null : (
              <button
                type="button"
                className="meridian-deck__detached-control"
                onClick={() => {
                  onFocusWindow(paneId);
                }}
              >
                Bring its window forward
              </button>
            )}
            {onReturnToDeck === undefined ? null : (
              <button
                type="button"
                className="meridian-deck__detached-control"
                onClick={() => {
                  onReturnToDeck(paneId);
                }}
              >
                Return it to the deck
              </button>
            )}
          </>
        }
      />
      {props.signalRefusal === undefined ? null : (
        <InlineRefusal code={props.signalRefusal.code} detail={props.signalRefusal.detail} />
      )}
    </div>
  );
}

/**
 * A pane kind the deck holds and no family has a body for.
 *
 * Reserved, not stubbed: the kind set is closed by the spec and two of its members
 * are gated on their own amendments, so a deck restored from a snapshot can legally
 * name a kind this build has not mounted. Naming the kind beats an empty rectangle
 * that reads as a body which failed to render.
 */
function MissingPaneBody(props: { readonly kind: PaneKind }): React.JSX.Element {
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="This kind of pane has not been built yet."
      detail={`Nothing renders a ${props.kind} pane in this build. The pane is reserved for it.`}
    />
  );
}
