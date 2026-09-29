// Reading one wire-supplied member as a string, or as a finite number.
//
// A `StoredEntity.body` is wire-verbatim: the store holds what the daemon sent and
// narrows nothing, so every member arrives `unknown` and every view that reads one
// has to decide what counts as present. That decision is one rule, and this module is
// where it lives: a private copy under another spelling — a local `readString`, a
// `nonEmptyString`, an inline `typeof` — is unfindable by a reader and invisible to a
// change of the rule, so every reader imports it from here.
//
// THE NUMBER READ IS THE SAME RULE ABOUT A DIFFERENT TYPE, and it is here for the
// same reason and not a weaker one: one feature never imports another, so the only
// home two of them can share is shared code.
//
// IT LIVES IN `lib/` BECAUSE ITS READERS ARE SIBLINGS. Several features need it and
// one feature never imports another, so the rule has to sit in shared code; this one
// needs nothing at all — no store type, no contracts schema, no React — which puts it
// at the bottom of the import layering.
//
// IT IS NOT A REGISTERED-SHAPE READ. A read that answers a REGISTERED wire shape must
// narrow against the schema the corpus registers, which is what puts it where the
// canonical shapes may be imported. This one registers nothing and parses nothing — it
// is the string predicate every such read still has to make first.
//
// THE EMPTY STRING IS ABSENT, and that is the decision the name records. A wire
// member present as `""` carries nothing a reader can render: every consumer renders
// such a member as missing, so admitting it would only move the same judgment
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
 * view may render. A wire member arriving as one is a member the daemon could not
 * compute, and rendering it would put `NaN` in front of a person as though it were a
 * reading.
 */
export function readWireNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
