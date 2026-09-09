// What the tripwire registry retains. Spent by `core/tripwires.ts` beside it.

/**
 * Tripwire reports retained in memory. A tripwire that keeps firing is one
 * defect, not thousands, so the buffer is small and the counter is what grows.
 */
export const TRIPWIRE_REPORT_CAP = 64;
