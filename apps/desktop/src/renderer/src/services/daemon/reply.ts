// The one place a daemon reply enters the app. Every call goes through `callDaemon`, so a
// reply is checked with its method's generated check before a view can act on it, and a caller
// cannot hold an unchecked value. The request is checked too, before it is sent.
//
// A caller gets a `DaemonReply`, `served` or `refused`, and nothing is thrown on an ordinary path:
// a rejected call, an unsendable request and an unreadable reply are all a refusal that carries the
// code verbatim.
//
// No refused value reaches a refusal's detail, because a rejected value can be a user's message, a
// path or a credential. The detail is a plain sentence; the method and the failing member paths go
// to the window's diagnostic capture.
//
// A rejection goes to `normalizeWireRejection` (`lib/wire/rejection.ts`), the app's only
// reading of a rejected promise. This module supplies the origin and the fallback sentence for a
// rejection with no machine-readable code; a private copy would misread a JSON-RPC rejection
// (whose numeric `code` hides the dotted code at `data.type`) and turn `session.not_found` into
// `call-rejected`.

import type { SchemaCheck } from "@ai-sidekicks/contracts/schema-check";
import {
  DAEMON_METHOD_BINDINGS,
  type DaemonMethodBindings,
  type RegisteredDaemonMethod,
} from "#shared/daemon/method-bindings.js";
import { checkFaultPaths } from "#shared/daemon/fault-path.js";
import { REQUEST_UNSENDABLE_CODE, REQUEST_UNSENDABLE_MESSAGE } from "#shared/daemon/forwarding.js";
import { NOT_ANSWERING_MESSAGE } from "#shared/daemon/status-topic.js";
import { recordRefusedMemberPaths } from "#renderer/lib/diagnostic-capture/refused-member-record.js";
import { normalizeWireRejection, type RejectionFallback } from "#renderer/lib/wire/rejection.js";
import type { ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { isReadAbandoned, settleUnlessAbandoned } from "#renderer/lib/reads/scope.js";
import type { FilePathRef, ServedDaemonCall } from "#shared/preload-api.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { RefusalError } from "#renderer/lib/refusal/contract.js";

/** The subsystem name every refusal this module raises carries. */
export const DAEMON_REPLY_REFUSAL_ORIGIN = "daemon-call";

/** The subsystem every diagnostic record of a refused call names. */
const DAEMON_REPLY_DIAGNOSTIC_SOURCE = "services/daemon";

/**
 * Why the app refused a call on its own side of the wire. None overlaps a daemon code: a
 * typed wire refusal keeps its own code verbatim.
 *
 *   • `request-unsendable`: the request fails its method's generated check, here or in the client
 *     helper; nothing was sent.
 *   • `reply-unreadable`: the call fulfilled with a value its method's generated check refuses.
 *   • `call-rejected`: the call rejected with nothing carrying a machine-readable code.
 *   • `read-abandoned`: the view that asked for this read is gone or a newer read replaced it;
 *     nothing is read from the reply. It is a refusal, not a silent resolution, so the call's
 *     answer stays total.
 */
export const DAEMON_REPLY_REFUSAL_CODES: readonly [
  typeof REQUEST_UNSENDABLE_CODE,
  "reply-unreadable",
  "call-rejected",
  "read-abandoned",
] = [REQUEST_UNSENDABLE_CODE, "reply-unreadable", "call-rejected", "read-abandoned"] as const;

/** One app-side call refusal code, derived from `DAEMON_REPLY_REFUSAL_CODES`. */
export type DaemonReplyRefusalCode = (typeof DAEMON_REPLY_REFUSAL_CODES)[number];

/**
 * What a daemon call that rejected with no code of its own reads as. It never quotes the rejected
 * value, which can carry user content.
 */
export const CALL_REJECTED_FALLBACK: RejectionFallback = {
  code: "call-rejected" satisfies DaemonReplyRefusalCode,
  detail: NOT_ANSWERING_MESSAGE,
};

/**
 * A checked reply, or the refusal standing in its place. Never both, never neither. A served reply
 * that offers paths to open carries main's token for each, keyed by the path, so `Open` hands
 * `native.openInEditor` the token and never the path.
 *
 * `status` is the discriminant rather than the presence of `value`, so a response
 * type that is legitimately `undefined`-shaped still narrows. A refusal keeps the registered
 * members the daemon sent with it, such as its listed `reason`.
 */
export type DaemonReply<TValue> =
  | {
      readonly status: "served";
      readonly value: TValue;
      readonly fileRefs?: Readonly<Record<string, FilePathRef>>;
    }
  | { readonly status: "refused"; readonly refusal: ExtendedRefusal };

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
 * The refusal a read that nobody is waiting for settles as. Exported for composed reads, which
 * have `await` boundaries `callDaemon` cannot see and must stop with this same refusal rather
 * than a code of their own.
 */
export function abandonedReadRefusal(): Refusal {
  return refuse(
    DAEMON_REPLY_REFUSAL_ORIGIN,
    "read-abandoned" satisfies DaemonReplyRefusalCode,
    "This read was closed before it finished.",
  );
}

/**
 * Call one daemon method and answer with a checked reply or a refusal; never throws. `method`
 * is a member of the closed call set, and `request` and the served value take their types from
 * the method map. `async` so a synchronous bridge throw becomes a rejection.
 *
 * Whether the read was abandoned is asked at four points: before the send, racing the call, after
 * the race and before the reply's check, and on the rejection arm. That saves the reply's check
 * and the caller's projection, the most expensive main-thread work for a large diff.
 * Abandonment cancels the app's interest and not the daemon's work: the wire has no
 * per-request cancellation, so the pending promise is dropped.
 */
export async function callDaemon<MethodName extends RegisteredDaemonMethod>(
  bridge: PlatformBridge,
  method: MethodName,
  request: DaemonParams<MethodName>,
  options: DaemonCallOptions = {},
): Promise<DaemonReply<DaemonResult<MethodName>>> {
  const { requestCheck, responseCheck }: MethodChecks<MethodName> = DAEMON_METHOD_BINDINGS[method];
  const { signal } = options;

  if (isReadAbandoned(signal)) {
    return abandonedRead();
  }

  if (!requestCheck(request)) {
    recordRefusedMemberPaths({
      source: DAEMON_REPLY_DIAGNOSTIC_SOURCE,
      kind: "request-unsendable",
      subject: method,
      issues: checkFaultPaths(requestCheck, request),
    });
    return {
      status: "refused",
      refusal: refuse(
        DAEMON_REPLY_REFUSAL_ORIGIN,
        "request-unsendable" satisfies DaemonReplyRefusalCode,
        REQUEST_UNSENDABLE_MESSAGE,
      ),
    };
  }

  let reply: ServedDaemonCall<unknown>;
  try {
    const settlement = await settleUnlessAbandoned(bridge.daemon.call(method, request), signal);
    if (settlement.status === "abandoned") {
      return abandonedRead();
    }
    reply = settlement.value;
  } catch (rejection: unknown) {
    if (isReadAbandoned(signal)) {
      // The read lost its owner and the call failed, in either order; the departure is the
      // fact that explains the settlement.
      return abandonedRead();
    }
    // The fallback applies only to a rejection with no code of its own.
    const refusal = normalizeWireRejection(
      DAEMON_REPLY_REFUSAL_ORIGIN,
      rejection,
      CALL_REJECTED_FALLBACK,
    );
    recordRefusedMemberPaths({
      source: DAEMON_REPLY_DIAGNOSTIC_SOURCE,
      kind: refusal.code,
      subject: method,
      issues: [],
    });
    return { status: "refused", refusal };
  }

  if (isReadAbandoned(signal)) {
    // `settleUnlessAbandoned` resolves the instant the reply does and retires its abort
    // listener, so an abort landing before this frame resumes says `settled` while nobody is
    // waiting. Reading the signal again, next to the check, makes "an abandoned reply is never
    // checked" independent of microtask order.
    return abandonedRead();
  }

  const served = reply.value;
  if (!responseCheck(served)) {
    recordRefusedMemberPaths({
      source: DAEMON_REPLY_DIAGNOSTIC_SOURCE,
      kind: "reply-unreadable",
      subject: method,
      issues: checkFaultPaths(responseCheck, served),
    });
    return {
      status: "refused",
      refusal: refuse(
        DAEMON_REPLY_REFUSAL_ORIGIN,
        "reply-unreadable" satisfies DaemonReplyRefusalCode,
        "The background service's reply could not be read.",
      ),
    };
  }
  // A generated check refuses a member its contract does not carry, so the checked value is the
  // reply whole.
  return reply.fileRefs === undefined
    ? { status: "served", value: served }
    : { status: "served", value: served, fileRefs: reply.fileRefs };
}

/**
 * The value a daemon reply served, thrown as a `RefusalError` where it refused instead.
 *
 * `callDaemon` never throws, but a `PushDrivenRead` body must return a value or throw. The error
 * is a `RefusalError` so `coerceToRefusal` hands the daemon's refusal back verbatim, keeping its
 * code, sentence and origin.
 */
export function unwrapDaemonReply<TValue>(reply: DaemonReply<TValue>): TValue {
  if (reply.status === "refused") {
    throw new RefusalError(reply.refusal);
  }
  return reply.value;
}

/** The abandoned-read refusal as `callDaemon`'s own answer. */
function abandonedRead(): DaemonReply<never> {
  return { status: "refused", refusal: abandonedReadRefusal() };
}

/** The request one daemon method takes, as its generated request check states it. */
type DaemonParams<MethodName extends RegisteredDaemonMethod> = CheckedValue<
  DaemonMethodBindings[MethodName]["requestCheck"]
>;

/** The reply one daemon method serves, as its generated response check states it. */
type DaemonResult<MethodName extends RegisteredDaemonMethod> = CheckedValue<
  DaemonMethodBindings[MethodName]["responseCheck"]
>;

/** One method's two generated checks, typed for that method so a passed check narrows. */
interface MethodChecks<MethodName extends RegisteredDaemonMethod> {
  readonly requestCheck: SchemaCheck<DaemonParams<MethodName>>;
  readonly responseCheck: SchemaCheck<DaemonResult<MethodName>>;
}

/** The value a generated check admits. */
type CheckedValue<Check> = Check extends SchemaCheck<infer Value> ? Value : never;
