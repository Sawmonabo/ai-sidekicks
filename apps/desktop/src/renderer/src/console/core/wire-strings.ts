// Reading one wire-supplied member as a string.
//
// A `ConsoleEntity.body` is wire-verbatim: the store holds what the daemon sent and
// narrows nothing, so every member arrives `unknown` and every surface that reads one
// has to decide what counts as present. Three surfaces had each decided, identically
// and separately — `runs/pane/run-seating.ts` as `readString(body, member)`,
// `approvals/pane/card/provider-ask.ts` as `nonEmptyString(value)`, and
// `inspector/pane/entity-detail/entity-facets.ts` inline in its wire facet — which is
// one rule with three spellings and no instrument holding them together.
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
