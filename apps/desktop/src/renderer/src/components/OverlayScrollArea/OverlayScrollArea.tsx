// A scroll area whose scrollbar is drawn over its content: it takes no layout width in any state,
// so nothing reflows when it shows, and it fades once the pointer rests. Every scroller but the
// conversation draws its bar through here.
import "overlayscrollbars/overlayscrollbars.css";
import "./OverlayScrollArea.css";

import { ClickScrollPlugin, OverlayScrollbars } from "overlayscrollbars";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import { type ComponentPropsWithoutRef, type ReactElement } from "react";

import { OVERLAY_SCROLLBAR_OPTIONS } from "#renderer/styles/motion.js";

// The track pages when pressed, which the library does only with this plugin registered.
OverlayScrollbars.plugin(ClickScrollPlugin);

/** Props for `OverlayScrollArea`: the scrolling element's own attributes and its content. */
export type OverlayScrollAreaProps = ComponentPropsWithoutRef<"div">;

/**
 * A `div` that scrolls its content under an overlay scrollbar in the Meridian theme. The library
 * wraps the content in its own viewport element, which is the one that scrolls.
 */
export function OverlayScrollArea(props: OverlayScrollAreaProps): ReactElement {
  return <OverlayScrollbarsComponent {...props} options={OVERLAY_SCROLLBAR_OPTIONS} defer />;
}
