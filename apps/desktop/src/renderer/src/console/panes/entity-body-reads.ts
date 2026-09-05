// Reading one member off a console entity's body.
//
// A `ConsoleEntity.body` is wire-verbatim: the store holds what the daemon sent and
// narrows nothing, so every member arrives `unknown` and every pane that reads one
// has to decide what counts as present. Two panes had each decided, identically and
// separately — `runs/run-seating.ts` as `readString(body, member)` and
// `approvals/card/provider-ask.ts` as `nonEmptyString(value)` — which is one rule
// with two spellings and no instrument holding them together.
//
// THE EMPTY STRING IS ABSENT, and that is the decision the name records. A wire
// member present as `""` carries nothing a reader can render: every consumer of both
// predicates renders such a member as missing, so admitting it would only move the
// same judgement downstream into a caller that then has to make it again. A caller
// that ever needs to tell an empty member from an absent one is reading a wire shape
// that should be parsed by its registered schema rather than picked out of a body.

/**
 * One body member as a non-empty string, or `undefined` for anything else.
 *
 * The parameter is the VALUE rather than a `(body, member)` pair, which is the
 * narrower of the two shapes the callers had: an entity whose body is itself optional
 * reads `entity?.body?.["askId"]` at the call site and cannot hand over a body at all,
 * and the pair form buys nothing the indexing does not already say.
 */
export function readWireString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
