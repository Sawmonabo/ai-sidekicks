// The embedded browser's bounds: its position observer's sibling reach, its settings
// page's partition fold, and its pane shelf's two row caps. The shelf pair states the
// line all four sit on the renderer's side of.

/**
 * Boxes beside the pane's ancestry whose intrinsic size the position observer
 * watches.
 *
 * The observer covers content-driven layout by watching each SIBLING of the pane and
 * of its ancestors: an auto-sized sibling that grows on a text-node update or a
 * nested insertion moves the pane while no watched box changes shape, no watched
 * attribute changes, and no ancestor's direct child list moves. Nothing else in the
 * module can see that.
 *
 * Bounded because the sibling count is a property of the DOCUMENT, not of the pane. A
 * pane nested inside a live feed has as many siblings as the feed has rows, and an
 * observer per row is the per-row layout cost the attribute observer's own width rule
 * already refuses. Sixty-four covers every layout the console composes with room to
 * spare; past it the NEAREST siblings are the ones observed, because a box beside the
 * pane moves it further than a box beside the document body does, and the remainder
 * stays covered by the five sources that do not depend on this one.
 */
export const POSITION_SIBLING_OBSERVER_CAP = 64;

// Two display bounds over renderer lists, and NEITHER is one of the browser
// subsystem's resource ceilings — those live in `browser/bounds/browser-bounds.ts`
// and are the daemon's. Nothing is refused, truncated, or deleted because of these:
// what is dropped is a row nobody scrolled to.
