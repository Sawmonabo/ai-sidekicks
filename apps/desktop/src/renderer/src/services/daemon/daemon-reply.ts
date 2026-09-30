// The one place a daemon reply enters the console.
//
// WHY EVERY CALL COMES THROUGH HERE. Without it, a view calls the daemon, the
// promise fulfills, and the view reports success — clearing a draft, marking a turn
// sent, advancing an upload ledger — without the reply having been parsed against the
// shape the corpus registers for that method. The bridge's `call` is typed by the
// daemon's method map, and that type is a claim about another process rather than a
// check of what it sent, so the ONLY thing standing between a fulfilled promise and a
// rendered figure would be a `safeParse` somebody has to remember to write, once per
// call site, forever.
// `callDaemon` makes the parse structural: there is one entry, it is typed by the
// registry, and a caller that goes through it CANNOT hold an unparsed value.
//
// WHAT A CALLER GETS BACK. `DaemonReply` — `served(value)` or `refused(refusal)`,
// closed, with no third arm and no thrown exception on any ordinary path. A call
// that rejects, a request the contract would not admit, and a reply the contract
// does not admit are all one thing to the caller: a refusal it renders
// through the console's existing refusal primitives, carrying the code verbatim.
// Returning rather than throwing is what keeps that true — a `try` around every
// call is a `try` somebody eventually omits, and an omitted one takes down a mount
// effect rather than rendering a card.
//
// THE REQUEST IS PARSED TOO, AND BEFORE IT IS SENT. A shape the daemon would refuse
// becomes a rendered refusal instead of a round trip that fails, and the value that
// goes on the wire is the contract-admitted one rather than whatever the caller
// composed. That direction costs nothing at runtime the reply direction does not
// already cost, and it is the half a per-site parse always skipped.
//
// NO REFUSED VALUE EVER REACHES THE DETAIL SENTENCE. A schema failure knows exactly
// what it rejected, and what it rejected can be a user's message, a repo
// path, or a credential. A refused value never reaches a refusal's detail, so
// this module composes
// its own sentence from the METHOD and, at most, the member PATHS that failed —
// structural names the wire itself publishes. It never renders the validator's
// message, which quotes received values.
//
// WHAT THIS MODULE ANSWERS FOR. The methods the console calls: each one's descriptor
// states its shapes, `daemon-reply-registry.ts` looks it up, and a reply is checkable
// against it.
//
// THE REJECTION ARM IS THE CONSOLE'S ONE NORMALIZER, CONSUMED AND NOT COPIED. A
// rejection reaching `callDaemon` goes to `normalizeWireRejection`
// (`lib/wire-rejection.ts`), which holds the console's only reading of a rejected
// promise, and this module supplies only the two things that are its own: the origin
// every refusal here carries, and the sentence for a rejection that said nothing
// machine-readable. Four of that module's properties are the reason a private copy
// here would be wrong rather than merely redundant — the JSON-RPC arm, which takes
// the project's dotted code off `data.type` where a `{ code: string }` guard cannot
// see it because the JSON-RPC `code` is a NUMBER; the retry bound a rate-limit
// envelope registers; a structural unwrap of a carried refusal, which survives the
// realm crossing and the structured clone that leave `instanceof` silent; and the
// backstop that keeps the whole path total. A second reading of a daemon refusal is
// how `session.not_found` becomes `call-rejected`. `lib/wire-errors.ts`'s
// `wireRejectionToError` normalizes a rejection into an `Error` for a caller that
// throws one; it answers a different question, and this folder uses only its leaf
// helpers.

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
 * Why the console refused a call on its own side of the wire.
 *
 * Four members, closed, and none of them overlaps a DAEMON code: a typed wire
 * refusal keeps its own code verbatim (`repo.not_found`, `run.version_conflict`, …)
 * and is never re-labeled with one of these. These name the settlements that are
 * the console's own to describe.
 *
 *   • `request-unsendable` — the caller composed a request the registered schema
 *     does not admit. Nothing was sent.
 *   • `reply-unreadable` — the call fulfilled and the value is not the shape the
 *     corpus registers. Nothing is read from it.
 *   • `call-rejected` — the call rejected with something carrying no machine-
 *     readable code at all.
 *   • `read-abandoned` — the view that asked for this READ is gone, or a newer
 *     read replaced it. Nothing is read from the reply, and where the abandonment
 *     landed before the send, nothing was sent. It reaches a caller that is by
 *     definition no longer rendering, and it is a refusal rather than a silent
 *     resolution because a call whose answer is total cannot grow a fourth
 *     settlement without every caller learning about it.
 */
export const DAEMON_REPLY_REFUSAL_CODES = [
  "request-unsendable",
  "reply-unreadable",
  "call-rejected",
  "read-abandoned",
] as const;

/** One console-side call refusal code. Derived, so the vocabulary is declared once. */
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
 * How a caller says this call has an owner who may walk away from it.
 *
 * ONE MEMBER, AND IT IS OPTIONAL BECAUSE ITS ABSENCE IS A REAL ANSWER. A mutation
 * has no owner who may leave — a durable act that reached the daemon happened, and
 * the console's half of it is not the console's to abandon — so a mutation passes
 * nothing here and is awaited exactly as it always was. The parameter is therefore
 * the whole read-versus-mutation distinction at this call, visible at each call site
 * rather than inferred from the method name.
 */
