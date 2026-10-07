// A scroll area whose scrollbar is drawn over its content: it takes no layout width in any state,
// so nothing reflows when it shows, and it fades once the pointer rests. Every scroller but the
// conversation draws its bar through here.
import "overlayscrollbars/overlayscrollbars.css";
import "./OverlayScrollArea.css";

import { ClickScrollPlugin, OverlayScrollbars, type PartialOptions } from "overlayscrollbars";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import { type ComponentPropsWithoutRef, type ReactElement } from "react";

import { OVERLAY_SCROLLBAR_REST_MS } from "#renderer/styles/motion.js";

// The track pages when pressed, which the library does only with this plugin registered.
OverlayScrollbars.plugin(ClickScrollPlugin);

/** Props for `OverlayScrollArea`: the scrolling element's own attributes and its content. */
export type OverlayScrollAreaProps = ComponentPropsWithoutRef<"div">;

/**
 * A `div` that scrolls its content under an overlay scrollbar drawn in the console's tokens. The
 * library wraps the content in its own viewport element, which is the one that scrolls.
 */
export function OverlayScrollArea(props: OverlayScrollAreaProps): ReactElement {
  return <OverlayScrollbarsComponent {...props} options={OVERLAY_SCROLLBAR_OPTIONS} defer />;
}

/**
 * Drawn over the content in the console's tokens, faded once the pointer rests and back on a
 * pointer move or a scroll, its thumb dragged and its track paging. The class is the one
 * `OverlayScrollArea.css` themes; the library takes it as a string, so the sheet repeats it.
 */
const OVERLAY_SCROLLBAR_OPTIONS: PartialOptions = {
  scrollbars: {
    theme: "os-theme-meridian",
    autoHide: "move",
    autoHideDelay: OVERLAY_SCROLLBAR_REST_MS,
    dragScroll: true,
    clickScroll: true,
  },
};
