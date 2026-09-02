// One scripted answer per call, and one spendable latency on that answer.
//
// Both claims are about a `ScenarioReply` and nothing else, which is why they share
// a walk: the first says the entry can be REACHED, the second says the delay it
// scripts can be SPENT. A scenario failing either has a reply the fixture answers
// with in a way no transport does, and neither shows up as anything but a surface
// that never leaves its loading state.

import type { ScenarioWireTruthDefect } from "./defect.js";
import type { ConsoleScenario } from "../../scenario.js";

/**
 * Every reply defect in one scenario: unreachable entries, unspendable latencies.
 *
 * A duplicate entry is reported and then skipped rather than also measured for its
 * latency: `replyFor` answers with the first match, so a second entry for one call
 * is never reached at all and its `afterMs` is a property of a reply that cannot be
 * served. One defect per entry, naming the thing that has to change.
 */
export function findReplyDefects(scenario: ConsoleScenario): readonly ScenarioWireTruthDefect[] {
  const seenCalls = new Set<string>();
  const defects: ScenarioWireTruthDefect[] = [];
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
 * ADMITTED: absent, and every finite value at or above zero. Zero is not a defect —
 * it is the honest way to script no latency at all, and it settles exactly as an
 * absent `afterMs` does.
 *
 * REFUSED: the three shapes that reach the engine and come back out as something no
 * transport produces. What each one does is read off the two modules that handle it
 * rather than guessed: `scripted-reply.ts` spends a latency only when
 * `afterMs !== undefined && afterMs > 0`, and `scenario-engine.ts`'s held-reply queue
 * parks the reply at `elapsedMs + afterMs` and releases it when an advance reaches
 * `dueAtMs <= elapsedMs`.
 *
 * So the split is exactly the engine's own test. `Infinity` passes `afterMs > 0` and
 * parks at a tick no finite advance reaches, so the reply is released only by
 * teardown — as an abandoned one — and the surface awaiting it renders its loading
 * state for the life of the window. `NaN`, a negative number, and `-Infinity` all
 * FAIL `afterMs > 0`, so the reply is never parked: it settles on the calling turn,
 * and the loading state the latency exists to make reachable is never observable.
 * Neither is reported by any other leg, because a reply carries no event and meets
 * no schema.
 */
function describeLatencyDefect(afterMs: number | undefined): string | undefined {
  if (afterMs === undefined || (Number.isFinite(afterMs) && afterMs >= 0)) {
    return undefined;
  }
  // True for `Infinity` and for nothing else that reaches here: `NaN`, a negative
  // number, and `-Infinity` are the values the engine's own `> 0` test rejects.
  if (afterMs > 0) {
    return (
      "it scripts a latency of Infinity ms. The engine parks a delayed reply until the " +
      "frozen clock reaches the tick it was made at plus that many milliseconds, and no " +
      "finite advance reaches this one — so the reply is released only by teardown, as an " +
      "abandoned one, and the surface awaiting it renders its loading state for the life " +
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
