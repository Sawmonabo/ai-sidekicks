// The accessory rail's named bounds.
//
// A bound sits next to the code that spends it, and the console's own caps sit at
// its floor in `console/core/constants/` — one module per concern, which is what the
// config single-sourcing rules in `apps/desktop/AGENTS.md` state. The shell composes
// console seats but is not a console family, so its bounds have no module down there:
// this is that module for the composer's accessories, and every value here is spent
// by a sibling file in this directory.
//
// Percentages are stated as the wire states them — whole percent, 0 to 100 — so a
// threshold read here and a `usagePercent` read off the wire compare without a
// conversion nobody would remember to write twice.

/**
 * Context fullness at which the meter adds its compaction hint.
 *
 * The number is fixed, and so is what it does: the hint is informational and triggers
 * nothing. It lives here so the number a person sees and the number the meter branches
 * on are one value — a hint drawn at a threshold restated in CSS would drift from the
 * sentence.
 */
export const CONTEXT_HINT_PERCENT = 80;

/**
 * Remaining quota at or above which a rate chip is not shown at all.
 *
 * There are three bands by remaining — healthy above 50%, caution from 20 to 50%,
 * urgent below 20% — and a chip shows only below 50. The healthy band is therefore the
 * HIDDEN band, which is why no third chip tone exists: a quota nobody needs to think
 * about earns no pixel and no colour.
 */
export const RATE_CHIP_VISIBLE_BELOW_REMAINING_PERCENT = 50;

/**
 * Remaining quota below which a rate chip is urgent rather than merely worth
 * noticing. The boundary between the two bands that DO render.
 */
export const RATE_CHIP_URGENT_BELOW_REMAINING_PERCENT = 20;

/**
 * Rate chips rendered before the rail folds the remainder into a count.
 *
 * A person holds several provider accounts and each publishes several windows, so
 * the chip count is bounded by the wire rather than by the design; past this the
 * rail is a wall of amber that says less than one chip would. Six is two rows of
 * three at the composer's ordinary width.
 */
export const RATE_CHIP_RENDER_CAP = 6;

/**
 * Queued items the shelf renders before it folds the remainder into a count.
 *
 * The shelf is a strip above a text input, not a pane: past this the composer
 * stops being a composer. The queue pane is where a long queue is read.
 */
export const QUEUE_SHELF_ROW_CAP = 5;

// THE ATTACHMENT COUNT BOUND IS NOT HERE ANY MORE, and its removal is the rule this
// file states applied to itself. It was declared here as the composer's own figure
// while nothing else in the console knew what a carrier was. It is the DAEMON's
// bound and an operator-tunable default; `core/constants.ts` holds it as
// `ATTACHMENTS_PER_CARRIER_CAP_DEFAULT`, and the repos family reads it through
// `attachmentCarrierFill` for both surfaces that render a fill. A second
// declaration beside a bound that has a home is a value with two answers.
