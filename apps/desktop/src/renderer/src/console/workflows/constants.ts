// The workflows family's named bounds, and the one place each of them is written.
//
// `core/constants.ts` is this module's precedent and its instruction: it holds the
// substrate's bounds and says outright that "each view family adds its own module
// beside its subtree rather than widening this one, so a bound always sits next to
// the code that spends it". This is that module for this family.
//
// WHY A HOME AND NOT A DECLARATION SITE. A bound declared beside its one caller reads
// fine until a second caller needs it: the second site restates the number, the two
// agree until one moves, and nothing fails when they stop agreeing. Naming them here
// makes a bound findable by what it IS — a cap, a ceiling — rather than by which
// component happened to spend it first, which is the property the console's cap census
// checks and the reason a bound is not just a named constant but a named constant with
// one home.
//
// WHAT IS NOT HERE. A layout literal is not a bound: the phase node's width, the rank
// pitch, the fit padding are the picture's own dimensions and live beside the module
// that draws it. The test is whether a second site could plausibly want the SAME
// number and mean the same thing by it.

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
 * How far out a long run may be zoomed. 0.35 shows roughly three times as many ranks
 * as 1×, which is the point past which the label stops being readable at all — below
 * it the picture is a diagram of nothing.
 *
 * Here rather than beside the canvas because it is half of a RANGE: a floor and a
 * ceiling are one decision about what the graph is for, and split across two homes
 * one of them moves alone and the range stops meaning anything.
 */
export const PHASE_GRAPH_MIN_ZOOM = 0.35;

/**
 * How far in. 1.5 is a reading zoom for a long label, not a design tool's zoom: there
 * is nothing on this surface to inspect at pixel scale.
 */
export const PHASE_GRAPH_MAX_ZOOM = 1.5;
