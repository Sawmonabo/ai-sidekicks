// The timing bounds an app launch and its test body are held to, read once from
// `tests/budget/document.json` through `BudgetRegistry`. One module so `frame-paint-probe.ts` and
// `deadline.ts` share each figure without either owning the other's. These are
// `harness`-scoped rows: no product figure stands behind them.

import { BudgetRegistry } from "../budget/registry.js";

const BUDGETS = BudgetRegistry.load();

/**
 * How long the whole readiness ladder gets, in aggregate.
 *
 * It bounds a cold Electron start on a shared CI runner, a different quantity from the app's
 * budgets: a tight bound would turn runner contention into a red tier. Its four phases share it.
 */
export const READINESS_BUDGET_MS: number = BUDGETS.requireCanonicalValue("launch-readiness");

/**
 * How long a ready renderer has to deliver two consecutive animation frames.
 *
 * Measured over twenty launches on an eight-core Apple-silicon host (five idle, five with the GPU
 * disabled under SwiftShader, ten under a load average near 280): 1-18 ms in the renderer and
 * 2-47 ms driver-side. The 47 ms outlier is a CDP round trip queued behind a busy main thread; its
 * renderer reported 4 ms. No local host reproduces the driver-side queue a 2-vCPU runner shows
 * while mounting the app, so the bound is not the local worst case plus a margin.
 *
 * It is derived from the cost asymmetry instead: too tight fails a working window, too loose
 * only delays reporting a throttled launch, which delivers no frame and spends the whole budget
 * anyway. So it is the largest value keeping two orderings: at most half of
 * `READINESS_BUDGET_MS`, so a window problem fails naming the window, and reserved inside
 * `LAUNCH_BUDGET_MS`, which `deadline.ts` holds against each launching tier's
 * `testTimeout`, so a reader sees this paint probe's sentence rather than vitest's.
 */
export const FRAME_PAINT_PROBE_TIMEOUT_MS: number = BUDGETS.requireCanonicalValue(
  "launch-frame-paint-probe",
);

/**
 * How long `application.close()` gets before the process tree is SIGKILLed.
 *
 * `cleanup/bounded.ts` races the close against it, so what matters is that some finite bound is
 * enforced against a wedged Electron, not that it is tight. It applies unchanged on the
 * failed-launch and success paths. Crossing it costs a kill and a breadcrumb, never a red check:
 * `terminated` records and passes, while `unterminable` and `closed-after-rejection` fail.
 */
export const CLEANUP_BUDGET_MS: number = BUDGETS.requireCanonicalValue("launch-cleanup");

/**
 * How long a test body gets between a settled launch and its cleanup.
 *
 * `body.ts` applies it and `tierTimeoutFor` (`deadline.ts`) sums it into the
 * tier's timeout, so raising it raises the tier's patience instead of eating the cleanup. It is
 * the default for a tier that states none, and the shorter of the two, so a new tier whose body
 * needs longer fails inside a bound that names itself, not under vitest's generic kill.
 */
export const BODY_ALLOWANCE_MS: number = BUDGETS.requireCanonicalValue("launch-body");

/**
 * The body allowance for the endurance tier's sustained workload. A second row because an
 * endurance body drives hundreds of churn cycles while an end-to-end body drives one
 * interaction; one figure sized for the first would make runner contention look like a hang in
 * the second.
 */
export const ENDURANCE_BODY_ALLOWANCE_MS: number = BUDGETS.requireCanonicalValue("endurance-body");
