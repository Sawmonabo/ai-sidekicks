// The one place a daemon reply enters the console. Every call goes through `callDaemon`, so a
// reply is parsed against the shape registered for its method before a view can act on it, and a
// caller cannot hold an unparsed value. The request is parsed too, before it is sent.
//
// A caller gets a `DaemonReply`, `served` or `refused`, and nothing is thrown on an ordinary path:
// a rejected call, an unsendable request and an unreadable reply are all a refusal that carries the
// code verbatim.
//
// No refused value reaches a refusal's detail, because a rejected value can be a user's message, a
// path or a credential. This module composes its own sentence from the method and the failing
// member paths, and never renders the validator's message, which quotes received values.
//
// A rejection goes to `normalizeWireRejection` (`lib/wire-rejection.ts`), the console's only
// reading of a rejected promise. This module supplies the origin and the fallback sentence for a
// rejection with no machine-readable code; a private copy would misread a JSON-RPC rejection
// (whose numeric `code` hides the dotted code at `data.type`) and turn `session.not_found` into
// `call-rejected`.

import type { DaemonParams, DaemonResult } from "@ai-sidekicks/contracts";

import { normalizeWireRejection } from "@renderer/lib/wire-rejection.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { isReadAbandoned, settleUnlessAbandoned } from "@renderer/lib/reads/read-scope.js";
import type { PlatformBridge } from "../platform/platform-bridge.js";
import { DAEMON_METHOD_BINDINGS } from "./daemon-reply-registry.js";
import type { RegisteredDaemonMethod } from "./daemon-method-contract.js";
import { describeFailingPaths } from "./failing-member-paths.js";

/** The subsystem name every refusal this module raises carries. */
export const DAEMON_REPLY_REFUSAL_ORIGIN = "daemon-call";

/**
 * Why the console refused a call on its own side of the wire. None overlaps a daemon code: a
 * typed wire refusal keeps its own code verbatim.
 *
 *   • `request-unsendable`: the request does not satisfy the registered schema; nothing was sent.
 *   • `reply-unreadable`: the call fulfilled with a value that is not the registered shape.
 *   • `call-rejected`: the call rejected with nothing carrying a machine-readable code.
 *   • `read-abandoned`: the view that asked for this read is gone or a newer read replaced it;
 *     nothing is read from the reply. It is a refusal, not a silent resolution, so the call's
 *     answer stays total.
 */
export const DAEMON_REPLY_REFUSAL_CODES = [
  "request-unsendable",
  "reply-unreadable",
  "call-rejected",
  "read-abandoned",
] as const;

/** One console-side call refusal code, derived from `DAEMON_REPLY_REFUSAL_CODES`. */
export type DaemonReplyRefusalCode = (typeof DAEMON_REPLY_REFUSAL_CODES)[number];

/**
 * A parsed reply, or the refusal standing in its place. Never both, never neither.
 *
 * `status` is the discriminant rather than the presence of `value`, so a response
 * type that is legitimately `undefined`-shaped still narrows.
 */
export type DaemonReply<TValue> =
  | { readonly status: "served"; readonly value: TValue }
  | { readonly status: "refused"; readonly refusal: Refusal };

/**
 * How a caller says this call has an owner who may walk away from it. A mutation passes nothing:
 * a durable act that reached the daemon happened, so it is never abandoned. Passing `signal` is
 * the read-versus-mutation distinction at the call site.
 */
export interface DaemonCallOptions {
  /**
   * The read round's signal, aborted when a newer read superseded this one or the view that
   * asked for it is gone.
   */
  readonly signal?: AbortSignal;
}

/**
 * The refusal a read that nobody is waiting for settles as. It names the method and no value.
 * Exported for composed reads, which have `await` boundaries `callDaemon` cannot see and must
 * stop with this same refusal rather than a code of their own.
 */
export function abandonedReadRefusal(method: string): Refusal {
  return refuse(
    DAEMON_REPLY_REFUSAL_ORIGIN,
    "read-abandoned" satisfies DaemonReplyRefusalCode,
    `Nothing is waiting for the ${method} read any more, so the console read nothing from it.`,
  );
}

/**
 * Call one daemon method and answer with a parsed reply or a refusal; never throws. `method`
 * is a member of the closed call set, and `request` and the served value take their types from
 * the method map. `async` so a synchronous bridge throw becomes a rejection.
 *
 * An abandoned read is checked at four points and parsed at none: before the send, racing the
 * call, after the race and before the parse, and on the rejection arm. That saves the
 * `safeParse` and the caller's projection, the most expensive main-thread work for a large diff.
 * Abandonment cancels the console's interest and not the daemon's work: the wire has no
 * per-request cancellation, so the pending promise is dropped.
 */
export async function callDaemon<MethodName extends RegisteredDaemonMethod>(
  bridge: PlatformBridge,
  method: MethodName,
  request: DaemonParams<MethodName>,
  options: DaemonCallOptions = {},
): Promise<DaemonReply<DaemonResult<MethodName>>> {
  const binding = DAEMON_METHOD_BINDINGS[method];
  const { signal } = options;

  if (isReadAbandoned(signal)) {
    return abandonedRead(method);
  }

  const sendable = binding.requestSchema.safeParse(request);
  if (!sendable.success) {
    return {
      status: "refused",
      refusal: refuse(
        DAEMON_REPLY_REFUSAL_ORIGIN,
        "request-unsendable" satisfies DaemonReplyRefusalCode,
        `The console could not build a ${method} request the background service would accept${describeFailingPaths(sendable.error)}, so it sent none.`,
      ),
    };
  }

  let reply: unknown;
  try {
    const settlement = await settleUnlessAbandoned(
      bridge.daemon.call(method, sendable.data),
      signal,
    );
    if (settlement.status === "abandoned") {
      return abandonedRead(method);
    }
    reply = settlement.value;
  } catch (rejection: unknown) {
    if (isReadAbandoned(signal)) {
      // The read lost its owner and the call failed, in either order; the departure is the
      // fact that explains the settlement.
      return abandonedRead(method);
    }
    return {
      status: "refused",
      // The fallback applies only to a rejection with no code of its own, and never quotes the
      // rejected value, which can carry user content.
      refusal: normalizeWireRejection(DAEMON_REPLY_REFUSAL_ORIGIN, rejection, {
        code: "call-rejected" satisfies DaemonReplyRefusalCode,
        detail: `${method} was rejected.`,
      }),
    };
  }

  if (isReadAbandoned(signal)) {
    // `settleUnlessAbandoned` resolves the instant the reply does and retires its abort
    // listener, so an abort landing before this frame resumes says `settled` while nobody is
    // waiting. Reading the signal again, next to the parse, makes "an abandoned reply is never
    // parsed" independent of microtask order.
    return abandonedRead(method);
  }

  const readable = binding.responseSchema.safeParse(reply);
  if (!readable.success) {
    return {
      status: "refused",
      refusal: refuse(
        DAEMON_REPLY_REFUSAL_ORIGIN,
        "reply-unreadable" satisfies DaemonReplyRefusalCode,
        `The background service's reply to ${method} is not the shape this build registers for it${describeFailingPaths(readable.error)}, so the console read nothing from it.`,
      ),
    };
  }
  // The parsed value, not the raw reply, so a member the contract does not carry cannot reach a
  // component.
  return { status: "served", value: readable.data };
}

/** The abandoned-read refusal as `callDaemon`'s own answer. */
function abandonedRead(method: string): DaemonReply<never> {
  return { status: "refused", refusal: abandonedReadRefusal(method) };
}
