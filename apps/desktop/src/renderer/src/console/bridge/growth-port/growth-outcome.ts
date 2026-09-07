// What a growth-port call ANSWERS with: the refusal vocabulary, the two outcome
// arms, and the shape a served subscription takes.
//
// This is the half of the port a caller writes code against. A surface that calls
// one operation narrows on `status`, renders the refusal or the value, and never
// needs the operation table, the signature table, or the port type — so those live
// next door in `growth-operations/`, `growth-signatures/`, and `growth-port.ts`,
// and this module imports none of them. The
// dependency runs one way: the port produces these values, they do not know which
// port produced them.
//
// The boundary earns itself on the served arm. `GrowthOutcome` is what a fixture
// that ACTUALLY serves an operation returns, and such a fixture has no business
// importing the refusing port to describe a success.

import type { ConsoleRefusal, WireRefusal } from "../../core/index.js";
import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthSlateRowId } from "./growth-slate.js";
import {
  SCRIPT_ABSENT_REFUSAL_CODE,
  SCRIPTED_REPLY_REFUSAL_CODES,
} from "../scenario-runtime/index.js";

/**
 * The code a build with no wire for an operation refuses under.
 *
 * ITS ONE HOME, and named rather than left as a literal inside the tuple below,
 * because it is raised outside this family too: a pane whose whole authoring surface
 * has no registered wire refuses locally under the same code, and a second literal
 * there is a second place for one wire string to be edited.
 */
export const WIRE_UNREGISTERED_REFUSAL_CODE = "wire-unregistered" as const;

/**
 * The code a call that REJECTED rather than answering refuses under.
 *
 * Named on the same rule as its sibling above rather than left as a literal in the
 * tuple: the two arms of {@link GrowthUnavailable} are discriminated on it, so the
 * string is read by the type declarations as well as by the builder, and a literal
 * in three positions is three places for one wire string to be edited.
 */
export const CALL_REJECTED_REFUSAL_CODE = "call-rejected" as const;

/**
 * Why the port refused. A closed set, and each member is a decision:
 *
 *   • `wire-unregistered` — nobody asked, because the wire this operation needs is
 *     not registered anywhere in the corpus. The refusal names who owes it. This is
 *     the only code a LIVE bridge produces on its own behalf, and it is the "not
 *     checked" kind of nothing rather than an empty result.
 *   • `reply-unscripted` — the fixture SERVES this operation and the scenario in play
 *     models nothing it could be answered from. A different fact from the one above
 *     and it must not borrow that code: `wire-unregistered` says this build does not
 *     carry the wire, which for a served operation is false, and a surface told it
 *     would name the wrong document as owing. Fixture-only, and spelled once in
 *     `scripted-reply.ts` because `fixture-bridge.ts` raises the same word for the
 *     same absence on the call arm.
 *   • `call-rejected` — the call was made and its promise REJECTED rather than
 *     answering. No port in this build does that on purpose: every operation resolves
 *     to one of the two arms below, and the live one resolves to a refusal. It is a
 *     code because the rejection channel of a promise exists whether a contract uses
 *     it or not, and a caller that reads only the fulfilment arm leaves its surface
 *     pinned on the read-in-flight state for the life of the mount. A caller minting
 *     its own refusal for this instead would put a second `origin` on a failure of
 *     THIS port, which is the vocabulary sprawl `core/refusal.ts` was written to end.
 *     It is the one code that answers WHICH SEAM broke rather than what the other
 *     side said, so the refusal carrying it carries the other side's own refusal on
 *     `cause` as well — see {@link GrowthCallRejected}.
 *   • `reply-abandoned` — the fixture asked, and the scenario engine was torn down
 *     before the frozen clock reached the answer.
 *   • `reply-backlog-full` — the fixture asked, and the engine was already holding
 *     its cap of delayed replies, so this one was never parked at all.
 *
 * The last two are spread in from `scripted-reply.ts`, which is where the seam that
 * produces them lives and where `fixture-bridge.ts` reads the same two from. They
 * exist as codes at all because of the rule they enforce: a fixture must NEVER map an
 * abandoned or over-cap scripted reply to an absent value. Both of those are a reply
 * that did not arrive, and an absent value renders as "there is none" — a claim about
 * the session that nothing checked. The union stays two-armed (`served | unavailable`)
 * so no consumer's exhaustive switch breaks: the new codes ride the existing
 * `unavailable` arm and render through the same `RefusalCard` the first one does.
 */
