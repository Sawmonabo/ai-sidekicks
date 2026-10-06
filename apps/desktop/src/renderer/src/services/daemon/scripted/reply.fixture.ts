// One scripted reply, settled on the frozen clock: the seam the fixture bridge's `call` answers
// request/response calls through. The engine's `holdReply` reports `due | abandoned |
// backlog-full` and leaves naming the refusal to the bridge; this module looks up the canned reply,
// parks it on the frozen clock when it scripts a latency, classifies the outcome, and reports a
// settlement rather than throwing. A computed reply is settled here too, since the request reaches
// only this seam, and so is what a resolved answer leaves behind: the request it answered, which
// a later computed read may reflect, and the notices it pushes. The detail sentence travels on the
// settlement because the diagnosis and remedy are properties of what the engine did.

import { MCP_EVENT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/mcp/event";
import { PROVIDER_ACCOUNT_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/provider/account/methods";
import { SESSION_DIRECTORY_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/session/directory";
import { WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/workflow/run/records";
import type { ZodType } from "@ai-sidekicks/contracts/jsonrpc/registry";

import { daemonMethodBindingFor } from "#shared/daemon/method-bindings.js";
import { parseInstant } from "#renderer/lib/instant.js";
import type {
  RequestStampReader,
  ScenarioNotice,
  ScenarioRefusalEnvelope,
} from "../scenario/reply.fixture.js";
import type { DeliveredNotice, ScenarioEngine } from "../engine.fixture.js";
import { FixtureBridgeError, type ScriptedReplyRefusalCode } from "../refusal.fixture.js";
import type { MachineNoticeStreamName } from "../session/event/streams.js";
import {
  MCP_NOTICE_STREAM,
  PROVIDER_ACCOUNT_NOTICE_STREAM,
  SESSION_LIST_STREAM,
  WORKFLOW_NOTICE_STREAM,
} from "#shared/daemon/streams.js";

/** The shape each machine stream registers for what it pushes, from its contract descriptor. */
const MACHINE_NOTICE_EMISSION_SCHEMAS: Readonly<Record<MachineNoticeStreamName, ZodType<unknown>>> =
  Object.freeze({
    [MCP_NOTICE_STREAM]: MCP_EVENT_METHOD_DESCRIPTORS[MCP_NOTICE_STREAM].emissionSchema,
    [PROVIDER_ACCOUNT_NOTICE_STREAM]:
      PROVIDER_ACCOUNT_METHOD_DESCRIPTORS[PROVIDER_ACCOUNT_NOTICE_STREAM].emissionSchema,
    [WORKFLOW_NOTICE_STREAM]:
      WORKFLOW_RUN_RECORD_METHOD_DESCRIPTORS[WORKFLOW_NOTICE_STREAM].emissionSchema,
    [SESSION_LIST_STREAM]: SESSION_DIRECTORY_METHOD_DESCRIPTORS[SESSION_LIST_STREAM].emissionSchema,
  });

/**
 * The shape each machine stream's opening frame registers: its first emission, except
 * `session.list`, whose list as it stands is its acknowledgment.
 */
const MACHINE_NOTICE_OPENING_SCHEMAS: Readonly<Record<MachineNoticeStreamName, ZodType<unknown>>> =
  Object.freeze({
    ...MACHINE_NOTICE_EMISSION_SCHEMAS,
    [SESSION_LIST_STREAM]: SESSION_DIRECTORY_METHOD_DESCRIPTORS[SESSION_LIST_STREAM].responseSchema,
  });

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
 * A scripted daemon refusal travels back as a value and the caller throws it, keeping the wire's
 * `{code, message}` envelope unwrapped. It rejects when a resolved answer pushes a notice past the
 * backlog cap, or one due at once that is off its stream's contract. A scripted
 * latency is spent by parking the reply, never by advancing the clock here, or the loading state
 * would not be observable and beats inside the delay would be delivered as a side effect of a read.
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
  let value: unknown = reply.result;
  if (reply.resultFor !== undefined) {
    // The instant is read after the hold, so a parked reply answers for the tick it comes due at,
    // on the engine's clock. The ordinal counts askings, not answers: a reply that answered
    // `undefined` has still been asked, and skipping it could reuse an identity.
    value = reply.resultFor(
      request,
      engine.clock.now(),
      engine.nextComputedReplyOrdinal(call),
      (...answeredCalls) => engine.answeredRequests(...answeredCalls),
      requestStampReaderFor(call),
    );
    // A request the scenario does not answer is `unscripted`, not an empty resolution: it
    // scripts the method and not this entity.
    if (value === undefined) {
      return { status: "unscripted" };
    }
  }
  // Only a write is recorded: a later read reflects writes, and recording every read would grow
  // the record for the life of the window.
  if (daemonMethodBindingFor(call)?.mutating === true) {
    engine.recordAnsweredRequest(call, request);
  }
  for (const notice of reply.noticesFor?.(request, value) ?? []) {
    pushScriptedNotice(engine, call, notice);
  }
  return { status: "resolved", value };
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
        `scenario "${engine.scenario.id}" scripts no reply. Add one to the scenario rather ` +
          `than letting the view render an empty result for a call that would have failed.`,
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
 * Reads the same `#shared/daemon/method-bindings.ts` table `services/daemon/reply.ts` parses live
 * replies against, so an impossible reply fails in the scenario's own tests and two tables cannot
 * disagree. It asserts and does not substitute: the original value travels on, so a scenario cannot
 * lean on a coercion or default a live daemon lacks. A method the registry does not bind passes
 * through.
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
      "the scenario scripts a reply this build does not register for that method. Script " +
        "the registered shape rather than teaching a view a frame the daemon cannot send.",
    );
  }
  return value;
}

/**
 * Hold the frame a machine stream opens with to its registered opening shape, naming the stream
 * when it is off contract. The original payload travels on.
 */
export function assertOpeningOnContract(
  stream: MachineNoticeStreamName,
  payload: unknown,
): unknown {
  return assertOnContract(MACHINE_NOTICE_OPENING_SCHEMAS, stream, stream, payload);
}

/**
 * Read the stamps one call's requests carry. The screens send UTC stamps, so any other spelling is
 * a fixture fault, refused off contract.
 */
export function requestStampReaderFor(call: string): RequestStampReader {
  return (stamp) => {
    const instant = parseInstant(stamp, "utc-only");
    if (instant.kind === "malformed") {
      throw new FixtureBridgeError(
        call,
        "reply-off-contract",
        `the scenario reads only UTC stamps, not ${JSON.stringify(stamp)}.`,
      );
    }
    return instant.epochMilliseconds;
  };
}

/**
 * Hold one machine notice to its stream's registered emission shape, naming `source` (the call
 * that pushed it) when it is off contract. It asserts and does not substitute: the original
 * payload travels on.
 */
function assertNoticeOnContract(
  source: string,
  stream: MachineNoticeStreamName,
  payload: unknown,
): unknown {
  return assertOnContract(MACHINE_NOTICE_EMISSION_SCHEMAS, source, stream, payload);
}

function assertOnContract(
  schemas: Readonly<Record<MachineNoticeStreamName, ZodType<unknown>>>,
  source: string,
  stream: MachineNoticeStreamName,
  payload: unknown,
): unknown {
  if (!schemas[stream].safeParse(payload).success) {
    throw new FixtureBridgeError(
      source,
      "reply-off-contract",
      `the scenario pushes a ${stream} notice this build does ` +
        `not register for that stream. Script the registered shape ` +
        `rather than teaching a view a frame the daemon cannot send.`,
    );
  }
  return payload;
}

/**
 * Schedule one notice a resolved answer pushes. Its payload is composed when it comes due and
 * held to its stream's registered emission shape then, so a drifted notice fails whoever moved
 * the clock rather than reaching a subscriber that would read it as nothing.
 */
function pushScriptedNotice(engine: ScenarioEngine, call: string, notice: ScenarioNotice): void {
  const composeAtDelivery = (): DeliveredNotice | undefined => {
    const payload = notice.payloadAtDelivery(
      (...answeredCalls) => engine.answeredRequests(...answeredCalls),
      requestStampReaderFor(call),
    );
    if (payload === undefined) {
      return undefined;
    }
    return { stream: notice.stream, payload: assertNoticeOnContract(call, notice.stream, payload) };
  };
  if (!engine.scheduleNotice(notice.afterMs, composeAtDelivery)) {
    throw new FixtureBridgeError(
      call,
      "reply-backlog-full",
      "the fixture is already holding as many delayed notices " +
        "as it takes. Advance the frozen clock to release them.",
    );
  }
}

function unansweredReplyDetail(
  engine: ScenarioEngine,
  outcome: "abandoned" | "backlog-full",
): string {
  return outcome === "abandoned"
    ? "the scenario engine was torn down before the frozen clock reached " +
        "this reply. Advance the engine before disposing it, or drive this " +
        "view from a scenario that scripts no latency for the call."
    : `the fixture is already holding ${String(engine.pendingReplyCount)} delayed replies ` +
        `and takes no more. Advance the frozen clock to release them; a backlog this size ` +
        `means something is issuing requests without ever moving the scenario forward.`;
}
