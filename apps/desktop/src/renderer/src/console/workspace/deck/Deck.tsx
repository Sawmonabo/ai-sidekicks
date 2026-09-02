// The deck: the panes a person is looking at, side by side.
//
// `Spec-023 §Console Design (Meridian)` §4.2 — "Hold the work a person is looking at
// as independent panes, each headed by an entity breadcrumb and a kind glyph, each
// with a focus ring in the hue of the actor whose work it shows."
//
// WHAT THIS COMPONENT IS AND IS NOT. It is the frame: order, widths, focus, the
// separators between panes, the keyboard paths, and the one door each pane body is
// mounted through. It is NOT any pane's content — every body comes from
// `workspace/seats/pane-registry.ts`, resolved by kind, so a second open of the same
// entity focuses the pane that already exists and no family can mount a second body
// for a kind it does not own.
//
// FOUR DECISIONS WORTH STATING:
//
//   • **Layout lives in `DeckLayout`, never in `useState`.** A component holding
//     pane order would be a second source of truth for it, and the restore path
//     would then have two places to write. This component subscribes and dispatches.
//   • **Every programmatic scroll and every rect read goes through a chokepoint.**
//     Rects are `rect-discipline.ts`'s; nothing here calls `scrollIntoView`.
//   • **Rows are memoised.** A four-pane deck under a streaming session re-renders
//     the pane whose store changed and not its neighbours, which is what the
//     partitioned store buys and what an unmemoised map would give straight back.
//   • **Keyboard before pointer.** Focus, move, and close are chords; resize is on
//     the separator, which is focusable and operable with the arrow keys. A deck
//     reachable only by dragging is a deck half the people using it cannot arrange.

import { Fragment, memo, useCallback, useMemo, useRef, useState } from "react";

import { RealClock, type ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing } from "../../primitives/index.js";
import {
  type ConsolePaneContext,
  type ConsolePaneRegistry,
  type PaneKind,
} from "../seats/index.js";
import { useDeckLayoutState, type DeckLayout } from "./deck-layout.js";
import { DECK_TOTAL_PERMILLE, type DeckPane } from "./deck-model.js";
import { minimumPaneWidthPx, type DeckDensity } from "./density.js";
import { PaneControlsContext, type PaneControls } from "./pane-controls.js";
import { usePaneRectSources, usePaneRectTracker, type TrackedRect } from "./rect-discipline.js";

/**
 * How much one arrow press moves a separator, in permille of the deck.
 *
 * Two percent: coarse enough that a pane crosses a useful distance in a few
 * presses, fine enough that a person can land on a width they meant. The pointer
 * path is continuous and does not use it.
 */
const SEPARATOR_KEYBOARD_STEP_PERMILLE = 20;

export interface DeckProps {
  readonly layout: DeckLayout;
  /** Where pane bodies come from. Passed rather than reached for: an auxiliary
   * window composes a different subset without a second code path. */
  readonly registry: ConsolePaneRegistry;
  /** What each pane body is handed. The surface that owns the stores builds it. */
  readonly paneContextFor: (pane: DeckPane) => ConsolePaneContext;
  /** Supplied where a host can move a pane into a window of its own (§4.5). */
  readonly onOpenInWindow?: (pane: DeckPane) => void;
  /** What the layout restore refused, rendered rather than swallowed. */
  readonly restoreRefusals?: readonly ConsoleRefusal[];
  /** Where measured pane rects go, for a body that hosts a native view (§4.3). */
  readonly onPaneRects?: (rects: readonly TrackedRect[]) => void;
}

export function Deck(props: DeckProps): React.JSX.Element {
  const { layout } = props;
  const state = useDeckLayoutState(layout);
  const containerReference = useRef<HTMLDivElement>(null);
  const [clock] = useState(() => new RealClock());
  const tracker = usePaneRectTracker({
    clock,
    ...(props.onPaneRects === undefined ? {} : { onRects: props.onPaneRects }),
  });
  usePaneRectSources(tracker, containerReference, state.revision);

  /**
   * The floor a separator holds both its panes above, in permille.
   *
   * Read from the live element at the moment of the act rather than held in state:
   * the floor is a width in pixels divided by the deck's own width, and a deck
   * width kept in state would be a second copy of a number the DOM already has —
   * one that goes stale exactly when the window is being resized.
   */
  const minimumPermille = useCallback(
    (density: DeckDensity): number => {
      const deckWidth = containerReference.current?.getBoundingClientRect().width ?? 0;
      if (deckWidth <= 0) {
        return 0;
      }
      return Math.round((minimumPaneWidthPx(density) / deckWidth) * DECK_TOTAL_PERMILLE);
    },
    [containerReference],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // `Alt` alone, so nothing here collides with the palette's `$mod` chords or
      // with a text field's own word-wise navigation.
      if (!event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      const focused = state.focusedPaneId;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowLeft": {
          const step = event.key === "ArrowRight" ? 1 : -1;
          if (event.shiftKey) {
            if (focused !== undefined) {
              layout.movePane(focused, step);
            }
          } else {
            layout.focusAdjacent(step);
          }
          event.preventDefault();
          return;
        }
        case "Backspace":
        case "Delete": {
          if (focused !== undefined) {
            layout.close(focused);
            event.preventDefault();
          }
          return;
        }
        default:
          return;
      }
    },
    [layout, state.focusedPaneId],
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
  const trackElement = useCallback(
    (paneId: string, element: Element) => {
      tracker.track(paneId, element);
    },
    [tracker],
  );
  const untrackElement = useCallback(
    (paneId: string) => {
      tracker.untrack(paneId);
    },
    [tracker],
  );

  const refusals = props.restoreRefusals ?? [];

  return (
    <div
      className="meridian-deck"
      data-density={state.density}
      ref={containerReference}
      role="group"
      aria-label="Open panes"
      onKeyDown={onKeyDown}
    >
      {refusals.length === 0 ? null : (
        <div className="meridian-deck__refusals" role="status">
          {refusals.map((refusal, position) => (
            <InlineRefusal
              key={`${refusal.code}-${String(position)}`}
              code={refusal.code}
              detail={refusal.detail}
            />
          ))}
        </div>
      )}
      {state.panes.length === 0 ? (
        <Nothing
          kind="empty"
          placement="surface"
          title="No panes are open."
          detail="Open one from the sidebar, or follow somebody from the cast bar."
        />
      ) : (
        state.panes.map((pane, position) => (
          <Fragment key={pane.paneId}>
            {position === 0 ? null : (
              <PaneSeparator
                leftPaneId={state.panes[position - 1]?.paneId ?? pane.paneId}
                leftSizePermille={state.panes[position - 1]?.sizePermille ?? 0}
                onResize={(deltaPermille) => {
                  const left = state.panes[position - 1];
                  if (left !== undefined) {
                    layout.resize(left.paneId, deltaPermille, minimumPermille(state.density));
                  }
                }}
              />
            )}
            <DeckPaneSlot
              pane={pane}
              isFocused={pane.paneId === state.focusedPaneId}
              density={state.density}
              registry={props.registry}
              paneContextFor={props.paneContextFor}
              onFocus={focusPane}
              onClose={closePane}
              {...(props.onOpenInWindow === undefined
                ? {}
                : { onOpenInWindow: props.onOpenInWindow })}
              trackElement={trackElement}
              untrackElement={untrackElement}
            />
          </Fragment>
        ))
      )}
    </div>
  );
}

