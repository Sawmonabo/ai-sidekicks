// Its own module because two print a breadcrumb: `electron-harness.ts` says how the
// close settled and `launch-readiness.ts` says what the first frame cost.

/**
 * The prefix every launch breadcrumb carries.
 *
 * One tag, so a CI log is greppable for the whole set: a tier that failed on a
 * late first frame is diagnosable only if the passing launches printed what
 * their own first frame cost. The smoke test's boot fix records the same shape
 * for the same runner (`[SIDEKICKS_SMOKE_READY]`); this one is unconditional
 * rather than opt-in, because a breadcrumb nobody enabled is a breadcrumb nobody
 * has when the run they need it for has already finished.
 *
 * Lower-case and bracketed rather than the smoke tag's shouted form: that one is
 * parsed by a scanner and this one is only read.
 */
export const LAUNCH_TRACE_TAG: string = "[sidekicks-console-launch]";
