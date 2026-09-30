// The pane layout: the panes a person is looking at, side by side. It is the frame (order,
// widths, focus, the separators, the keyboard paths, and the one place each pane body is
// mounted from), not any pane's content: every body comes from the pane registry by kind, so
// a second open of the same entity focuses the pane that exists.
//
// Layout lives in `PaneLayoutStore`, never in `useState`; this component subscribes and
// dispatches, so the restore path has one place to write. Rows are memoized so a streaming
// session re-renders only the pane whose store changed. Keyboard comes before pointer: focus,
// move and close are chords, and resize is on the separator, which the arrow keys operate.
//
// `react-resizable-panels` owns the resize gesture, the flex arithmetic and the
// window-splitter ARIA, but not the layout: the group reports back to the store. Its crossed
// `aria-valuemin` / `aria-valuemax` on later separators is corrected in
// `separator-value-bounds.ts`. A pane's floor rides the panel's `minSize` in pixels; upstream
// reports a pixel floor being rescaled as a percentage across a window resize, so
// `PaneLayoutStore.applyLayout` clamps again over a freshly measured layout, and only the
// store's clamp is written to disk.
//
// `@atlaskit/pragmatic-drag-and-drop` owns the pointer reorder gesture as the browser's own
// HTML5 drag, so no React render happens per frame. It has no keyboard drag by design, so the
// Alt+Shift chords below are the accessible path. The store, the separator's chrome, the drop
// indicator, the keyboard reorder and the density floor are our own; neither library is
// imported for a stylesheet.

import "./pane-layout.css";

import { Fragment, useCallback, useMemo, useRef } from "react";
import { Group, Separator } from "react-resizable-panels";

import { type Refusal } from "@renderer/lib/refusal.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { isEditableTarget } from "@renderer/lib/editable-target.js";
import { useAnnounce } from "@renderer/hooks/useAnnounce.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { type PaneRegistry } from "@renderer/registries/panes/pane-registry.js";
import { usePaneLayoutState } from "../hooks/usePaneLayoutState.js";
import { type PaneLayoutStore } from "../pane-layout-store.js";
import { paneLayoutActsOn } from "../pane-layout-acts.js";
import { useMountedPaneLayout } from "../hooks/useMountedPaneLayout.js";
import {
  PANE_LAYOUT_TOTAL_PERMILLE,
  toPaneSizePercentages,
  type SessionPane,
} from "../pane-layout.js";
import { type PaneLayoutDensity } from "../pane-layout-measures.js";
import { minimumPaneWidthPx } from "../pane-layout-density.js";
import { usePaneLayoutDragCoordinator } from "../hooks/usePaneLayoutDragCoordinator.js";
import { usePaneLayoutDragMonitor } from "../hooks/usePaneLayoutDragMonitor.js";
import { usePaneLayoutDropIndicator } from "../hooks/usePaneLayoutDropIndicator.js";
import { SessionPaneSlot } from "./SessionPaneSlot.js";
import { type TrackedRect } from "../pane-rect-geometry.js";
import { usePaneRectSources } from "../hooks/usePaneRectSources.js";
import { usePaneRectTracker } from "../hooks/usePaneRectTracker.js";
import { useSeparatorValueBoundsCorrection } from "../hooks/useSeparatorValueBoundsCorrection.js";

/** What the pane layout needs: its layout store, its pane registry, and each pane's context. */
export interface SessionPaneLayoutProps {
  readonly layout: PaneLayoutStore;
  /** Where pane bodies come from. Passed rather than reached for, so a host picks its own. */
  readonly registry: PaneRegistry;
  /** What each pane's body is handed, or why its address cannot be served. */
  readonly paneContextFor: (pane: SessionPane) => PaneContext | Refusal;
  /** What the layout restore refused, rendered rather than swallowed. */
  readonly restoreRefusals?: readonly Refusal[];
  /** Where measured pane rects go, for a body that hosts a native view; see the rect tracker. */
  readonly onPaneRects?: (rects: readonly TrackedRect[]) => void;
}

