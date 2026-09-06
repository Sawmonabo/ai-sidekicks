// What a fixture answers one request/response call with.
//
// The other door of the two a `SidekicksBridge` has, and its own module for the reason
// the subscription door is: a call is settled by `scripted-reply.ts`, held to
// `daemon-reply-registry.ts`, and turned into the one thing a bridge method may do —
// resolve or reject. The bridge beside this file composes both doors and is read by
// every console surface; neither door reads it.

import { daemonMethodBindingFor } from "./daemon-reply-registry.js";
import { FixtureBridgeError } from "./fixture-refusal.js";
import { ScenarioEngine } from "./scenario-engine.js";
import { settleScriptedReply } from "./scripted-reply.js";

/**
 * Answer one request/response call from the scenario, or reject by name.
 *
 * The classification is `scripted-reply.ts`'s — this is the arm that turns each
 * settlement into what a `SidekicksBridge` method may do, which is resolve or reject
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
 * nothing to check against. Those calls are the growth port's, and it types them.
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
