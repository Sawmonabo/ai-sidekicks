// One scripted answer per call, one call the corpus registers, and one spendable
// latency on that answer.
//
// All three claims are about a `ScenarioReply` and nothing else, which is why they
// share a walk: the first says the entry can be REACHED, the second says the call it
// answers EXISTS, and the third says the delay it scripts can be SPENT. A scenario
// failing any of them has a reply the fixture answers with in a way no transport
// does, and none shows up as anything but a surface that never leaves its loading
// state.
//
// THE CALL CLAIM IS THE ONE THAT CATCHES AN INVENTED WIRE. A scripted reply is
// keyed on a method STRING, and a string is exactly as easy to make up as to
// transcribe: a scenario answering `workflow.runList` renders a surface that looks
// served, ships a reference image of it, and reaches the daemon on the day the
// fixture define flips to find that nothing by that name was ever registered. The
// two registries are the corpus's own — the daemon call set the console binds and
// the growth slate's expected wire methods — so nothing here is a second list.
//
// AND THE REACHABILITY CLAIM HAS A SECOND HALF. A call the corpus registers can
// still be answered by nothing: the growth port refuses an operation outside
// `FIXTURE_SERVED_GROWTH_OPERATION_IDS` WITHOUT consulting the script, so a scenario
// scripting one writes a reply no caller can reach. Four scenarios shipped an
// `agent.list` roster in exactly that state, and the composer's target chip rendered
// its refusal on every provider-bound surface while the script sat unread. The
// served set is imported rather than restated, so the two cannot disagree.

import { CONSOLE_DAEMON_METHODS } from "../../daemon/index.js";
import { FIXTURE_SERVED_GROWTH_OPERATION_IDS } from "../../fixture/fixture-served-operations.js";
import { GROWTH_OPERATIONS } from "../../growth-operations/index.js";
import type { GrowthOperationId } from "../../growth-port/growth-entry.js";
import type { ScenarioWireTruthDefect } from "./defect.js";
import type { ConsoleScenario } from "../../scenario-runtime/scenario.js";

/**
 * How a growth row with no registered wire method is keyed by a scripted reply.
 *
 * The one admitted shape that is manifestly not a method string, and it exists
 * because a growth operation whose wire the corpus has NOT registered has no name to
 * transcribe: the slate row is the whole of what is known about it. Keying its
 * reply on the operation id is honest about that, and the prefix is what keeps the
 * two vocabularies from colliding — a caller cannot accidentally spell a method this
 * way, and a reader cannot mistake one for the other.
 *
 * Deliberately NOT admitted for a growth row that DOES declare an expected wire
 * method: that row has a registered name, and answering it under an operation id
 * would script the fixture against a key the live transport never sends.
 */
const GROWTH_REPLY_PREFIX = "growth:";

/**
 * Wire names the CORPUS registers that this console binds no DAEMON shape for.
 *
 * A hand-written list, which is what everything else in this tier exists to avoid,
 * and it is one here because there is nothing to derive it from: `packages/contracts`
 * publishes `METHOD_NAME_FORMAT` and no enumerable method union, so the only complete
 * record of a registered wire is a table in
 * `docs/architecture/contracts/api-payload-contracts.md`, which no renderer module can
 * read. The list is therefore a transcription, and it is kept honest by being tiny and
 * by each entry naming why it is not in the binding table instead.
 *
 * TWO CLASSES BELONG HERE, and only the first is transient. A daemon method the corpus
 * registers and no console surface calls yet is exactly the state that keeps it out of
 * `ConsoleDaemonMethodContract`, whose admission rule is a surface that calls it — a
 * scenario may script such a call ahead of its surface, and that entry moves to a
 * binding row on the day a surface calls it, because a bound method is validated in
 * both directions and one listed here is served unchecked. A CONTROL-PLANE PROCEDURE
 * belongs here permanently: that registry enumerates daemon methods, the fixture's own
 * contract assertion runs on the daemon arm alone for the same reason, and no surface
 * calling one can ever move it across. What neither class admits is an invented name,
 * and that difference is the whole of this claim.
 */
const CORPUS_METHODS_THE_CONSOLE_DOES_NOT_BIND: readonly string[] = [
  // The registered runtime-node attach mutation, reached over the CONTROL-PLANE arm by
  // the absorbed attach flow the settings nodes page mounts
  // (`runtime-node-attach/attach-request.ts` names it, and owns it as the one home for
  // the string). Dual-transport in the corpus and control-plane-only in this renderer,
  // so it is a procedure rather than a daemon method and the binding table — which is
  // the daemon's — could not hold it whatever calls it.
  "runtimenode.attach",
];

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
    const callReason = describeCallDefect(reply.call);
    if (callReason !== undefined) {
      defects.push({ scenarioId: scenario.id, subject, reason: callReason });
    }
    const servedReason = describeUnservedGrowthDefect(reply.call);
    if (servedReason !== undefined) {
      defects.push({ scenarioId: scenario.id, subject, reason: servedReason });
    }
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

