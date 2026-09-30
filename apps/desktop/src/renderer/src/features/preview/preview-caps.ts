// Bounds for the embedded browser's geometry observation.
/**
 * How many boxes beside the pane's ancestry the position observer watches for a size change.
 * An auto-sized sibling that grows moves the pane while no other watched box changes, and no
 * other source sees it.
 *
 * Bounded because the sibling count belongs to the document, not the pane: a pane nested in a
 * live feed has a sibling per row, and an observer per row is a per-row layout cost. Past the
 * cap the nearest siblings are the ones observed, since they move the pane furthest.
 */
export const POSITION_SIBLING_OBSERVER_CAP = 64;