export const GROWTH_PORT_REFUSAL_CODES: readonly [
  typeof WIRE_UNREGISTERED_REFUSAL_CODE,
  typeof SCRIPT_ABSENT_REFUSAL_CODE,
  typeof CALL_REJECTED_REFUSAL_CODE,
  ...typeof SCRIPTED_REPLY_REFUSAL_CODES,
] = [
  WIRE_UNREGISTERED_REFUSAL_CODE,
  SCRIPT_ABSENT_REFUSAL_CODE,
  CALL_REJECTED_REFUSAL_CODE,
  ...SCRIPTED_REPLY_REFUSAL_CODES,
];

/** One growth-port refusal code. Derived, so the vocabulary is declared once. */
export type GrowthPortRefusalCode = (typeof GROWTH_PORT_REFUSAL_CODES)[number];

/** The subsystem name every growth-port refusal carries. */
export const GROWTH_PORT_REFUSAL_ORIGIN = "growth-port";

/**
 * What every growth-port refusal knows beyond the console's three fields.
 *
 * `core/refusal.ts` names this port as one of the five producers that had minted a
 * refusal vocabulary of its own — the cost was that a surface rendering a growth
 * refusal beside a persistence one had to translate between two shapes to reach one
 * renderer. The ledger is what a growth refusal adds and nothing else does: which
 * operation was called, which slate row it serves, and who owes the wire.
 *
 * `status` stays, and is not replaced by the presence of `code`: this value is one
 * arm of `GrowthOutcome`, and the discriminant is what makes the served arm
 * narrowable.
 */
export interface GrowthRefusalLedger {
  readonly status: "unavailable";
  readonly operationId: GrowthOperationId;
  readonly slateRow: GrowthSlateRowId;
  readonly owningDocument: string;
}

/**
 * The refusal a port returns when it did not ask, or when its answer never came.
 *
 * The console's ONE refusal shape (`core/refusal.ts`) plus the ledger, so
 * `isConsoleRefusal` answers true here and `<RefusalCard {...outcome} />` works.
 * `cause` is declared ABSENT rather than omitted: it is the union's second member
 * below, and a caller narrowing on `code` reads `undefined` on this arm instead of a
 * type error, which is what makes the narrowing worth having at a call site.
 */
export interface GrowthWireRefused extends ConsoleRefusal, GrowthRefusalLedger {
  readonly code: Exclude<GrowthPortRefusalCode, typeof CALL_REJECTED_REFUSAL_CODE>;
  readonly cause?: undefined;
}

/**
 * The refusal a caller returns when a port call REJECTED instead of answering.
 *
 * `cause` IS THE POINT OF THE SECOND ARM, and it is required here rather than
 * optional everywhere. A rejection off this seam may carry a daemon envelope — the
 * scripted-reply seam throws one verbatim, and the live seam will throw the same
 * shape the day the wire lands — so the rejection is normalized by the console's one
 * total reader before it reaches this value, and what that reader recovered travels
 * on. Without it the daemon's own dotted code was read and then dropped, and one
 * surface rendered `call-rejected` where its sibling one navigation later rendered
 * `workflow.session_not_found` for the same failure.
 *
 * `code` still says `call-rejected`, and that is not a contradiction: this port's
 * vocabulary answers WHICH SEAM broke, and `cause.code` answers what the other side
 * said. A consumer that must branch on the daemon's word branches on the second.
 */
export interface GrowthCallRejected extends ConsoleRefusal, GrowthRefusalLedger {
  readonly code: typeof CALL_REJECTED_REFUSAL_CODE;
  readonly cause: WireRefusal;
}

/** A growth refusal, on whichever of the two arms produced it. */
export type GrowthUnavailable = GrowthWireRefused | GrowthCallRejected;