/** The panes a person is looking at, side by side, arranged by a `PaneLayoutStore`. */
export function SessionPaneLayout(props: SessionPaneLayoutProps): React.JSX.Element {
  const { layout } = props;
  const state = usePaneLayoutState(layout);
  const containerReference = useRef<HTMLDivElement>(null);
  // The window's own clock, not a second time base: under the fixture it is the scenario's
  // frozen clock, which every other view reads. A separate real clock made rect-flush timing
  // depend on the runner.
  const clock = useClock();
  const tracker = usePaneRectTracker({
    clock,
    ...(props.onPaneRects === undefined ? {} : { onRects: props.onPaneRects }),
  });
  usePaneRectSources(tracker, containerReference, state.revision);
  useSeparatorValueBoundsCorrection(containerReference, state.revision);

  // Read here, in the component with the context: outside `LiveAnnouncerProvider` this throws
  // instead of reordering panes in a silence nobody can detect.
  const announce = useAnnounce();
  const dragCoordinator = usePaneLayoutDragCoordinator();
  usePaneLayoutDragMonitor(dragCoordinator, layout, announce);
  const dropIndicator = usePaneLayoutDropIndicator(dragCoordinator);

  // The five acts, built once per (layout, announcer) pair and shared by this component's key
  // handler and the palette rows in `contributions/commands.ts`, so a chord and a row cannot
  // mean two moves.
  const acts = useMemo(() => paneLayoutActsOn(layout, announce), [layout, announce]);
  useMountedPaneLayout(acts);

  /**
   * The density floor as a share of the pane layout, in permille, right now. Measured at the
   * moment of the act rather than held in state, since a width kept in state would go stale
   * exactly when the window is resized. Read inside a callback, never during a render.
   */
  const minimumPermille = useCallback(
    (density: PaneLayoutDensity): number => {
      const paneLayoutWidth = containerReference.current?.getBoundingClientRect().width ?? 0;
      if (paneLayoutWidth <= 0) {
        return 0;
      }
      return Math.round(
        (minimumPaneWidthPx(density) / paneLayoutWidth) * PANE_LAYOUT_TOTAL_PERMILLE,
      );
    },
    [containerReference],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // `Alt` alone, so nothing collides with the palette's `$mod` chords.
      if (!event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      // Not from inside a widget that owns these keys: on macOS Option+Arrow moves the caret
      // by word and Option+Backspace deletes a word, and a find field, composer or listbox
      // bubbles those here. The chords stay available from the pane chrome.
      if (isEditableTarget(event.target)) {
        return;
      }
      switch (event.key) {
        case "ArrowRight":
        case "ArrowLeft": {
          const goingRight = event.key === "ArrowRight";
          if (event.shiftKey) {
            if (goingRight) {
              acts.moveFocusedPaneRight();
            } else {
              acts.moveFocusedPaneLeft();
            }
          } else if (goingRight) {
            acts.focusNextPane();
          } else {
            acts.focusPreviousPane();
          }
          event.preventDefault();
          return;
        }
        case "Backspace":
        case "Delete": {
          // Consumed only where there is a pane to close, so an unfocused layout leaves
          // Backspace to whatever else wanted it, as the window's binding table does.
          if (state.focusedPaneId !== undefined) {
            acts.closeFocusedPane();
            event.preventDefault();
          }
          return;
        }
        default:
          return;
      }
    },
    [acts, state.focusedPaneId],
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
   * `onLayoutChanged` fires once, on pointer release or key press, and is what the store
   * keeps; writing every frame would put sixty arrangements a second through the persistence
   * writer. `onLayoutChange` fires every frame of the drag and only invalidates the pane
   * rects, so a native view hosted in a pane tracks its bounds through the resize. It writes
   * no layout.
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
      className="meridian-pane-layout"
      data-density={state.density}
      role="group"
      aria-label="Open panes"
      onKeyDown={onKeyDown}
    >
      {refusals.length === 0 ? null : (
        <div className="meridian-pane-layout__refusals" role="status">
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
        <Nothing kind="empty" placement="block" title="No panes are open." />
      ) : (
        <Group
          className="meridian-pane-layout__group"
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
                  className="meridian-pane-layout__separator"
                  aria-label="Resize the pane to the left"
                />
              )}
              <SessionPaneSlot
                pane={pane}
                density={state.density}
                registry={props.registry}
                paneContextFor={props.paneContextFor}
                dragCoordinator={dragCoordinator}
                dropIndicator={
                  dropIndicator?.overPaneId === pane.paneId ? dropIndicator.edge : undefined
                }
                onFocus={focusPane}
                onClose={closePane}
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
