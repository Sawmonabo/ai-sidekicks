// The deck: the panes a person is looking at, side by side.
//
// `Spec-023 §Console Design (Meridian)` §4.2 — "Hold the work a person is looking at
// as independent panes, each headed by an entity breadcrumb and a kind glyph, each
// with a focus ring in the hue of the actor whose work it shows."
//
// WHAT THIS COMPONENT IS AND IS NOT. It is the frame: order, widths, focus, the
// separators, the keyboard paths, and the one door each pane body is mounted
// through. It is NOT any pane's content — every body comes from
// `workspace/seats/pane-registry.ts`, resolved by kind, so a second open of the same
// entity focuses the pane that already exists.
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
//
// WHAT THE TWO ADOPTED LIBRARIES OWN, AND WHAT STAYS OURS. `Spec-023 §Console
// Libraries`, row "Layout, panes, drag":
//
//   • `react-resizable-panels` owns the resize gesture, the flex arithmetic that
//     turns a drag into widths, and the window-splitter ARIA with its arrow-key,
//     Home/End and Enter bindings. It does NOT own the layout: `DeckLayout` does,
//     and the group reports back to it. Its one open defect — the crossed
//     `aria-valuemin` / `aria-valuemax` on every separator after the first — is
//     wrapped in `separator-aria.ts`. A pane's floor rides the panel's own
//     `minSize` in PIXELS, which is what the density preset means; upstream issue
//     #720 reports a pixel floor being rescaled as a percentage across a window
//     resize, which is why `DeckLayout.applyLayout` clamps again over a freshly
//     measured deck — and only the store's clamp is written to disk.
//   • `@atlaskit/pragmatic-drag-and-drop` owns the pointer reorder gesture, as the
//     browser's own HTML5 drag, so no React render happens per frame. It provides
//     no keyboard drag by design, which is why the Alt+Shift chord below is not an
//     alternative to the gesture but the accessible path the row's constraint
//     requires the deck to keep.
//
// Own-built and staying own-built: the deck store, the separator's chrome, the drop
// indicator, the keyboard reorder path, and the density floor. Neither library ships
// a stylesheet and neither is imported for one.

import { Fragment, memo, useCallback, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { RealClock, type ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing } from "../../primitives/index.js";
import {
  type ConsolePaneContext,
  type ConsolePaneRegistry,
  type PaneKind,
} from "../seats/index.js";
import { useDeckLayoutState, type DeckLayout } from "./deck-layout.js";
import {
  DECK_TOTAL_PERMILLE,
  PERMILLE_PER_PERCENT,
  toPaneSizePercentages,
  type DeckPane,
} from "./deck-model.js";
import { minimumPaneWidthPx, type DeckDensity } from "./density.js";
import {
  useDeckDragCoordinator,
  useDeckDragMonitor,
  useDeckDropIndicator,
  usePaneDragSource,
  usePaneDropTarget,
  type DeckDragCoordinator,
  type PaneDropIndicator,
} from "./pane-drag.js";
import { PaneControlsContext, type PaneControls } from "./pane-controls.js";
import { usePaneRectSources, usePaneRectTracker, type TrackedRect } from "./rect-discipline.js";
import { useSeparatorValueBoundsCorrection } from "./separator-aria.js";

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
  useSeparatorValueBoundsCorrection(containerReference, state.revision);

  const dragCoordinator = useDeckDragCoordinator();
  useDeckDragMonitor(dragCoordinator, layout);
  const dropIndicator = useDeckDropIndicator(dragCoordinator);

  /**
   * The density floor as a share of the deck, in permille, right now.
   *
   * Measured at the moment of the act rather than held in state: the floor is a
   * width in pixels divided by the deck's own width, and a deck width kept in state
   * would be a second copy of a number the DOM already has — one that goes stale
   * exactly when the window is being resized. It is read inside a callback and
   * never during a render, so nothing here makes rendering depend on layout.
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

  /**
   * Adopt what the group settled on, and re-measure while it is still settling.
   *
   * Two callbacks because they answer two different questions. `onLayoutChanged`
   * fires once, when the pointer is released or a key is pressed, and is what the
   * store keeps — writing every intermediate frame would put sixty arrangements a
   * second through the persistence writer. `onLayoutChange` fires on every frame of
   * the drag and does exactly one thing: invalidates the pane rects, so a native
   * view hosted in a pane tracks its bounds THROUGH the resize rather than jumping
   * to them at the end of it (§4.3). It is a read, queued to the next frame by the
   * tracker; it writes no layout, which is the rule that callback exists under.
   */
  const onLayoutSettled = useCallback(
    (percentages: Readonly<Record<string, number>>) => {
      layout.applyLayout(percentages, minimumPermille(state.density));
    },
    [layout, minimumPermille, state.density],
  );
  const onLayoutMoving = useCallback(() => {
    tracker.invalidate("layout-mover");
  }, [tracker]);

  const refusals = props.restoreRefusals ?? [];
  const defaultLayout = useMemo(() => toPaneSizePercentages(state.panes), [state.panes]);

  return (
    <div
      className="meridian-deck"
      data-density={state.density}
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
        <Group
          className="meridian-deck__group"
          elementRef={containerReference}
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChange={onLayoutMoving}
          onLayoutChanged={onLayoutSettled}
        >
          {state.panes.map((pane, position) => (
            <Fragment key={pane.paneId}>
              {position === 0 ? null : (
                <Separator
                  className="meridian-deck__separator"
                  aria-label="Resize the pane to the left"
                />
              )}
              <DeckPaneSlot
                pane={pane}
                isFocused={pane.paneId === state.focusedPaneId}
                density={state.density}
                registry={props.registry}
                paneContextFor={props.paneContextFor}
                dragCoordinator={dragCoordinator}
                dropIndicator={
                  dropIndicator?.overPaneId === pane.paneId ? dropIndicator.edge : undefined
                }
                onFocus={focusPane}
                onClose={closePane}
                {...(props.onOpenInWindow === undefined
                  ? {}
                  : { onOpenInWindow: props.onOpenInWindow })}
                trackElement={trackElement}
                untrackElement={untrackElement}
              />
            </Fragment>
          ))}
        </Group>
      )}
    </div>
  );
}

interface DeckPaneSlotProps {
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
  const { dragCoordinator, pane, onClose, onFocus, onOpenInWindow, trackElement, untrackElement } =
    props;
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
        {descriptor === undefined ? (
          <MissingPaneBody kind={pane.kind} />
        ) : (
          descriptor.render(props.paneContextFor(pane))
        )}
      </PaneControlsContext.Provider>
    </Panel>
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
