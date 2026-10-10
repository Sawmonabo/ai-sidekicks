// The reveal engine's figures: its per-frame budget, the gate's walk, the catch-up share and the
// size of the chunks a lane's text is held in.

/**
 * The most characters one chunk of a lane's text holds; every chunk but the last holds exactly
 * this many, so an offset finds its chunk by division.
 *
 * An append rebuilds only the last, partly filled chunk, so it copies at most this much, and a
 * frame copies nothing: revealing moves a number. Above a lane's largest share of a frame (the
 * frame's whole budget), so a frame's reveal crosses at most one chunk edge; small next to a long
 * reply, which at some 680 KB is about 665 chunks whose string headers cost under 2% of the text.
 * A slice a reader keeps pins at most one chunk.
 */
export const REVEAL_TEXT_CHUNK_CHARACTERS = 1_024;

/**
 * Characters the reveal engine publishes per frame, across every lane.
 *
 * Sized to the frame budget, not reading speed: about 28,000 characters a second at 60 Hz,
 * which outruns every provider's output and leaves the frame time for layout. The per-lane
 * share is this divided across the lanes with work.
 */
export const REVEAL_FRAME_CHARACTER_BUDGET = 480;

/**
 * How far the reveal gate walks back from a candidate ceiling looking for a literal-safe
 * stopping point.
 *
 * Bounded so a run of volatile characters (a rule of asterisks, a table border) cannot make
 * the walk proportional to the block's length every frame. Eight covers every incomplete
 * construct the gate withholds (a fence, a link opener, an emphasis run).
 */
export const REVEAL_LITERAL_BACKTRACK_CAP = 8;

/**
 * The largest multiple of its fair share a lane behind the others may take: catch-up raises a
 * lane's rate and never jumps it. Three is visible and still leaves two thirds of the frame's
 * budget for the lanes keeping pace.
 */
export const REVEAL_CATCH_UP_MULTIPLIER = 3;

/**
 * Characters of already-revealed text the gate is shown behind the cursor: enough to see the
 * start of the cursor's line for the digit-period carve-out, small enough to rebuild in constant
 * time however long the message grows.
 */
export const REVEAL_GATE_TAIL_CHARACTERS = 64;
