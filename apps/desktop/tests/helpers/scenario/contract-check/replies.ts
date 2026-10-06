// One scripted answer per call, one call the app registers, one spendable latency, and a scripted
// value of the registered shape.
//
// All four claims are about a `ScenarioReply`: the entry can be reached, the call it answers
// exists, the delay it scripts can be spent, and a value it scripts outright parses against the
// method's response schema. A scenario failing any of them has a reply no transport would give,
// and it shows up only as a view that never leaves its loading state or one trained on a frame
// the daemon cannot send. A computed answer exists only once a request is in hand, so the fixture
// daemon holds it to the same schema when it settles.
//
// The call claim catches an invented wire. A reply is keyed on a method string, which is as easy
// to make up as to transcribe: a scenario answering `workflow.runsList` renders a view that looks
// served, and every tier that mounts it passes against a call the daemon does not have. The
// registry is the daemon call set the app binds, so nothing here is a second list.

import {
  daemonMethodBindingFor,
  REGISTERED_DAEMON_METHODS,
} from "#shared/daemon/method-bindings.js";
import type { ScenarioReply } from "#renderer/services/daemon/scenario/reply.fixture.js";
import type { ScenarioContractDefect } from "./defect.js";
import type { Scenario } from "#fixtures/scenario.js";

/**
 * Every reply defect in one scenario: unreachable entries, unregistered calls, unspendable
 * latencies, scripted values off their method's contract.
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
    const callReason = describeCallDefect(reply.call);
    if (callReason !== undefined) {
      defects.push({ scenarioId: scenario.id, subject, reason: callReason });
    }
    const latencyReason = describeLatencyDefect(reply.afterMs);
    if (latencyReason !== undefined) {
      defects.push({ scenarioId: scenario.id, subject, reason: latencyReason });
    }
    const resultReason = describeResultDefect(reply);
    if (resultReason !== undefined) {
      defects.push({ scenarioId: scenario.id, subject, reason: resultReason });
    }
  }
  return defects;
}

/**
 * A scripted value its method's response schema refuses, or `undefined` when it parses, the reply
 * computes or refuses instead, or the call is unregistered (reported by its own check).
 */
function describeResultDefect(reply: ScenarioReply): string | undefined {
  const binding = daemonMethodBindingFor(reply.call);
  if (binding === undefined || reply.refusal !== undefined || reply.resultFor !== undefined) {
    return undefined;
  }
  const parsed = binding.responseSchema.safeParse(reply.result);
  if (parsed.success) {
    return undefined;
  }
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return (
    `it scripts a value the registered response for "${reply.call}" refuses (${issues}). ` +
    "Served, it would fail the call at runtime or teach a view a frame the daemon cannot " +
    "send. Script the registered shape."
  );
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

/**
 * A call the app registers nowhere, or `undefined` when it registers one. The registry is read,
 * so a method added to the app's call set is scriptable the same day.
 */
function describeCallDefect(call: string): string | undefined {
  if ((REGISTERED_DAEMON_METHODS as readonly string[]).includes(call)) {
    return undefined;
  }
  return (
    `it answers "${call}", which the app registers nowhere — not as a daemon method ` +
    "the app binds a request and response shape for. A scenario answering an " +
    "invented name renders a view that looks served and reaches nothing once the app runs " +
    "against the real daemon. Script the registered method."
  );
}
