// The accessory rail's named bounds.
//
// `console/core/constants.ts` states where a bound belongs: "each view family adds
// its own module beside its subtree rather than widening this one, so a bound
// always sits next to the code that spends it". This is that module for the
// composer's accessories, and every value here is spent by a sibling file in this
// directory.
//
// Percentages are stated as the wire states them — whole percent, 0 to 100 — so a
// threshold read here and a `usagePercent` read off the wire compare without a
// conversion nobody would remember to write twice.

/**
 * Context fullness at which the meter adds its compaction hint.
 *
 * `Spec-013 §Context Window and Usage Meters` fixes the number and fixes what it
 * does: the hint is informational and triggers nothing. It lives here so the
 * number a person sees and the number the meter branches on are one value — a
 * hint drawn at a threshold restated in CSS would drift from the sentence.
 */
export const CONTEXT_HINT_PERCENT = 80;

/**
 * Remaining quota at or above which a rate chip is not shown at all.
 *
 * `Spec-013 §Rate-Limit Display` gives three bands by remaining — healthy above
 * 50%, caution from 20 to 50%, urgent below 20% — and shows a chip only below 50.
 * The healthy band is therefore the HIDDEN band, which is why no third chip tone
 * exists: a quota nobody needs to think about earns no pixel and no colour.
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

/**
 * Attachment chips one send may carry.
 *
 * Bound on the CARRIER rather than per file, which is what the design fixes: a
 * send is one act and the cap binds the act. The number is the console's own
 * until the ingest wire lands and publishes an effective one, at which point the
 * served figure replaces it and this bound becomes the pre-read default.
 */
export const ATTACHMENT_CARRIER_COUNT_CAP = 10;
