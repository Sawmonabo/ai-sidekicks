// The workflows family's bounds: a cancellation reason's byte ceiling and the phase
// graph's zoom range.

/**
 * Bytes a cancellation reason may occupy, bounded exactly as the engine's own park
 * cause is: eight kibibytes, measured on the UTF-8 encoding rather than on the
 * string's length, because a bound counted in code units refuses a shorter sentence
 * in one script than in another.
 *
 * The unit is spelled out rather than abbreviated on purpose — the console's
 * byte-scaling chokepoint is asserted by scanning every source module for a binary
 * unit LABEL, and a comment carrying one would read as a second byte formatter.
 * Multiplying up to a bound is not scaling down to a display figure.
 */
export const WORKFLOW_CANCEL_REASON_BYTE_CAP: number = 8 * 1024;

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
