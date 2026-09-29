// One scripted reply, settled on the frozen clock: the seam the fixture's call door
// answers request/response calls through.
//
// `scenario.ts` deliberately stops short of naming a refusal: its `holdReply` reports
// `due | abandoned | backlog-full` and says that "naming the refusal belongs to the
// bridge". This module is the parking-and-classifying half — look up the canned reply,
// park it on the frozen clock when it scripts a latency, and decide which of the four
// things happened — and it reports a settlement rather than throwing, so `resolveScriptedReply`
// below decides what each arm rejects with.
//
// A COMPUTED REPLY IS SETTLED HERE TOO, and for the same reason the classification
// is: `replyFor` matches on the method name and the REQUEST reaches only this seam,
// so a scenario that answers an entity-scoped read per entity has exactly one place
// to be read.
//
// The codes a reply that never arrived refuses with are declared here, once, and the
// fixture's refusal set spreads them in. They describe one fact — the scenario engine
// had nothing to answer with — and the DETAIL sentence travels on the settlement for
// the same reason: the diagnosis and the remedy are properties of what the engine did.

import type { ScenarioRefusalEnvelope } from "./scenario-reply.fixture.js";
import { daemonMethodBindingFor } from "./daemon-reply-registry.js";
import type { ScenarioEngine } from "./engine.fixture.js";
import { FixtureBridgeError, type ScriptedReplyRefusalCode } from "./refusal.fixture.js";

/**
 * What happened when the fixture went looking for one call's canned reply.
 *
 * Four arms, because four different things can happen and three of them are not a
 * value: the scenario scripts nothing, the scenario scripts a daemon refusal, or the
 * reply was parked on the frozen clock and never came due. Collapsing any of them
 * into `undefined` is what a fixture must not do — an absent value renders as an
 * empty state, and none of these is one.
 */
export type ScriptedReplySettlement =
  | { readonly status: "unscripted" }
  | { readonly status: "resolved"; readonly value: unknown }
  | { readonly status: "refused"; readonly refusal: ScenarioRefusalEnvelope }
  | {
      readonly status: "unanswered";
      readonly code: ScriptedReplyRefusalCode;
      /** The sentence a person acts on. Composed once, where the engine's state is known. */
      readonly detail: string;
    };

