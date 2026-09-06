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

import type { ConsoleRefusal } from "../../core/index.js";
import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthSlateRowId } from "./growth-slate.js";
import { SCRIPTED_REPLY_REFUSAL_CODES } from "../scenario-runtime/index.js";

/**
 * Why the port refused. A closed set, and each member is a decision:
 *
 *   • `wire-unregistered` — nobody asked, because the wire this operation needs is
 *     not registered anywhere in the corpus. The refusal names who owes it. This is
 *     the only code a LIVE bridge produces on its own behalf, and it is the "not
 *     checked" kind of nothing rather than an empty result.
 *   • `call-rejected` — the call was made and its promise REJECTED rather than
 *     answering. No port in this build does that on purpose: every operation resolves
 *     to one of the two arms below, and the live one resolves to a refusal. It is a
 *     code because the rejection channel of a promise exists whether a contract uses
 *     it or not, and a caller that reads only the fulfilment arm leaves its surface
 *     pinned on the read-in-flight state for the life of the mount. A caller minting
 *     its own refusal for this instead would put a second `origin` on a failure of
 *     THIS port, which is the vocabulary sprawl `core/refusal.ts` was written to end.
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
  "wire-unregistered",
  "call-rejected",
  ...typeof SCRIPTED_REPLY_REFUSAL_CODES,
] = ["wire-unregistered", "call-rejected", ...SCRIPTED_REPLY_REFUSAL_CODES];

/** One growth-port refusal code. Derived, so the vocabulary is declared once. */
export type GrowthPortRefusalCode = (typeof GROWTH_PORT_REFUSAL_CODES)[number];

/** The subsystem name every growth-port refusal carries. */
export const GROWTH_PORT_REFUSAL_ORIGIN = "growth-port";

/**
 * The refusal a live bridge returns for an unbuilt wire.
 *
 * The console's ONE refusal shape (`core/refusal.ts`), widened with what a growth
 * refusal knows and nothing else does: which operation was called, which slate row
 * it serves, and who owes the wire. `core/refusal.ts` names this port as one of the
 * five producers that had minted a refusal vocabulary of its own — the cost was
 * that a surface rendering a growth refusal beside a persistence one had to
 * translate between two shapes to reach one renderer. Extending means
 * `isConsoleRefusal` answers true here and `<RefusalCard {...outcome} />` works.
 *
 * `status` stays, and is not replaced by the presence of `code`: this value is one
 * arm of `GrowthOutcome`, and the discriminant is what makes the served arm
 * narrowable.
 */
export interface GrowthUnavailable extends ConsoleRefusal {
  readonly status: "unavailable";
  readonly code: GrowthPortRefusalCode;
  readonly operationId: GrowthOperationId;
  readonly slateRow: GrowthSlateRowId;
  readonly owningDocument: string;
}

/** A served result, from the fixture bridge. */
export interface GrowthServed<TValue> {
  readonly status: "served";
  readonly value: TValue;
}

export type GrowthOutcome<TValue> = GrowthServed<TValue> | GrowthUnavailable;

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
