// What a human phase's input schema may ask for at its ROOT, and what happens where it
// asks for something else.
//
// THE RULE IS THE CORPUS'S AND NOT THIS MODULE'S. A submitted answer travels as the
// request's `fields`, which is a set of named values and nothing else, and a human
// phase's schema is authored as the fields the phase asks for. So a root declaring
// `string`, `number`, `integer`, `boolean`, or `array` describes an answer that request
// has no member to carry: every value such a schema accepts is one the wire refuses, and
// the one value the wire accepts is the one that schema forbids. There is no answer at
// all there — not a hard one, and not one a different control would reach.
//
// WHICH IS WHY IT IS A REFUSAL RATHER THAN THE RAW EDITOR. The editor is the mapper's
// answer to a schema it cannot DRAW, and it works because a person can still compose the
// object the wire wants. Here that object is the one thing the schema forbids, so an
// editor would invite an answer whose only settlement is the submit surface's own
// `answer-not-composed` — a control that cannot work, which this console does not offer.
// The fault is in the definition, and the surface says so where a person meets it.
//
// A ROOT NOTHING COULD READ IS A DIFFERENT FACT. A schema that is absent, or is not a
// JSON object at all, declares no type — it says nothing about whether the answer may be
// a set of named values, so the mapper's own whole-schema fallback stands and its raw
// editor is answerable. Only a root that DECLARES another type is refused here.
//
// AND THE READING HAS ONE HOME. The mapper asks this module which roots it may draw from
// rather than deciding it a second time, so the arm a schema opens on and the refusal a
// schema earns can never disagree.

import { refuse, type NarrowedRefusal } from "../../core/index.js";

/** The code a phase whose root asks outside the named-value shape refuses under. */
export const SCHEMA_ROOT_NOT_NAMED_VALUES = "schema-root-not-named-values";

/** The subsystem this refusal names: the reading of the phase's own input schema. */
const SCHEMA_ROOT_ORIGIN = "workflow-human-form-schema";

/**
 * The one sentence a person reads, written for the person looking at the form.
 *
 * It names what the definition did rather than what the wire refuses, because the
 * remedy is in the definition and nowhere a participant can reach. The declared type is
 * deliberately not interpolated: `type` is author-written text, and a refusal that
 * echoed it would put an unbounded string where this console renders a fixed sentence.
 */
const SCHEMA_ROOT_DETAIL =
  "This phase's schema asks for a single value rather than the set of named fields an answer is submitted as, so its definition has to be corrected before anybody can answer it.";

/** The `type` this schema's root declares, where it is a record that declares one. */
function declaredRootType(inputSchema: unknown): string | undefined {
  if (typeof inputSchema !== "object" || inputSchema === null || Array.isArray(inputSchema)) {
    return undefined;
  }
  const declared = (inputSchema as Readonly<Record<string, unknown>>)["type"];
  return typeof declared === "string" ? declared : undefined;
}

/**
 * Whether this schema's root declares an answer the submit request cannot carry.
 *
 * False for a root that declares nothing — see the header: an undeclared root is not a
 * root that asked for the wrong thing.
 */
export function schemaRootAsksOutsideNamedValues(inputSchema: unknown): boolean {
  const declared = declaredRootType(inputSchema);
  return declared !== undefined && declared !== "object";
}

/**
 * The refusal such a phase carries, or nothing where its root can be answered at all.
 *
 * Composed here rather than at each surface so the two that render it — the run's form
 * and the definition preview beside it — say one thing, and so the code they render is
 * the constant above rather than a string spelled twice.
 */
export function schemaRootRefusal(
  inputSchema: unknown,
): NarrowedRefusal<typeof SCHEMA_ROOT_NOT_NAMED_VALUES> | undefined {
  return schemaRootAsksOutsideNamedValues(inputSchema)
    ? refuse(SCHEMA_ROOT_ORIGIN, SCHEMA_ROOT_NOT_NAMED_VALUES, SCHEMA_ROOT_DETAIL)
    : undefined;
}
