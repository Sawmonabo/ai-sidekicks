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
// attachment is reported in its declared position, so the walk is over the PLAN — the
// members in the order the schema names them, and a group's members in the order that
// group names them — rather than over the answer, whose key order is whatever composed
// it. That is also why this reads the mapper's plan rather than the schema directly: the
// mapper already knows which members are artifact fields and which are repeated ones,
// and a second walk would be a second answer to that.
//
// AND IT IS THE MAPPER'S PLAN RATHER THAN THE FORM'S ARM. A form whose schema could not
// be COMPILED is answered in the raw editor even though its members are all drawable, so
// the arm on screen says nothing about which members are artifacts — the plan does. A
// raw answer therefore contributes exactly what its document carries at the artifact
// members' own paths, and a schema the mapper could not map at all names no artifact
// member and so contributes nothing.
//
// AN UNANSWERED MEMBER CONTRIBUTES NOTHING, and no member contributes twice on its own
// account: two members naming one artifact are two attachments, because two controls
// asked for one and both were answered. Nothing here de-duplicates — a rule that dropped
// the second would be this walk deciding that one of the phase's own questions did not
// count.

import { listAt, memberAt, type SchemaFormAnswer } from "./schema-answer.js";
import type { SchemaFieldKind, SchemaLeafEntry } from "./schema-fields.js";
import { planSchemaForm } from "./schema-form-plan.js";

/**
 * The one control whose value IS an artifact reference.
 *
 * Bound to the vocabulary's own type rather than compared as a bare string, so renaming
 * the kind fails to compile here instead of silently emptying every carrier.
 */
const ARTIFACT_FIELD_KIND: SchemaFieldKind = "artifact-reference";

/** One answered artifact id, or nothing where that control was left alone. */
function answeredArtifactId(value: unknown): string | undefined {
  // Wire-verbatim and never trimmed: an artifact id is opaque, so the only reading this
  // makes is whether anything was answered at all. The text controls write the empty
  // string when a person clears one, which is that same "nothing".
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The artifact ids one leaf holds, in the order that leaf holds them. */
function artifactIdsInLeaf(leaf: SchemaLeafEntry, answer: SchemaFormAnswer): readonly string[] {
  if (leaf.form === "field") {
    if (leaf.field.kind !== ARTIFACT_FIELD_KIND) {
      return [];
    }
    const answered = answeredArtifactId(memberAt(answer, leaf.field.memberPath));
    return answered === undefined ? [] : [answered];
  }
  if (leaf.list.item.kind !== ARTIFACT_FIELD_KIND) {
    return [];
  }
  // A repeated artifact control is a list of attachments, and its entries keep their own
  // order inside the carrier for the reason the members do: position is what the
  // unresolved-attachment report is addressed by.
  return listAt(answer, leaf.list.memberPath)
    .map((entry) => answeredArtifactId(entry))
    .filter((entry): entry is string => entry !== undefined);
}

/**
 * The attachment ids this answer carries, in the order its schema declares them.
 *
 * Empty where the phase asks for no artifact at all, which is the common case and the
 * one the submit surface omits the carrier for.
 */
export function attachmentArtifactIdsIn(
  inputSchema: unknown,
  answer: SchemaFormAnswer,
): readonly string[] {
  const plan = planSchemaForm(inputSchema);
  if (plan.shape !== "fields") {
    return [];
  }
  return plan.entries.flatMap((entry) =>
    entry.form === "group"
      ? entry.group.entries.flatMap((leaf) => artifactIdsInLeaf(leaf, answer))
      : artifactIdsInLeaf(entry, answer),
  );
}
