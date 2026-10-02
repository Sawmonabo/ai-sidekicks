// One scripted reply, settled on the frozen clock: the seam the fixture bridge's `call` answers
// request/response calls through. The engine's `holdReply` reports `due | abandoned |
// backlog-full` and leaves naming the refusal to the bridge; this module looks up the canned reply,
// parks it on the frozen clock when it scripts a latency, classifies the outcome, and reports a
// settlement rather than throwing. A computed reply is settled here too, since the request reaches
// only this seam. The detail sentence travels on the settlement because the diagnosis and remedy
// are properties of what the engine did.

import type { ScenarioRefusalEnvelope } from "./scenario-reply.fixture.js";
import { daemonMethodBindingFor } from "./daemon-reply-registry.js";
import type { ScenarioEngine } from "./engine.fixture.js";
import { FixtureBridgeError, type ScriptedReplyRefusalCode } from "./refusal.fixture.js";

/**
 * What happened when the fixture went looking for one call's canned reply: a value, nothing
 * scripted, a scripted daemon refusal, or a reply parked on the frozen clock that never came due.
 * None but the first may collapse to `undefined`, which renders as an empty state.
 */
export type ScriptedReplySettlement =
  | { readonly status: "unscripted" }
  | { readonly status: "resolved"; readonly value: unknown }
  | { readonly status: "refused"; readonly refusal: ScenarioRefusalEnvelope }
  | {
      readonly status: "unanswered";
      readonly code: ScriptedReplyRefusalCode;
      /** The sentence a person acts on, composed where the engine's state is known. */
      readonly detail: string;
    };

/**
 * Look up one call's scripted reply and settle it on the frozen clock. `request` is what a
 * `ScenarioComputedReply` reads to answer per entity.
 *
 * Never rejects: a scripted daemon refusal travels back as a value and the caller throws it,
 * keeping the wire's `{code, message}` envelope unwrapped. A scripted latency is spent by parking
 * the reply, never by advancing the clock here, or the loading state would not be observable and
 * beats inside the delay would be delivered as a side effect of a read.
 */
export async function settleScriptedReply(
  engine: ScenarioEngine,
  call: string,
  request: unknown,
): Promise<ScriptedReplySettlement> {
  const reply = engine.replyFor(call);
  if (reply === undefined) {
    return { status: "unscripted" };
  }
  if (reply.afterMs !== undefined && reply.afterMs > 0) {
    const outcome = await engine.holdReply(reply.afterMs);
    if (outcome !== "due") {
      return {
        status: "unanswered",
        code: outcome === "abandoned" ? "reply-abandoned" : "reply-backlog-full",
        detail: unansweredReplyDetail(engine, outcome),
      };
    }
  }
  // Read after the hold, so a refusal has the same loading window a resolving reply of the same
  // `afterMs` has, and a computed reply is asked at the same point a constant one is read.
  if (reply.refusal !== undefined) {
    return { status: "refused", refusal: reply.refusal };
  }
  if (reply.resultFor !== undefined) {
    // The instant is read after the hold, so a parked reply answers for the tick it comes due at,
    // on the engine's clock. The ordinal counts askings, not answers: a reply that answered
    // `undefined` has still been asked, and skipping it could reuse an identity.
    const computed = reply.resultFor(
      request,
      engine.clock.now(),
      engine.nextComputedReplyOrdinal(call),
    );
    // A request the scenario does not answer is `unscripted`, not an empty resolution: it
    // scripts the method and not this entity.
    return computed === undefined
      ? { status: "unscripted" }
      : { status: "resolved", value: computed };
  }
  return { status: "resolved", value: reply.result };
}

/**
 * Answer one request/response call from the scenario, or reject by name.
 *
 * Turns each settlement into a resolve or a reject, as a `PlatformBridge` method may do only
 * those. An unscripted call is a fixture authoring error and an unreleased reply a fixture
 * failure, both `FixtureBridgeError`s. A scripted daemon refusal is thrown verbatim and unwrapped,
 * since a wire refusal reaches a renderer as this plain object or an `Error` with the same
 * `code`, and wrapping it would replace the code the refusal card shows. The request travels
 * through so a scenario can see which entity an entity-scoped call named. A resolved reply is
 * returned exactly as scripted.
 */
export async function resolveScriptedReply(
  engine: ScenarioEngine,
  call: string,
  request: unknown,
): Promise<unknown> {
  const settlement = await settleScriptedReply(engine, call, request);
  switch (settlement.status) {
    case "unscripted":
      throw new FixtureBridgeError(
        call,
        "reply-unscripted",
        `scenario "${engine.scenario.id}" scripts no reply. Add one to the scenario rather than letting the view render an empty result for a call that would have failed.`,
      );
    case "unanswered":
      throw new FixtureBridgeError(call, settlement.code, settlement.detail);
    case "refused":
      throw settlement.refusal;
    case "resolved":
      return settlement.value;
  }
}

/**
 * Hold one resolved scripted reply to the shape the corpus registers for its method.
 *
 * Reads the same `daemon-reply-registry.ts` table `daemon-reply.ts` parses live replies against,
 * so an impossible reply fails in the scenario's own tests and two tables cannot disagree. It
 * asserts and does not substitute: the original value travels on, so a scenario cannot lean on a
 * coercion or default a live daemon lacks. A method the registry does not bind passes through.
 */
export function assertScriptedReplyOnContract(method: string, value: unknown): unknown {
  const binding = daemonMethodBindingFor(method);
  if (binding === undefined) {
    return value;
  }
  const parsed = binding.responseSchema.safeParse(value);
  if (!parsed.success) {
    throw new FixtureBridgeError(
      method,
      "reply-off-contract",
      "the scenario scripts a reply this build does not register for that method. Script the registered shape rather than teaching a view a frame the daemon cannot send.",
    );
  }
  return value;
}

function unansweredReplyDetail(
  engine: ScenarioEngine,
  outcome: "abandoned" | "backlog-full",
): string {
  return outcome === "abandoned"
    ? "the scenario engine was torn down before the frozen clock reached this reply. Advance the engine before disposing it, or drive this view from a scenario that scripts no latency for the call."
    : `the fixture is already holding ${String(engine.pendingReplyCount)} delayed replies and takes no more. Advance the frozen clock to release them; a backlog this size means something is issuing requests without ever moving the scenario forward.`;
}
