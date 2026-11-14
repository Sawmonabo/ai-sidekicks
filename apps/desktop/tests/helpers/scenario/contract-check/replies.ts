// One scripted answer per call and one spendable latency.
//
// Both claims are about a `ScenarioReply`: the entry can be reached, and the delay it scripts can
// be spent. A scenario failing either has a reply no transport would give, and it shows up only as
// a view that never leaves its loading state. That the call is one the app registers, and that its
// value is that call's result, the compiler holds: a reply is typed by its call.

import type { ScenarioContractDefect } from "./defect.js";
import type { Scenario } from "#fixtures/scenario.js";

/**
 * Every reply defect in one scenario: unreachable entries and unspendable latencies.
 *
 * A duplicate entry is reported and skipped rather than also measured, since `replyFor` answers
 * with the first match and a second entry's `afterMs` belongs to a reply that cannot be served.
 */
export function findReplyDefects(scenario: Scenario): readonly ScenarioContractDefect[] {
  const seenCalls = new Set<string>();
  const defects: ScenarioContractDefect[] = [];
  for (const reply of scenario.replies) {
    const subject = `reply "${reply.call}"`;
    if (seenCalls.has(reply.call)) {
      defects.push({
        scenarioId: scenario.id,
        subject,
        reason:
          "a second reply claims this call, and the fixture serves the first — so this one " +
          "is unreachable. Keep one entry per call.",
      });
      continue;
    }
    seenCalls.add(reply.call);
    const latencyReason = describeLatencyDefect(reply.afterMs);
    if (latencyReason !== undefined) {
      defects.push({ scenarioId: scenario.id, subject, reason: latencyReason });
    }
  }
  return defects;
}

/**
 * A scripted latency the frozen clock cannot spend, or `undefined` when it can.
 *
 * Admitted: absent, and every finite value at or above zero (zero settles as an absent `afterMs`
 * does). The split follows the engine's own test: `daemon/scripted/reply.fixture.ts` spends a
 * latency only when `afterMs !== undefined && afterMs > 0`, and `held-reply-queue.fixture.ts`
 * releases a reply parked at `elapsedMs + afterMs` when an advance reaches its due time. `Infinity`
 * passes the test and parks at a tick no finite advance reaches, so the view awaiting it loads
 * until teardown. `NaN`, negatives and `-Infinity` fail `afterMs > 0`, so the reply is never parked
 * and the loading state is never observable. No other leg reports either, since a reply carries no
 * event and meets no schema.
 */
function describeLatencyDefect(afterMs: number | undefined): string | undefined {
  if (afterMs === undefined || (Number.isFinite(afterMs) && afterMs >= 0)) {
    return undefined;
  }
  // Only `Infinity` reaches here with `afterMs > 0`; the rest fail the engine's own test.
  if (afterMs > 0) {
    return (
      "it scripts a latency of Infinity ms. The engine parks a delayed reply until the " +
      "frozen clock reaches the tick it was made at plus that many milliseconds, and no " +
      "finite advance reaches this one — so the reply is released only by teardown, as an " +
      "abandoned one, and the view awaiting it renders its loading state for the life " +
      "of the window. Script the milliseconds this call should take."
    );
  }
  return (
    `it scripts a latency of ${String(afterMs)} ms. The fixture parks a reply only for a ` +
    "latency above zero, so this one is never parked: it settles on the calling turn, and " +
    "the loading state the latency exists to make reachable is never observable. Script a " +
    "finite number of milliseconds — 0 is the honest way to script no latency at all."
  );
}
