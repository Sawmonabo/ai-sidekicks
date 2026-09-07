// How long this shell gives the daemon to finish writing before it stops it.
//
// ONE VALUE, TWO PROCESSES, AND IT WAS TWO VALUES. The restart confirmation told a
// person the daemon is given up to ten seconds to finish writing, and the quit path
// raced `PtyHost.shutdown()` against a five-second wall-clock cap declared in
// `src/main/sidecar-lifecycle.ts` as `HARD_QUIT_CAP_MS`. Both were rationale-carrying
// declarations, neither knew about the other, and the disagreement was invisible from
// either side: nothing in the renderer can see main's cap, nothing in main renders the
// sentence, and no test compared them. What a person read was a promise the shell did
// not keep — the daemon was stopped at five seconds with half the budget it had been
// pledged, and a run whose flush needed the second half lost it silently.
//
// THE VALUE IS THE SPEC'S. `Spec-023 §Main Process Responsibilities` fixes it under App
// lifecycle: "Graceful shutdown on `before-quit` — signal the daemon to flush, wait up
// to a 10-second budget, then force-terminate." So the disagreement resolves upward
// rather than by meeting in the middle: the sentence was quoting the governing document
// correctly and the cap was the half that had drifted from it. Narrowing the sentence to
// five seconds would have made two documents agree with each other and both disagree
// with the spec that decides.
//
// AND IT IS HERE BECAUSE `src/shared/` IS THE ONLY PLACE BOTH SIDES CAN REACH. Main
// never imports from `src/renderer/`, the renderer never imports from `src/main/`, and a
// value both need therefore has exactly one home that is not a hand-mirrored copy. The
// console reaches it through `console/core/index.ts`, which re-publishes it the way it
// already re-publishes `lossyStringify` from `wire-errors.ts` — the layer family that
// owns the concern, so no view family reaches past the console DAG to get here.
//
// A BUDGET, NOT A SUB-BUDGET. `DEFAULT_SIDECAR_LIFECYCLE_TIMEOUTS` next to the drain
// bounds the per-session and host legs at two seconds each; this is the outer wall-clock
// ceiling the whole drain is raced against, which is the figure the sentence quotes and
// the only one a person experiences. The inner budgets stay where they are and stay
// independent — dimensioning them separately is what lets the lifecycle layer observe
// the sidecar's own SIGTERM cascade resolve before it escalates.

/**
 * The wall-clock ceiling (milliseconds) on the graceful daemon shutdown wait.
 *
 * Read by `src/main/sidecar-lifecycle.ts`, which races the drain against it, and quoted
 * by the console's restart confirmation, which renders it as a derived figure. Neither
 * side declares a second one; `test/console/architecture/shutdown-budget-single-home.test.ts`
 * is what keeps that true.
 */
export const DAEMON_SHUTDOWN_FLUSH_BUDGET_MS = 10_000;
