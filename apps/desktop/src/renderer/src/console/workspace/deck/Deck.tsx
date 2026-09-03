// The deck: the panes a person is looking at, side by side.
//
// `Spec-023 §The surface set`: the deck "holds independent panes, each headed by an
// entity breadcrumb and a kind glyph, with the actor's hue as the focus ring; one entity
// opens one pane, structurally (a single mount door and a tripwire that fails on a
// second)".
//
// WHAT THIS COMPONENT IS AND IS NOT. It is the frame: order, widths, focus, the
// separators, the keyboard paths, and the one door each pane body is mounted
// through. It is NOT any pane's content — every body comes from
// `seats/pane-registry.ts`, resolved by kind, so a second open of the same
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

import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { Group, Separator } from "react-resizable-panels";

import { RealClock, type ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing, isEditableTarget, useAnnounce } from "../../primitives/index.js";
import { type ConsolePaneContext, type ConsolePaneRegistry } from "../../seats/index.js";
import { useDeckLayoutState, type DeckLayout } from "./deck-layout.js";
import { DECK_TOTAL_PERMILLE, toPaneSizePercentages, type DeckPane } from "./deck-model.js";
import { minimumPaneWidthPx, type DeckDensity } from "./density.js";
import { useDeckDragCoordinator, useDeckDragMonitor, useDeckDropIndicator } from "./pane-drag.js";
import { DeckPaneSlot } from "./DeckPaneSlot.js";
import {
  usePaneRectSources,
  usePaneRectTracker,
  type AirspaceRegistry,
  type TrackedRect,
} from "./rect-discipline.js";
import { useSeparatorValueBoundsCorrection } from "./separator-aria.js";

export interface DeckProps {
  readonly layout: DeckLayout;
  /** Where pane bodies come from. Passed rather than reached for: an auxiliary
   * window composes a different subset without a second code path. */
  readonly registry: ConsolePaneRegistry;
  /** What each pane body is handed. The surface that owns the stores builds it. */
  /** What each pane's body is handed, or why its address cannot be served. */
  readonly paneContextFor: (pane: DeckPane) => ConsolePaneContext | ConsoleRefusal;
  /** Supplied where a host can move a pane into a window of its own
   * (`Spec-023 §The surface set`, auxiliary windows). */
  readonly onOpenInWindow?: (pane: DeckPane) => void;
  /** What the layout restore refused, rendered rather than swallowed. */
  readonly restoreRefusals?: readonly ConsoleRefusal[];
  /**
   * Panes whose body is showing in a window of its own (`Spec-023 §The surface set`).
   *
   * The slot stays and the projection is suppressed, so widths and order survive the
   * window's whole life and the pane goes back where it was.
   */
  readonly detachedPaneIds?: readonly string[];
  readonly onFocusDetachedWindow?: (paneId: string) => void;
  readonly onReturnToDeck?: (paneId: string) => void;
  /** Why the crashed-window signal is not being received, where it is not. */
  readonly detachedSignalRefusal?: ConsoleRefusal;
  /**
   * The crash note a pane came back with, by pane id
   * (`Spec-023 §The surface set`: "a crashed auxiliary window returns the pane to the
   * deck with the crash noted in the pane's error slot").
   *
   * A pane named here is NOT detached — its body is in the deck again — so the two
   * sets never overlap and one slot is never asked to draw both.
   */
  readonly lostWindowNoticesByPaneId?: ReadonlyMap<string, ConsoleRefusal>;
  readonly onDismissLostWindow?: (paneId: string) => void;
  /** Where measured pane rects go, for a body that hosts a native view.
   * `deck/rect-discipline.ts` holds the rules. */
  readonly onPaneRects?: (rects: readonly TrackedRect[]) => void;
  /**
   * Which overlays are up, so a pane's rect yields while one is.
   *
   * Passed rather than constructed here: an overlay registers on the registry its own
   * window owns (I-023-12's no-shared-state property), and a deck that made its own
   * would be tracking an airspace nothing claims. The tracker has taken this option
   * since it was written; until now no component could supply it.
   */
  readonly airspace?: AirspaceRegistry;
}

/** No pane came back from a lost window, once — a stable identity for the default. */
const NO_LOST_WINDOW_NOTICES: ReadonlyMap<string, ConsoleRefusal> = new Map();

export function Deck(props: DeckProps): React.JSX.Element {
  const { layout } = props;
  const state = useDeckLayoutState(layout);
  const containerReference = useRef<HTMLDivElement>(null);
  const [clock] = useState(() => new RealClock());
  const tracker = usePaneRectTracker({
    clock,
    ...(props.onPaneRects === undefined ? {} : { onRects: props.onPaneRects }),
    ...(props.airspace === undefined ? {} : { airspace: props.airspace }),
  });
  usePaneRectSources(tracker, containerReference, state.revision);
  useSeparatorValueBoundsCorrection(containerReference, state.revision);

  // Read HERE and not inside the drag seam: this is the component with the
  // context, and a deck mounted outside `LiveAnnouncerProvider` throws on this line
  // rather than reordering panes in a silence nobody watching can detect.
  const announce = useAnnounce();
  const dragCoordinator = useDeckDragCoordinator();
  useDeckDragMonitor(dragCoordinator, layout, announce);
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
      // `Alt` alone, so nothing here collides with the palette's `$mod` chords.
      if (!event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      // AND NOT FROM INSIDE A WIDGET THAT OWNS THESE KEYS. `Alt` alone is not the
      // separation it was written as: on macOS Option+Arrow is word-wise caret
      // movement and Option+Backspace deletes a word, and a pane body's find field,
      // composer, or listbox bubbles those here. Without this the deck would move
      // or CLOSE the pane somebody was typing in, and call `preventDefault` on the
      // keystroke they meant. The chords stay available from the pane chrome, which
      // is what has focus whenever a body does not.
      if (isEditableTarget(event.target)) {
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
   * to them at the end of it (`deck/rect-discipline.ts`). It is a read, queued to the
   * next frame by the tracker; it writes no layout, which is the rule that callback
   * exists under.
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
  const detachedPaneIds = props.detachedPaneIds ?? [];
  const lostWindowNotices = props.lostWindowNoticesByPaneId ?? NO_LOST_WINDOW_NOTICES;
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
          {state.panes.map((pane, position) => {
            const lostWindowNotice = lostWindowNotices.get(pane.paneId);
            return (
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
                  isDetached={detachedPaneIds.includes(pane.paneId)}
                  {...(props.onOpenInWindow === undefined
                    ? {}
                    : { onOpenInWindow: props.onOpenInWindow })}
                  {...(props.onFocusDetachedWindow === undefined
                    ? {}
                    : { onFocusDetachedWindow: props.onFocusDetachedWindow })}
                  {...(props.onReturnToDeck === undefined
                    ? {}
                    : { onReturnToDeck: props.onReturnToDeck })}
                  {...(props.detachedSignalRefusal === undefined
                    ? {}
                    : { detachedSignalRefusal: props.detachedSignalRefusal })}
                  {...(lostWindowNotice === undefined ? {} : { lostWindowNotice })}
                  {...(props.onDismissLostWindow === undefined
                    ? {}
                    : { onDismissLostWindow: props.onDismissLostWindow })}
                  trackElement={trackElement}
                  untrackElement={untrackElement}
                />
              </Fragment>
            );
          })}
        </Group>
      )}
    </div>
  );
}