interface PaneSeparatorProps {
  readonly leftPaneId: string;
  readonly leftSizePermille: number;
  readonly onResize: (deltaPermille: number) => void;
}

/**
 * The grab bar between two panes.
 *
 * `role="separator"` with a `tabIndex`, which is what makes a separator an
 * OPERABLE widget rather than a decorative rule — the arrow keys move it, and
 * `aria-valuenow` is what a screen reader announces as it moves. The pointer path
 * is a pointer capture on the same element, so the two agree on one act.
 */
function PaneSeparator(props: PaneSeparatorProps): React.JSX.Element {
  const dragOriginX = useRef<number | undefined>(undefined);

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragOriginX.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className="meridian-deck__separator"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize the pane to the left"
      aria-valuenow={props.leftSizePermille}
      aria-valuemin={0}
      aria-valuemax={DECK_TOTAL_PERMILLE}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        props.onResize(
          event.key === "ArrowRight"
            ? SEPARATOR_KEYBOARD_STEP_PERMILLE
            : -SEPARATOR_KEYBOARD_STEP_PERMILLE,
        );
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        dragOriginX.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const origin = dragOriginX.current;
        const deckWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
        // `buttons` as well as the origin, because a pointer move also fires on a
        // bare hover: without it a drag the system ended without telling us would
        // leave the separator following the cursor around the deck.
        if (origin === undefined || event.buttons === 0 || deckWidth <= 0) {
          return;
        }
        dragOriginX.current = event.clientX;
        props.onResize(Math.round(((event.clientX - origin) / deckWidth) * DECK_TOTAL_PERMILLE));
      }}
      onPointerUp={(event) => {
        endDrag(event);
      }}
      // A cancel is the case a released capture does not cover: the browser or the
      // OS takes the pointer away mid-drag and no `pointerup` ever arrives.
      onPointerCancel={(event) => {
        endDrag(event);
      }}
    />
  );
}

interface DeckPaneSlotProps {
  readonly pane: DeckPane;
  readonly isFocused: boolean;
  readonly density: DeckDensity;
  readonly registry: ConsolePaneRegistry;
  readonly paneContextFor: (pane: DeckPane) => ConsolePaneContext;
  readonly onFocus: (paneId: string) => void;
  readonly onClose: (paneId: string) => void;
  readonly onOpenInWindow?: (pane: DeckPane) => void;
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
const DeckPaneSlot = memo(function DeckPaneSlot(props: DeckPaneSlotProps): React.JSX.Element {
  const { pane, onClose, onFocus, onOpenInWindow, trackElement, untrackElement } = props;
  const descriptor = props.registry.descriptorFor(pane.kind);
  const canOpenInWindow = descriptor?.openInWindow === true && onOpenInWindow !== undefined;

  const controls = useMemo<PaneControls>(
    () => ({
      onClose: () => {
        onClose(pane.paneId);
      },
      ...(canOpenInWindow
        ? {
            onOpenInWindow: (): void => {
              onOpenInWindow?.(pane);
            },
          }
        : {}),
    }),
    [canOpenInWindow, onClose, onOpenInWindow, pane],
  );

  const onFocusCapture = useCallback(() => {
    onFocus(pane.paneId);
  }, [onFocus, pane.paneId]);

  const attachElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null) {
        untrackElement(pane.paneId);
        return;
      }
      trackElement(pane.paneId, element);
    },
    [pane.paneId, trackElement, untrackElement],
  );

  return (
    <div
      className="meridian-deck__pane"
      data-focused={props.isFocused}
      style={{ flexGrow: pane.sizePermille, minWidth: minimumPaneWidthPx(props.density) }}
      onFocusCapture={onFocusCapture}
      ref={attachElement}
    >
      <PaneControlsContext.Provider value={controls}>
        {descriptor === undefined ? (
          <MissingPaneBody kind={pane.kind} />
        ) : (
          descriptor.render(props.paneContextFor(pane))
        )}
      </PaneControlsContext.Provider>
    </div>
  );
});

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
