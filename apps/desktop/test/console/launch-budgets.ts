// The three timing bounds a console launch is held to, read from the registry.
//
// They used to be TypeScript literals — 30 000, 15 000 and 10 000 — sitting one
// directory away from `test/console/budget/budgets.json`, which is this package's
// one home for a budget and its unit factor. So the launcher's own bounds were
// the only numbers in the tree gated by nothing and reviewable nowhere, while
// every product budget beside them carried a subject, a derivation, and a test
// that fails when a row goes missing. They are rows now, and this module is the
// one place they are read: the same `ConsoleBudgetRegistry` path the bundle and
// heap harnesses take.
//
// A module of its own rather than a load in each consumer. `frame-witness.ts` and
// `launch-deadline.ts` both need these figures and one imports the other, so
// putting the registry handle in either would either duplicate the read or make
// the witness the owner of the deadline's numbers. Here, each figure is read
// exactly once and named exactly once.
//
// These are `harness`-scoped rows: no `Spec-023 §Budgets` figure stands behind
// them, which is why the registry discriminates the two kinds rather than
// merging them — the spec table's completeness claim has to stay countable.

import { ConsoleBudgetRegistry } from "../../scripts/budget/budget-registry.mjs";

const BUDGETS = ConsoleBudgetRegistry.load();

/**
 * How long the whole readiness ladder gets, in aggregate.
 *
 * This bounds a COLD Electron start on a shared CI runner, which is a different
 * quantity from anything the console's budgets measure — a tight bound here
 * would turn runner contention into a red tier, and the budget tier is where a
 * slow start is supposed to be caught. The value is the per-phase allowance the
 * harness carried before this became a deadline; what changed is that four
 * phases now SHARE it instead of each receiving it.
 */
export const READINESS_BUDGET_MS: number = BUDGETS.requireCanonicalValue(
  "console-launch-readiness",
);

/**
 * How long a READY renderer has to deliver two consecutive animation frames.
 *
 * Derived from measurement, and the derivation matters more than the number
 * because the number this replaces was derived from a display refresh interval —
 * "clearly above a refresh interval and clearly below a tier's patience" — which
 * describes an idle desktop and describes no CI runner.
 *
 * What was measured, and what it showed. The harness prints the figure on every
 * launch (`[sidekicks-console-launch]`), so this rests on real launches rather
 * than an estimate. Twenty of them on an eight-core Apple-silicon host: ten
 * deliberate — five idle, five with the GPU disabled and Chromium rendering
 * through SwiftShader, the shape of the CI runner — and ten more harvested from
 * ordinary tier runs while the host was incidentally at a one-minute load
 * average near 280, roughly 35x oversubscribed. Across all twenty the
 * post-readiness interval was 1-18 ms in the renderer and 2-47 ms driver-side.
 *
 * It does not degrade the way an intuition about load would predict. The single
 * 47 ms outlier is driver-side only — its renderer reported 4 ms — so it is a
 * CDP round trip queued behind a busy main thread rather than a frame schedule
 * that slowed down, and the in-renderer figure barely moves at 35x contention
 * because software rendering is not clamped to a display's refresh.
 *
 * Which settles what the failures were, and it is not the frame schedule. Once a
 * renderer is ready its two frames are a matter of milliseconds. What the old
 * 2 000 ms race actually bounded was the driver side: a `Page.evaluate` round
 * trip lands behind whatever the renderer's main thread is already doing, and on
 * a 2-vCPU runner mounting the console — its store, its scenario engine, its
 * persistence — that queue is the quantity that crossed 2 000 ms, on a window
 * that then painted normally. No local host reproduces it, so the bound cannot
 * be derived from the local worst case plus a margin.
 *
 * It is derived from the asymmetry instead, which is decidable without that
 * figure. Over-tight costs a red check on a window that was working, on a job
 * nobody can then read — the defect this replaces. Over-loose costs only how
 * long a genuinely throttled launch takes to report, and a throttled window
 * delivers no frame at ALL, so it spends the whole budget whatever the budget
 * is. So the bound is the largest value that still keeps its two ordering
 * properties, both of which are now checked rather than asserted: it is at most
 * half of `READINESS_BUDGET_MS`, so a launch whose problem is the WINDOW still
 * fails naming the window, and it is RESERVED inside `LAUNCH_BUDGET_MS`, which
 * `launch-deadline.ts` holds against every launching tier's own resolved
 * `testTimeout` — so a reader sees this witness's sentence rather than vitest's.
 *
 * That last property used to be a ratio in this comment and nothing more, and it
 * was false: the readiness ladder handed each of its four phases an independent
 * 30 000 ms, so a launch could spend 135 000 ms inside a 60 000 ms tier and be
 * killed before this witness ever spoke.
 */
export const FRAME_WITNESS_TIMEOUT_MS: number = BUDGETS.requireCanonicalValue(
  "console-launch-frame-witness",
);

/**
 * How long `application.close()` gets before the process tree is SIGKILLed.
 *
 * An APPLIED bound rather than an arithmetic one: `bounded-cleanup.ts` races the
 * close against it. The quantity it guards against is an Electron that is wedged
 * rather than slow — a close that never settles at all — so what matters is that
 * some finite number is enforced, not that this one is tight.
 *
 * It is the WHOLE applied bound, and the same one on both of the paths that
 * close: a close reached from a failed launch is held to this figure exactly as
 * one reached minutes later on the success path is. It used to be a floor the
 * launch deadline's leftover time could raise — which handed an early failure
 * five times this number and left a budget audit reading a ceiling nothing
 * applied.
 *
 * Because `terminated` records and passes, this figure decides when the process
 * tree is SIGKILLed rather than whether the tier goes red; `unterminable` and
 * `closed-after-rejection` fail, and those are the two settlements that harm the
 * launches after them. That is what makes a figure derived from no CI reading
 * safe to apply here: crossing it costs a kill and a breadcrumb, never a red
 * check on a run whose assertions all passed — which is the promise a bound
 * justified by a local measurement could not have made for a two-core runner.
 */
export const CLEANUP_BUDGET_MS: number = BUDGETS.requireCanonicalValue("console-launch-cleanup");