/**
 * True where a refusal means the console never asked, rather than that asking failed.
 *
 * THE ONE READING OF THAT QUESTION, and it is a question every surface offering a
 * growth-backed list has to answer: `Spec-023 §Console Design (Meridian)` rule 8
 * separates "we have not asked" from a read that was put and failed, and a surface
 * that renders one as the other tells a person the console is idle while a channel is
 * down. The three surfaces that render the node's session directory each asked it by
 * eye and each got it wrong the same way, so it is answered here — beside the code it
 * is about, which is the only place the answer cannot drift from the vocabulary.
 *
 * Takes a `ConsoleRefusal` rather than a `GrowthUnavailable`: by the time a refusal
 * reaches a surface it may have been settled by `bridge/readings/read-settlement.ts`,
 * which carries the port's own refusals through untouched and rebuilds a rejection
 * into the console's shape. Both are refusals and only one of them can carry this
 * code, so the code is the whole of the question.
 */
export function isUnbuiltWireRefusal(refusal: ConsoleRefusal): boolean {
  return refusal.code === WIRE_UNREGISTERED_REFUSAL_CODE;
}

/** A served result, from the fixture bridge. */
export interface GrowthServed<TValue> {
  readonly status: "served";
  readonly value: TValue;
}

export type GrowthOutcome<TValue> = GrowthServed<TValue> | GrowthUnavailable;

/**
 * Narrow a served outcome's value, leaving a refusal exactly as it arrived.
 *
 * The fixture reads a scenario's scripted reply as `unknown` and several served
 * operations answer with a shape the console has to narrow first, so the two steps —
 * "did the script answer" and "what does that answer mean" — meet here rather than in
 * four hand-written switches that would each have to remember to carry the refusal
 * through untouched. Rewrapping a refusal is the mistake this prevents: a refusal
 * re-minted on the way past loses the operation, the slate row, and the document that
 * owes the wire.
 */
export function mapGrowthServed<TIn, TOut>(
  outcome: GrowthOutcome<TIn>,
  narrow: (value: TIn) => TOut,
): GrowthOutcome<TOut> {
  return outcome.status === "served" ? { status: "served", value: narrow(outcome.value) } : outcome;
}

/**
 * What a surface holds for ONE growth-port read: the port's answer, or why there is none.
 *
 * TWO ARMS BECAUSE THE OUTCOME HAS ONE TOO FEW. `answered` is a call that RESOLVED —
 * served, or `unavailable` with the reason already on it — so an ordinary refusal
 * travels inside the outcome and needs no arm of its own here. `unreadable` is the
 * other fact entirely: the call produced no outcome AT ALL. A rejected promise, a
 * bridge torn down under a read still in flight, a delivery nothing could narrow —
 * none of them is expressible as a {@link GrowthUnavailable}, whose `code` is a closed
 * vocabulary this port owns and a caller does not, so an unreadable read carries the
 * console's own {@link ConsoleRefusal} instead.
 *
 * THE MISSING ARM IS THE ONE THAT MATTERS MOST, because leaving it out is silent: a
 * `.then` with no rejection handler leaves the cell untouched, so the surface goes on
 * rendering its not-loaded absence for the life of the window while an unhandled
 * rejection reaches it. That is a read which FAILED reported as a read still IN
 * FLIGHT, which is exactly the conflation the console's five kinds of nothing exist to
 * prevent.
 *
 * GENERIC IN THE OUTCOME, AND DECLARED ONCE HERE. Every view family is a sibling of
 * every other, so a family that wrote these two arms for itself could not share them
 * with the next one that needs them — and two copies are two vocabularies for one
 * fact. It sits beside {@link GrowthOutcome} because that is what its answered arm
 * carries, and because this module is already the half of the port a caller writes
 * code against.
 */
export type GrowthReading<TOutcome> =
  | { readonly kind: "answered"; readonly outcome: TOutcome }
  | { readonly kind: "unreadable"; readonly refusal: ConsoleRefusal };

/** A subscription's served form: an async iterable the caller drains and closes. */
export interface GrowthStream<TEvent> {
  readonly events: AsyncIterable<TEvent>;
  close(): void;
}
