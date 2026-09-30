// The phase graph's zoom range. A cancellation reason's byte ceiling is the contract's
// `WORKFLOW_CANCEL_REASON_BYTE_CAP`.

/**
 * How far out a long run's phase graph may be zoomed. Below 0.35 (about three times the ranks of
 * 1x) the labels stop being readable. Kept beside the ceiling because the two are one range.
 */
export const RUN_GRAPH_MIN_ZOOM = 0.35;

/** How far in: a reading zoom for a long label; the graph has nothing to inspect at pixel scale. */
export const RUN_GRAPH_MAX_ZOOM = 1.5;
