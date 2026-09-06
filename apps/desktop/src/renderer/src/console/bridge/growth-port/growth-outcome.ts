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
 *     the only code a LIVE bridge produces, and it is the "not checked" kind of
 *     nothing rather than an empty result.
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
  ...typeof SCRIPTED_REPLY_REFUSAL_CODES,
] = ["wire-unregistered", ...SCRIPTED_REPLY_REFUSAL_CODES];

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

/** A subscription's served form: an async iterable the caller drains and closes. */
export interface GrowthStream<TEvent> {
  readonly events: AsyncIterable<TEvent>;
  close(): void;
}
