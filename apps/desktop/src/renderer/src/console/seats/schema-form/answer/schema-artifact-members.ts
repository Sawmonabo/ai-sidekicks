// Which of a composed answer's values are ARTIFACTS, so the submission can carry them
// where the contract says attachments go.
//
// THE CARRIER IS NOT THE FIELD. A human phase's submit request carries the answer as
// `fields` and its attachments as `attachmentArtifactIds` beside it, and the second is
// not decoration: the daemon resolves those ids, persists each one as an artifact
// reference among the phase's outputs, and reports an attachment it could not resolve in
// the position it was declared in. An artifact id that travelled only as an ordinary
// value in `fields` reaches none of that — it is a string in a record, indistinguishable
// from an answer somebody typed — so the value is carried in BOTH places: keyed in
// `fields`, because that is what the phase asked for and what its schema is checked
// against, and listed in the carrier, because that is where the attachment rules are.
//
// THE ORDER IS THE SCHEMA'S, NOT THE ANSWER'S. The carrier's own rule is that an
// attachment is reported in its declared position, so the walk is over the SCHEMA — the
// members in the order the schema names them, and a nested object's members in the order
// that object names them — rather than over the answer, whose key order is whatever
// composed it.
//
// AND IT IS THE SCHEMA RATHER THAN THE DRAWN PLAN, WHICH IS THE CORRECTION. This read the
// mapper's plan once, on the reasoning that the mapper already knows which members are
// artifact fields. That reasoning holds for a schema the mapper can draw and fails for
// every schema it cannot: ONE member outside the render set — an object nested two levels
// deep, a tuple's positional `items`, a nullable union — sends the WHOLE form to the raw
// editor, and the plan then names no members at all. The artifact members beside that one
// are still declared, still answerable, and still attachments; a plan-shaped walk handed
// back an empty carrier for them and the ids travelled as ordinary strings. So discovery
// is off the authored shape and the render set constrains only what is DRAWN. What is
// still the mapper's is the reading of one member: `fieldKindOf` decides what an artifact
// declaration is, here and in the plan, so the two cannot disagree about it.
//
// THE SCHEMA AND THE ANSWER ARE WALKED TOGETHER, because half of the declared positions
// exist only in the answer. A member's own path is the schema's, but an artifact under an
// array of objects sits at an INDEX, and how many there are is a fact about what somebody
// composed — so a discovery pass that yielded paths on its own could not address one, and
// would have to either invent an index or leave that shape out. Walking both settles it:
// each declared member is asked of the value at it, an array is asked of every entry it
// holds, and declaration order is preserved because the recursion follows the schema.
//
// The walk terminates on the schema's own depth: an input schema is a document the wire
// delivered — a parsed JSON tree — so it holds no cycle for this to follow.
//
// AND THREE DECLARATION SHAPES ARE OUT OF REACH, stated rather than left to be found. A
// member reached through a `$ref` needs a resolver this console does not have and the
// mapper does not either; one declared inside `oneOf` / `anyOf` / `allOf` describes
// alternatives rather than a position; and one described by `additionalProperties`
// declares a shape for keys only the ANSWER names, so a carrier built from it would be
// ordered by whatever composed the answer — which is the one ordering the
// unresolved-attachment report cannot be addressed by. An id declared only one of those
// three ways travels in `fields` and reaches no attachment rule, and closing that is a
// change to what the carrier's ORDER means rather than another arm here.
//
// AN UNANSWERED MEMBER CONTRIBUTES NOTHING, and no member contributes twice on its own
// account: two members naming one artifact are two attachments, because two controls
// asked for one and both were answered. Nothing here de-duplicates — a rule that dropped
// the second would be this walk deciding that one of the phase's own questions did not
// count.

import type { SchemaFormAnswer } from "./schema-answer-shape.js";
import { asRecord, fieldKindOf } from "../plan/schema-declarations.js";
import type { SchemaFieldKind } from "../plan/schema-fields.js";

/**
 * The one control whose value IS an artifact reference.
 *
 * Bound to the vocabulary's own type rather than compared as a bare string, so renaming
 * the kind fails to compile here instead of silently emptying every carrier.
 */
const ARTIFACT_FIELD_KIND: SchemaFieldKind = "artifact-reference";

/** One answered artifact id, or nothing where that member was left alone. */
function answeredArtifactId(value: unknown): string | undefined {
  // Wire-verbatim and never trimmed: an artifact id is opaque, so the only reading this
  // makes is whether anything was answered at all. The text controls write the empty
  // string when a person clears one, which is that same "nothing".
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Every artifact id one declared member holds, in the order its own schema declares them.
 *
 * Three arms, and they are asked in this order for one reason each. An ARTIFACT
 * declaration is asked first because it is the bottom of the walk and the mapper's own
 * reading answers it outright — an enumerated string is a choice control to the mapper and
 * is therefore not an artifact here either, which is exactly the agreement reusing that
 * predicate buys. A schema declaring `properties` is walked as named members whether or
 * not it also said `type: "object"`, because the raw editor accepts what the schema
 * accepts and a member the mapper would have refused to draw is still one somebody can
 * answer. An `items` declaration is walked as the entries the ANSWER holds, which is the
 * only place their positions exist.
 */
function artifactIdsUnder(memberSchema: unknown, answeredValue: unknown): readonly string[] {
  const schema = asRecord(memberSchema);
  if (schema === undefined) {
    return [];
  }
  if (fieldKindOf(schema) === ARTIFACT_FIELD_KIND) {
    const answered = answeredArtifactId(answeredValue);
    return answered === undefined ? [] : [answered];
  }
  const properties = asRecord(schema["properties"]);
  if (properties !== undefined) {
    // Read as a record HERE rather than trusted: a person editing JSON can put a string
    // where the schema declared an object, and walking into one by key would answer for
    // members that cannot be there.
    const answeredMembers = asRecord(answeredValue);
    return Object.entries(properties).flatMap(([key, childSchema]) =>
      artifactIdsUnder(childSchema, answeredMembers?.[key]),
    );
  }
  const entrySchema = schema["items"];
  if (entrySchema === undefined || !Array.isArray(answeredValue)) {
    return [];
  }
  // Entries keep their own order inside the carrier for the reason the members do:
  // position is what the unresolved-attachment report is addressed by.
  return (answeredValue as readonly unknown[]).flatMap((entry) =>
    artifactIdsUnder(entrySchema, entry),
  );
}

/**
 * The attachment ids this answer carries, in the order its schema declares them.
 *
 * Empty where the phase asks for no artifact at all, which is the common case and the
 * one the submit surface omits the carrier for — and empty for a schema that is not a
 * record, or declares no members, since neither names an artifact anywhere.
 */
export function attachmentArtifactIdsIn(
  inputSchema: unknown,
  answer: SchemaFormAnswer,
): readonly string[] {
  return artifactIdsUnder(inputSchema, answer);
}
