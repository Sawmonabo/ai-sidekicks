// The workflows family's bounds: the phase graph's zoom range. A cancellation reason's
// byte ceiling is the contract's, `WORKFLOW_CANCEL_REASON_BYTE_CAP`.

/**
 * How far out a long run's phase graph may be zoomed. 0.35 shows roughly three times
 * as many ranks as 1x, which is the point past which the label stops being readable
 * at all — below it the picture is a diagram of nothing.
 *
 * Beside its ceiling rather than beside the canvas because the two are half of a
 * RANGE: a floor and a ceiling are one decision about what the graph is for, and
 * split across two homes one of them moves alone and the range stops meaning
 * anything. The ceiling's name carries a bound's own segment and belongs here on
 * that ground alone; the floor follows it so the decision keeps one home.
 */
export const PHASE_GRAPH_MIN_ZOOM = 0.35;

/**
 * How far in. 1.5 is a reading zoom for a long label, not a design tool's zoom:
 * there is nothing on this surface to inspect at pixel scale.
 */
export const PHASE_GRAPH_MAX_ZOOM = 1.5;