export interface DaemonCallOptions {
  /**
   * The read round's signal, from the round the console's read seam handed the
   * caller. Aborted when a newer read superseded this one, or when the view that
   * asked for it is gone.
   */
  readonly signal?: AbortSignal;
}

/**
 * The refusal a read that nobody is waiting for settles as.
 *
 * Built here rather than at the three places that reach it, so the sentence a
 * reader would meet is one sentence. It names the method and no value: there is
 * nothing to quote and, on the pre-send arm, nothing was even composed.
 *
 * EXPORTED FOR THE COMPOSED READ, which has `await` boundaries `callDaemon` cannot
 * see. A read that calls `callDaemon`, folds the answer, and calls it again has to stop
 * between its own calls, and it already stops this way on the first one:
 * `services/daemon/unwrap-daemon-reply.ts`'s `unwrapDaemonReply` raises exactly this refusal the
 * moment `callDaemon` answers with it. A caller settling its later boundaries under a
 * code of its own would give one settlement two names, so it raises this one instead.
 */
export function abandonedReadRefusal(method: string): Refusal {
  return refuse(
    DAEMON_REPLY_REFUSAL_ORIGIN,
    "read-abandoned" satisfies DaemonReplyRefusalCode,
    `Nothing is waiting for the ${method} read any more, so the console read nothing from it.`,
  );
}

/**
 * Call one daemon method the console calls and answer with a parsed reply or a refusal.
 *
 * The generic is what does the work: `method` is a member of the console's closed
 * call set, so a method outside it is a compile error rather than a runtime miss,
 * and `request` and the served `value` take their types from the daemon's method
 * map for that same name. A caller never names a schema, so a caller never names
 * the wrong one.
 *
 * `async` and total. An `async` function's synchronous throw is already a
 * rejection, which matters against the bridge that actually ships: the stub
 * preload throws from every method in the caller's own frame, so a non-`async`
 * wrapper would put that throw outside the promise and past every `.catch` the
 * console has.
 *
 * AN ABANDONED READ IS CHECKED AT FOUR POINTS AND PARSED AT NONE. Before the send,
 * so an abandoned line puts nothing on the wire; racing the call, so a reply that
 * never arrives cannot hold its caller for the life of the window; again after that
 * race and before the parse, because the race answers which of two events came
 * first and not whether anybody is still waiting once both have; and on the
 * rejection arm, so a read whose owner is gone reports the departure rather than a
 * wire failure nobody asked about. What the abandonment actually saves is the two
 * lines below it — `safeParse` over the whole reply, and the projection the caller
 * would build from it — which for a large diff is the console's most expensive
 * stretch of main-thread work, spent for a frame that will never be painted.
 *
 * IT CANCELS THE CONSOLE'S INTEREST AND NOT THE DAEMON'S WORK. No per-request
 * cancellation is registered on this wire, so the pending promise is dropped and
 * nothing is sent to say so.
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
      // The read lost its owner and the call failed, in whichever order. Reporting
      // the wire failure would compose a refusal about a call nobody put a question
      // for any more; the departure is the fact that explains the settlement.
      return abandonedRead(method);
    }
    return {
      status: "refused",
      // The fallback is offered and not imposed: every typed arm runs first, so a
      // rejection carrying a code of its own keeps it and only one that carries
      // none reaches this sentence. It names the method and stops there — the
      // rejected value is not quoted into it, because a rejection off the wire can
      // carry user content as readily as a schema failure can.
      refusal: normalizeWireRejection(DAEMON_REPLY_REFUSAL_ORIGIN, rejection, {
        code: "call-rejected" satisfies DaemonReplyRefusalCode,
        detail: `${method} was rejected.`,
      }),
    };
  }

  if (isReadAbandoned(signal)) {
    // THE INTERLEAVING THE RACE ABOVE CANNOT ANSWER, and the reason this check is
    // here rather than folded into it. `settleUnlessAbandoned` reports which of the
    // two racers WON; it resolves the instant the reply does, retiring its abort
    // listener as it goes. An abort that lands after that resolution and before this
    // frame is resumed therefore finds no listener to reach, and the settlement says
    // `settled` while nobody is waiting — one microtask apart, which is exactly the
    // gap a fulfillment and a pane teardown scheduled in the same tick fall into.
    // Reading the signal again is what makes "an abandoned reply is never parsed" a
    // property of `callDaemon` instead of a property of the microtask order, and it is
    // read HERE, adjacent to the parse it guards, so no `await` can ever be
    // introduced between the guarantee and the line it is about.
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
  // The parsed value and not the raw reply: what a view renders is what the
  // registered schema admits, so a member the contract does not carry cannot reach
  // a component even when the wire sent one.
  return { status: "served", value: readable.data };
}

/** That refusal as `callDaemon`'s own answer, so every arm here returns one shape. */
function abandonedRead(method: string): DaemonReply<never> {
  return { status: "refused", refusal: abandonedReadRefusal(method) };
}
