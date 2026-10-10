// The pane layout: the panes side by side, their order, widths, focus, separators and keyboard
// paths, and the one place each pane body is mounted from the pane registry by kind. Layout
// lives in `PaneLayoutStore`; this component subscribes and dispatches.
//
// `react-resizable-panels` owns the resize gesture and the window-splitter ARIA, and reports
// back to the store, which clamps again over a freshly measured layout because upstream rescales
// a pixel floor as a percentage across a window resize. A pane's header drags it to a new place
// through the shared pointer reorder, and the Alt+Shift chords below move the focused pane.

import "./SessionPaneLayout.css";

import { Fragment, useCallback, useMemo, useRef } from "react";
import { Group, Separator } from "react-resizable-panels";

import { type Refusal } from "#renderer/lib/refusal/contract.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { isEditableTarget } from "#renderer/lib/editable-target.js";
import { useAnnounce } from "#renderer/hooks/announce/useAnnounce.js";
import { useReorderDrag } from "#renderer/hooks/useReorderDrag.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import { type PaneContext } from "#renderer/registries/panes/context.js";
import { type PaneRegistry } from "#renderer/registries/panes/registry.js";
import { usePaneLayoutState } from "../hooks/usePaneLayoutState.js";
import { type PaneLayoutStore } from "../store.js";
import { paneLayoutActsOn } from "../acts.js";
import { useMountedPaneLayout } from "../hooks/useMountedPaneLayout.js";
import { PANE_LAYOUT_TOTAL_PERMILLE, toPaneSizePercentages, type SessionPane } from "../state.js";
import { type PaneLayoutDensity } from "../measures.js";
import { minimumPaneWidthPx } from "../density.js";
import { commitPaneDrop } from "../drag.js";
import { SessionPaneSlot } from "./SessionPaneSlot.js";

/** What the pane layout needs: its layout store, its pane registry, and each pane's context. */
export interface SessionPaneLayoutProps {
  readonly layout: PaneLayoutStore;
  /** Where pane bodies come from. Passed rather than reached for, so a host picks its own. */
  readonly registry: PaneRegistry;
  /** What each pane's body is handed, or why its address cannot be served. */
  readonly paneContextFor: (pane: SessionPane) => PaneContext | Refusal;
  /** Whether the session's store has opened; until it has, each pane draws its frame alone. */
  readonly isSessionOpen: boolean;
  /** The session the panes are about, which a pane's frame names while it draws no body. */
  readonly sessionId: string | undefined;
}

/** The panes a person is looking at, side by side, arranged by a `PaneLayoutStore`. */
export function SessionPaneLayout(props: SessionPaneLayoutProps): React.JSX.Element {
  const { layout } = props;
  const state = usePaneLayoutState(layout);
  const containerReference = useRef<HTMLDivElement>(null);

  // Read here, in the component with the context: outside `LiveAnnouncerProvider` this throws
  // instead of reordering panes in a silence nobody can detect.
  const announce = useAnnounce();
  const paneIds = useMemo(() => state.panes.map((pane) => pane.paneId), [state.panes]);
  const onPaneDrop = useCallback(
    (paneId: string, toPosition: number) => {
      commitPaneDrop(layout, paneId, toPosition, announce);
    },
    [layout, announce],
  );
  const clock = useClock();
  const paneDrag = useReorderDrag("horizontal", paneIds, onPaneDrop, clock);

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
  /**
   * Adopt what the group settled on. `onLayoutChanged` fires once, on pointer release or key
   * press; writing every frame would put sixty arrangements a second through the persistence
   * writer.
   */
  const onLayoutSettled = useCallback(
    (percentages: Readonly<Record<string, number>>) => {
      layout.applyLayout(percentages, minimumPermille(state.density));
    },
    [layout, minimumPermille, state.density],
  );

  const defaultLayout = useMemo(() => toPaneSizePercentages(state.panes), [state.panes]);

  return (
    <div
      className="meridian-pane-layout"
      data-density={state.density}
      role="group"
      aria-label="Open panes"
      onKeyDown={onKeyDown}
    >
      {state.panes.length === 0 ? (
        <Nothing kind="empty" placement="block" title="No panes are open." />
      ) : (
        <Group
          className="meridian-pane-layout__group"
          elementRef={containerReference}
          orientation="horizontal"
          defaultLayout={defaultLayout}
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
                isSessionOpen={props.isSessionOpen}
                sessionId={props.sessionId}
                paneDrag={paneDrag}
                onFocus={focusPane}
                onClose={closePane}
              />
            </Fragment>
          ))}
        </Group>
      )}
    </div>
  );
}