/**
 * Look up one call's scripted reply and settle it on the frozen clock.
 *
 * `request` is what the caller sent, and it is what a `ScenarioComputedReply` reads to
 * answer an entity-scoped call per entity.
 *
 * Never rejects, on any arm. A scripted daemon refusal travels back as a value here
 * and is thrown by the caller, which is what keeps the wire's own `{code, message}`
 * envelope unwrapped rather than paraphrased by a fixture-scoped error.
 *
 * A scripted latency is spent by PARKING the reply, never by advancing the clock
 * here. The frozen clock is the fixture's only clock and the caller is the only thing
 * that moves it; spending the delay inside this call would settle the promise on the
 * calling turn, so the loading state the latency exists to make reachable would never
 * be observable, and every beat inside the delay would be delivered as a side effect
 * of a read.
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
  // Read AFTER the hold, so a scripted refusal is preceded by exactly the loading
  // window a resolving reply of the same `afterMs` would have had — and so a computed
  // reply is asked about the request in the same position a constant one is read from,
  // rather than earlier, which would spend the latency on an answer already chosen.
  if (reply.refusal !== undefined) {
    return { status: "refused", refusal: reply.refusal };
  }
  if (reply.resultFor !== undefined) {
    // The instant is read HERE rather than at the call, and after the hold rather
    // than before it: a computed reply that answers about a lifetime has to be
    // asked at the moment its answer is delivered, so a reply parked on a scripted
    // latency answers for the tick it comes due at and not the tick it was asked at.
    // The engine's own clock, so the reply and the beats share a single ordering.
    //
    // The ordinal is taken in the same breath, and it counts ASKINGS of this call's
    // computed reply rather than answers to it: a reply that answers `undefined` for
    // the entity it was asked about has still been asked, and a count that stepped
    // back over it would hand a later mint an identity an earlier one could have had.
    const computed = reply.resultFor(
      request,
      engine.clock.now(),
      engine.nextComputedReplyOrdinal(call),
    );
    // A request the scenario does not answer for is `unscripted` and not an empty
    // resolution: the scenario scripts the METHOD and not this entity, which is the
    // authoring gap that arm exists to name.
    return computed === undefined
      ? { status: "unscripted" }
      : { status: "resolved", value: computed };
  }
  return { status: "resolved", value: reply.result };
}

/** The diagnosis and the remedy for a reply the frozen clock never released. */
/**
 * Answer one request/response call from the scenario, or reject by name.
 *
 * The classification is `settleScriptedReply`'s; this is the arm that turns each
 * settlement into what a `PlatformBridge` method may do, which is resolve or reject
 * and nothing else. Three of the four settlements are rejections here, and each
 * rejects with a different value on purpose: an unscripted call is a fixture
 * AUTHORING error, a reply the clock never released is a fixture failure carrying the
 * shared code, and a scripted daemon refusal is thrown VERBATIM and unwrapped.
 *
 * The REQUEST travels through rather than being dropped, on both sides of the bridge.
 * A scenario answering an entity-scoped call — `repo.mountRead` names the mount it
 * wants — has to see which entity was asked for, and a seam that forwarded the daemon
 * request while dropping the control-plane one would be the same defect waiting on
 * the other half.
 *
 * That last one is the whole point of the refusal arm: it is the daemon's refusal,
 * not the fixture's, and `src/shared/wire-errors.ts` records that a wire refusal
 * reaches a renderer either as this plain object or as an `Error` carrying the same
 * `code` — `normalizeWireRejection` renders both as `code: message`. Wrapping it in a
 * `FixtureBridgeError` would replace the code a surface exists to show with a
 * fixture-scoped one and make the rendered refusal a thing the live bridge never
 * produces.
 *
 * A RESOLVED REPLY IS HANDED BACK exactly as the scenario scripts it.
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
        `scenario "${engine.scenario.id}" scripts no reply. Add one to the scenario rather than letting the surface render an empty result for a call that would have failed.`,
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
 * THE SAME REGISTRY THE CONSOLE READS THROUGH. `daemon-reply.ts` parses every live
 * reply against `daemon-reply-registry.ts`; this reads the same table, so a scenario
 * that scripts a reply the wire could not send fails in the scenario's own tests
 * rather than in whichever surface renders it — the `scenario-wire-truth` posture,
 * moved onto the call door. Two tables would let the fixture teach a shape the
 * console then refuses, with both halves green.
 *
 * ASSERTS, AND DOES NOT SUBSTITUTE. The ORIGINAL value travels on, never the parsed
 * one: a fixture is a stand-in for the wire, and a wire delivers what it delivers.
 * Handing back the validator's output would let a scenario lean on a coercion or a
 * default and look correct against a live daemon that supplies neither.
 *
 * A method the registry does not bind passes through untouched, which is the honest
 * answer rather than a lax one: the corpus registers no shape for it, so there is
 * nothing to check against.
 * This is also why the check lives on the daemon arm alone — a control-plane
 * procedure is not a daemon method and the registry does not describe one.
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
      "the scenario scripts a reply this build does not register for that method. Script the registered shape rather than teaching a surface a frame the daemon cannot send.",
    );
  }
  return value;
}

function unansweredReplyDetail(
  engine: ScenarioEngine,
  outcome: "abandoned" | "backlog-full",
): string {
  return outcome === "abandoned"
    ? "the scenario engine was torn down before the frozen clock reached this reply. Advance the engine before disposing it, or drive this surface from a scenario that scripts no latency for the call."
    : `the fixture is already holding ${String(engine.pendingReplyCount)} delayed replies and takes no more. Advance the frozen clock to release them; a backlog this size means something is issuing requests without ever moving the scenario forward.`;
}
