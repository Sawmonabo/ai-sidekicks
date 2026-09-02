// What a growth-port call ANSWERS with: the refusal vocabulary, the two outcome
// arms, and the shape a served subscription takes.
//
// This is the half of the port a caller writes code against. A surface that calls
// one operation narrows on `status`, renders the refusal or the value, and never
// needs the operation table, the signature table, or the port type — so those live
// next door in `growth-port.ts` and this module imports none of them. The
// dependency runs one way: the port produces these values, they do not know which
// port produced them.
//
// The boundary earns itself on the served arm. `GrowthOutcome` is what a fixture
// that ACTUALLY serves an operation returns, and such a fixture has no business
// importing the refusing port to describe a success.

import type { ConsoleRefusal } from "../core/index.js";
import type { GrowthOperationId } from "./growth-entry.js";
import type { GrowthSlateRowId } from "./growth-slate.js";

/** Why the port refused. One member today; a closed set so a second is a decision. */
export const GROWTH_PORT_REFUSAL_CODES = ["wire-unregistered"] as const;

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