/**
 * A call the corpus registers nowhere, or `undefined` when it registers one.
 *
 * ADMITTED, in the order a reader would check them: a registered daemon method; a
 * growth operation's declared expected wire method; and `growth:<operationId>` for a
 * growth row that declares none.
 *
 * The registries are read rather than restated. `CONSOLE_DAEMON_METHODS` is the keys
 * of the frozen binding table, so a method added to the console's call set is
 * scriptable the same day; `GROWTH_OPERATIONS` is the slate itself. Only the
 * corpus-registered-but-unbound list above is written by hand, for the reason stated
 * there.
 */
function describeCallDefect(call: string): string | undefined {
  if (
    (CONSOLE_DAEMON_METHODS as readonly string[]).includes(call) ||
    CORPUS_METHODS_THE_CONSOLE_DOES_NOT_BIND.includes(call)
  ) {
    return undefined;
  }
  if (call.startsWith(GROWTH_REPLY_PREFIX)) {
    return describeGrowthKeyDefect(call.slice(GROWTH_REPLY_PREFIX.length));
  }
  if (growthOperationKeyedBy(call) !== undefined) {
    return undefined;
  }
  return (
    `it answers "${call}", which the corpus registers nowhere — neither as a daemon ` +
    "method the console binds a request and response shape for, nor as a growth " +
    "operation's expected wire method. A scenario answering an invented name renders a " +
    "surface that looks served and reaches nothing on the day the fixture define flips. " +
    "Script the registered method, or the growth row's own `growth:<operationId>` key."
  );
}

/** Whether an operation-id-keyed reply names a row entitled to be keyed that way. */
function describeGrowthKeyDefect(operationId: string): string | undefined {
  if (!Object.hasOwn(GROWTH_OPERATIONS, operationId)) {
    return (
      `it answers "${GROWTH_REPLY_PREFIX}${operationId}", and the growth slate registers no ` +
      "operation by that id. The prefix keys a reply on the operation rather than on a wire " +
      "name, so the id has to be one the slate carries."
    );
  }
  const { expectedWireMethod } = GROWTH_OPERATIONS[operationId as GrowthOperationId];
  if (expectedWireMethod === undefined) {
    return undefined;
  }
  return (
    `it answers "${GROWTH_REPLY_PREFIX}${operationId}", but that growth row declares the ` +
    `expected wire method "${expectedWireMethod}". A row with a registered name is scripted ` +
    "under that name, so the fixture answers the key the live transport would send."
  );
}

/**
 * A reply the growth port would refuse without ever reading, or `undefined`.
 *
 * The port is built as the refusing port with the served operations spread over it,
 * so an operation outside the served set answers `wire-unregistered` and the script
 * is never consulted. A scenario scripting one has written an answer nothing asks
 * for — and worse than dead weight, because the surface reading that operation
 * renders its refusal while the repo carries a reply that looks like coverage.
 *
 * A call the console BINDS is exempt: `fixture-bridge.ts` answers `daemon.call` from
 * the same script, so a method a surface reaches through `callDaemon` is reachable
 * whatever the port does with an operation of the same name.
 */
function describeUnservedGrowthDefect(call: string): string | undefined {
  if ((CONSOLE_DAEMON_METHODS as readonly string[]).includes(call)) {
    return undefined;
  }
  const operationId = growthOperationKeyedBy(call);
  if (
    operationId === undefined ||
    (FIXTURE_SERVED_GROWTH_OPERATION_IDS as readonly string[]).includes(operationId)
  ) {
    return undefined;
  }
  return (
    `it answers the growth operation "${operationId}", which the fixture port does not ` +
    "serve — it refuses that operation without consulting the script, so this reply is " +
    "reachable from nothing and the surface reading it renders a refusal. Serve the " +
    "operation from `fixture-growth-port.ts`, or drop the reply."
  );
}

/** Which growth operation a scripted call keys, under either of the two spellings. */
function growthOperationKeyedBy(call: string): GrowthOperationId | undefined {
  if (call.startsWith(GROWTH_REPLY_PREFIX)) {
    const operationId = call.slice(GROWTH_REPLY_PREFIX.length);
    return Object.hasOwn(GROWTH_OPERATIONS, operationId)
      ? (operationId as GrowthOperationId)
      : undefined;
  }
  return growthOperationIds().find((id) => GROWTH_OPERATIONS[id].expectedWireMethod === call);
}

/** The slate's operation ids, narrowed the way the record's annotation allows. */
function growthOperationIds(): readonly GrowthOperationId[] {
  return Object.keys(GROWTH_OPERATIONS) as GrowthOperationId[];
}
