// A module of its own because `electron-harness.ts` and `launch-readiness.ts` both print a
// breadcrumb.

/**
 * The prefix every launch breadcrumb carries, so a CI log is greppable for the whole set. It is
 * unconditional, not opt-in, since a breadcrumb nobody enabled is missing once the run that needs
 * it has finished. Lower-case and bracketed, unlike the smoke tags in `src/shared/probe-tags.ts`
 * that a scanner parses.
 */
export const LAUNCH_TRACE_TAG: string = "[sidekicks-launch]";
