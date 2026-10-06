// What the tripwire registry (`registry.ts`) retains.

/**
 * Tripwire reports retained in memory. A tripwire that keeps firing is one defect, so the buffer
 * is small and the counter is what grows.
 */
export const TRIPWIRE_REPORT_CAP = 64;
