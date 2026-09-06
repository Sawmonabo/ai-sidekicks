// The sidebar's width control: a separator a person can drag or drive.
//
// `role="separator"` with `tabIndex={0}` is the platform's own answer to a
// resizable pane boundary, and it is the reason this is a real control rather
// than a CSS `resize` corner: a separator that is focusable and reports
// `aria-valuenow` announces the width it is at and takes arrow keys, so the
// sidebar is resizable by someone who never touches a pointer.
//
// POINTER CAPTURE, NOT A DOCUMENT LISTENER. `setPointerCapture` routes every move
// and the release back to this element even when the pointer leaves it, so there
// is no window-level `mousemove` to remove and no drag that survives a lost
// `mouseup` — the failure mode a document listener has and the reason a stuck
// resize is a bug people recognise from other apps.
//
// The width itself is the model's, clamped and persisted there. This component
// holds only the drag's origin, which is per gesture and dies with it.

import { useRef } from "react";

import { SIDEBAR_MAX_WIDTH_PX, SIDEBAR_MIN_WIDTH_PX } from "../../core/index.js";
import { SIDEBAR_WIDTH_KEYBOARD_STEP_PX } from "./sidebar-constants.js";

export interface SidebarResizeHandleProps {
  readonly widthPx: number;
  readonly onResize: (widthPx: number) => void;
}

interface DragOrigin {
  readonly pointerId: number;
  readonly clientX: number;
  readonly widthPx: number;
}

export function SidebarResizeHandle(props: SidebarResizeHandleProps): React.JSX.Element {
  const dragOriginRef = useRef<DragOrigin | undefined>(undefined);

  return (
    <div
      className="meridian-sidebar__resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuenow={props.widthPx}
      aria-valuemin={SIDEBAR_MIN_WIDTH_PX}
      aria-valuemax={SIDEBAR_MAX_WIDTH_PX}
      tabIndex={0}
      onPointerDown={(event) => {
        // Primary button only: a right-click on a separator opens a context menu,
        // and capturing it would swallow that without offering anything.
        if (event.button !== 0) {
          return;
        }
        dragOriginRef.current = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          widthPx: props.widthPx,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const origin = dragOriginRef.current;
        if (origin?.pointerId !== event.pointerId) {
          return;
        }
        props.onResize(origin.widthPx + (event.clientX - origin.clientX));
      }}
      onPointerUp={(event) => {
        if (dragOriginRef.current?.pointerId === event.pointerId) {
          dragOriginRef.current = undefined;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => {
        // A cancelled gesture keeps whatever width the last move produced. The
        // alternative — snapping back to the origin — would undo a resize the
        // person watched happen, because a cancel is usually the OS taking the
        // pointer, not the person changing their mind.
        dragOriginRef.current = undefined;
      }}
      onKeyDown={(event) => {
        const step = keyboardStepFor(event.key);
        if (step === undefined) {
          return;
        }
        // Consumed here rather than left to bubble: the sidebar's own chord table
        // is installed on the container in capture phase, and an arrow key that
        // reached it would move the section cursor at the same time as the width.
        event.preventDefault();
        event.stopPropagation();
        props.onResize(props.widthPx + step);
      }}
    />
  );
}

/**
 * How far one key moves the separator, or `undefined` for a key it does not own.
 *
 * `Home` and `End` go to the bounds rather than to a step, which is what a
 * separator's `aria-valuemin` / `aria-valuemax` promise a keyboard user: the
 * extremes are one press away rather than seventeen.
 */
function keyboardStepFor(key: string): number | undefined {
  switch (key) {
    case "ArrowLeft":
      return -SIDEBAR_WIDTH_KEYBOARD_STEP_PX;
    case "ArrowRight":
      return SIDEBAR_WIDTH_KEYBOARD_STEP_PX;
    case "Home":
      return SIDEBAR_MIN_WIDTH_PX - SIDEBAR_MAX_WIDTH_PX;
    case "End":
      return SIDEBAR_MAX_WIDTH_PX - SIDEBAR_MIN_WIDTH_PX;
    default:
      return undefined;
  }
}
