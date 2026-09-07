// Reading one wire-supplied member as a string, or as a finite number.
//
// A `ConsoleEntity.body` is wire-verbatim: the store holds what the daemon sent and
// narrows nothing, so every member arrives `unknown` and every surface that reads one
// has to decide what counts as present. Surfaces across three view families and the
// shell had each decided, identically and separately, under spellings that shared
// nothing but the rule: `readString(body, member)`, `nonEmptyString(value)`, an
// inline `typeof` inside a wire facet, and this module's OWN exported name at a
// different arity. One rule with that many spellings has no instrument holding it
// together, which is exactly how the sweep that hoisted it here left a fifth copy
// standing in the shell — `nonEmptyString` again, in the family that authored the
// hoist — and why the count is deliberately NOT written down: a number in this
// paragraph is a claim nothing reads, and the last one was wrong before the sweep
// that stated it had finished. A private copy sharing an exported name is unfindable
// by a reader and invisible to a change of the rule the name records, and the only
// standing claim here is that this module is where the rule lives.
//
// THE NUMBER READ IS THE SAME RULE ABOUT A DIFFERENT TYPE, and it is here for the
// same reason and not a weaker one: `run-seating.ts` and `chip-models.ts` carried
// byte-identical bodies under two names in two VIEW families, and siblings may not
// import each other, so the only home either could share is this one.
//
// IT LIVES IN `core/` BECAUSE ITS READERS ARE SIBLINGS. Three VIEW families need it
// and view families never import each other, so the rule has to sit in the lowest
// family that needs it; this one needs nothing at all — no store type, no contracts
// schema, no React — which puts it on the DAG floor. It sat in `panes/` while its two
// first readers were subdirectories of that composition site, and a body module there
// is reachable from a view family only by importing UPWARD into the site that
// composes it: an edge the layering gate cannot report, because both composition
// sites are subtracted from its endpoints so that `panes/index.ts` may name every
// family.
//
// IT IS NOT `bridge/daemon/entity-body-reads.ts`, which is why it does not share that name.
// Those two reads answer a REGISTERED wire shape and must narrow against the schema
// the corpus registers, which is what puts them where the canonical shapes may be
// imported. This one registers nothing and parses nothing — it is the string
// predicate every such read still has to make first.
//
// THE EMPTY STRING IS ABSENT, and that is the decision the name records. A wire
// member present as `""` carries nothing a reader can render: every consumer renders
// such a member as missing, so admitting it would only move the same judgement
// downstream into a caller that then has to make it again. A caller that ever needs
// to tell an empty member from an absent one is reading a wire shape that should be
// parsed by its registered schema rather than picked out of a body.

/**
 * One wire-supplied value as a non-empty string, or `undefined` for anything else.
 *
 * The parameter is the VALUE rather than a `(body, member)` pair, which is the
 * narrower of the shapes the callers had: an entity whose body is itself optional
 * reads `entity?.body?.["askId"]` at the call site and cannot hand over a body at all,
 * and the pair form buys nothing the indexing does not already say.
 */
export function readWireString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * One wire-supplied value as a finite number, or `undefined` for anything else.
 *
 * `Number.isFinite` and not a bare `typeof`, which is the decision this predicate
 * records: `NaN` and both infinities are numbers to JavaScript and are not figures a
 * surface may render. A wire member arriving as one is a member the daemon could not
 * compute, and rendering it would put `NaN` in front of a person as though it were a
 * reading.
 */
export function readWireNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
