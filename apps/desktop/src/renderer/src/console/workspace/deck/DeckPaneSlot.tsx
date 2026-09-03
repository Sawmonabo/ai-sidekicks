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
  isDetachablePaneKind,
  type ConsolePaneContext,
  type ConsolePaneDescriptor,
  type ConsolePaneRegistry,
  type PaneKind,
} from "../../seats/index.js";
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

/** Whether what the deck resolved for a pane is an address or a refusal. */
function isPaneContext(
  resolved: ConsolePaneContext | ConsoleRefusal,
): resolved is ConsolePaneContext {
  return !("code" in resolved);
}

/**
 * The registered body, or the refusal that says why this pane has no address.
 *
 * Split out of the slot's own JSX so the narrowing is a named predicate rather than a
 * condition inside a ternary chain that already has three arms.
 */
function PaneBody(props: {
  readonly descriptor: ConsolePaneDescriptor;
  readonly context: ConsolePaneContext | ConsoleRefusal;
}): React.ReactNode {
  return isPaneContext(props.context) ? (
    props.descriptor.render(props.context)
  ) : (
    <InlineRefusal code={props.context.code} detail={props.context.detail} />
  );
}

/**
 * The pane's error slot: what happened to the window this pane was in.
 *
 * INLINE rather than a banner, on the refusal grammar's own question — what did this
 * change, and for whom? One pane's window died and one pane's body came back; the
 * rest of the room is untouched, so the note belongs beside the pane and not across
 * the workspace.
 *
 * Dismissable, and the dismissal is the caller's act rather than local state: the
 * record lives on the hand-off, so a note cleared in a component that then
 * re-rendered from the hand-off's own publish would come straight back.
 */
function LostWindowNotice(props: {
  readonly paneId: string;
  readonly notice: ConsoleRefusal;
  readonly onDismiss?: (paneId: string) => void;
}): React.JSX.Element {
  const { onDismiss, paneId } = props;
  return (
    <div className="meridian-deck__pane-error">
      <InlineRefusal
        code={props.notice.code}
        detail={props.notice.detail}
        {...(onDismiss === undefined
          ? {}
          : {
              action: (
                <button
                  type="button"
                  className="meridian-deck__detached-control"
                  onClick={() => {
                    onDismiss(paneId);
                  }}
                >
                  Dismiss
                </button>
              ),
            })}
      />
    </div>
  );
}

/**
 * The pane whose body is somewhere else.
 *
 * A named absence rather than an empty rectangle, and two controls rather than none:
 * `Spec-023 §The surface set` keeps the SLOT while the auxiliary window shows the
 * projection — "the main window shows the moved pane's slot as a placeholder with a
 * focus control" — so the widths and the order survive the window's whole life and the
 * pane goes back exactly where it was. Closing the pane instead — which is what this
 * replaced — deleted the position the window's own close would have needed to restore.
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
