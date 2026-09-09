// The mapper: what a human phase's input schema turns into, and where it stops turning into
// one. The vocabulary it produces — the six kinds, the descriptors, the fallback causes — lives
// in `schema-fields.ts`; what one member schema DECLARES is read in `schema-declarations.ts`;
// this module is the walk between them.
//
// EVERYTHING ELSE FALLS BACK, AND NOTHING REFUSES. `$ref`, a tuple's positional
// `items`, a nullable union, an object nested two deep: each of them is a schema this
// mapper cannot draw richly, and the answer is the raw editor beside the schema rather
// than a phase nobody can answer. The fallback carries WHICH member sent it there,
// because "this form could not be drawn" with no member named is a sentence an author
// cannot act on.
//
// AND TWO OF THE FALLBACKS ARE ABOUT A FORM THAT WOULD HAVE DRAWN PERFECTLY. A declared
// value no control could display, and a constraint that can require a member the level it
// sits on never declared, both produce controls that render and an answer nobody can make
// valid — the first by seeding a value the control does not show, the second by reporting
// a finding no control on the screen can clear. Both are decided here, before the plan
// says "fields", because deciding them later means deciding them after somebody has
// started typing.
//
// THE CONSTRAINT READING IS MADE AT EVERY LEVEL THAT DRAWS CONTROLS, root and group alike,
// each against the members that level actually drew. One cause covers both depths and the
// member it names carries its full path, so the sentence a person reads says which group
// is short a control rather than only which key is.
//
// THE INPUT IS `unknown` BY CONSTRUCTION. A phase definition carries its config as an
// untyped record — the wire declares no shape for it — so every read here is a probe
// and a member that is not what it claims lands in the fallback like any other.

import { encodeMemberPointer, type SchemaMemberPath } from "../../../bridge/index.js";
import {
  asRecord,
  declaredType,
  descriptionOf,
  fieldDescriptor,
  fieldKindOf,
  labelOf,
  listItemDescriptor,
  requiredKeysOf,
} from "./schema-declarations.js";
import { membersConstraintsCanRequire } from "./schema-constraints.js";
import {
  leafKeyOf,
  memberKeyOf,
  type SchemaFallback,
  type SchemaFormEntry,
  type SchemaFormPlan,
  type SchemaLeafEntry,
  valueSuitsField,
} from "./schema-fields.js";
import { schemaRootAsksOutsideNamedValues } from "./schema-root-shape.js";

/**
 * Turn one input schema into the form the console draws for it.
 *
 * Total over every input: an unreadable schema, an empty one, and one carrying a member
 * outside the render set all resolve to the raw arm, which is what makes "never a
 * refusal" a property of the type rather than a promise in a comment.
 */
export function planSchemaForm(inputSchema: unknown): SchemaFormPlan {
  const schema = asRecord(inputSchema);
  // The root's own shape is `schema-root-shape.ts`'s reading and not a second one here:
  // that module decides which roots this console can answer at all, and a schema it
  // refuses must not also reach the raw editor.
  if (schema === undefined || schemaRootAsksOutsideNamedValues(inputSchema)) {
    return {
      shape: "raw",
      fallback: {
        cause: "root-not-an-object",
        memberPath: [],
        detail:
          "This phase asks for something other than a set of named answers, so it is answered as JSON.",
      },
    };
  }
  const properties = asRecord(schema["properties"]);
  if (properties === undefined || Object.keys(properties).length === 0) {
    return {
      shape: "raw",
      fallback: {
        cause: "no-members",
        memberPath: [],
        detail: "This phase's schema names no members, so there is nothing to draw a control for.",
      },
    };
  }
  const required = requiredKeysOf(schema);
  const entries: SchemaFormEntry[] = [];
  for (const [key, memberSchema] of Object.entries(properties)) {
    const child = asRecord(memberSchema);
    // One read of this level's `required` set, whichever shape the member turned out to
    // be: a group carries it onto its legend exactly as a scalar and a list carry it onto
    // their own.
    const isRequired = required.has(key);
    const planned =
      child !== undefined && declaredType(child) === "object"
        ? planGroup(child, [key], key, isRequired)
        : planLeaf(memberSchema, [key], key, isRequired);
    if (isFallback(planned)) {
      return { shape: "raw", fallback: planned };
    }
    entries.push(planned);
  }
  // LAST, BECAUSE IT IS ASKED OF THE CONTROLS THAT WERE ACTUALLY DRAWN. Every member the
  // root's own constraints can require has to reach one of them; a name that reaches none
  // is a finding reported against the whole answer with nothing on the screen to clear it.
  // The enclosing path is empty here — this is the depth-0 call of the check each drawn
  // group has already made of its own constraints.
  const undrawnConstraint = undrawnConstraintFallback(schema, [], entries);
  if (undrawnConstraint !== undefined) {
    return { shape: "raw", fallback: undrawnConstraint };
  }
  return { shape: "fields", entries };
}

/** The raw-editor answer for one member that could not be drawn. */
function outOfSet(memberPath: SchemaMemberPath): SchemaFallback {
  return {
    cause: "member-out-of-set",
    memberPath,
    detail: `The schema asks for ${encodeMemberPointer(memberPath)} in a shape this form cannot draw, so the whole answer is given as JSON instead.`,
  };
}

/** The raw-editor answer for a declared value the control at that member could not show. */
function undrawableDefault(memberPath: SchemaMemberPath): SchemaFallback {
  return {
    cause: "default-undrawable",
    memberPath,
    detail: `The schema declares a value for ${encodeMemberPointer(memberPath)} that these controls could not show, so the whole answer is given as JSON instead.`,
  };
}

/** The raw-editor answer for a constraint that can require a member nothing draws. */
function undrawableConstraint(memberPath: SchemaMemberPath): SchemaFallback {
  return {
    cause: "constraint-undrawable",
    memberPath,
    detail: `The schema can require ${encodeMemberPointer(memberPath)}, which it declares no member for, so the whole answer is given as JSON instead.`,
  };
}

/**
 * Whether one declared value is one this leaf's control would display.
 *
 * ONE PREDICATE AT BOTH LEVELS. A collection shows entries, so a declared value for one is
 * a list of what its repeated control draws — and an entry of another shape, or one outside
 * the enumeration that entry's control offers, is the same divergence one level in. Asked
 * of the ITEM's own descriptor rather than of its kind, so the members a repeated choice
 * offers are read exactly where a standalone one's are.
 */
function valueSuitsLeaf(leaf: SchemaLeafEntry, value: unknown): boolean {
  if (leaf.form === "field") {
    return valueSuitsField(leaf.field, value);
  }
  return Array.isArray(value) && value.every((entry) => valueSuitsField(leaf.list.item, entry));
}

/**
 * Whether a group's declared value is one its own controls could show, member by member.
 *
 * TOTAL OVER THE DECLARED VALUE AND NOT OVER THE GROUP. Every member of it has to reach a
 * control: a member naming no drawn child is a value the schema's own reading supplies to
 * the accepted answer and nothing on the screen accounts for, which is the divergence
 * this form exists to close, and a member of the wrong shape is that divergence with the
 * control visibly showing something else. A child the declared value says nothing about
 * is not a gap — it simply opens where it would have anyway.
 */
function groupDefaultIsDrawable(
  declared: Readonly<Record<string, unknown>>,
  entries: readonly SchemaLeafEntry[],
): boolean {
  return Object.entries(declared).every(([declaredKey, declaredValue]) => {
    const leaf = entries.find(
      (entry) => leafKeyOf(entry) === declaredKey && valueSuitsLeaf(entry, declaredValue),
    );
    return leaf !== undefined;
  });
}

/** One leaf — a control or an array of one — or the fallback the member forces. */
function planLeaf(
  memberSchema: unknown,
  memberPath: readonly string[],
  key: string,
  isRequired: boolean,
): SchemaLeafEntry | SchemaFallback {
  const schema = asRecord(memberSchema);
  if (schema === undefined) {
    return outOfSet(memberPath);
  }
  const leaf = planLeafShape(schema, memberPath, key, isRequired);
  if (isFallback(leaf)) {
    return leaf;
  }
  // ASKED OF THE LEAF THAT WAS JUST BUILT, and through the one predicate a group's own
  // declared value is read by: the schema's `default` is what this control opens holding,
  // so a value of another kind is a control rendering its empty state over an answer that
  // already carries something. Seeding it silently is how `{ type: "number",
  // default: "auto" }` sent a string nobody had seen and nobody could clear.
  const declaredDefault = schema["default"];
  return declaredDefault !== undefined && !valueSuitsLeaf(leaf, declaredDefault)
    ? undrawableDefault(memberPath)
    : leaf;
}

/**
 * Which of the two leaf shapes a member schema draws as.
 *
 * The MEMBER's own declared value is the caller's, because both shapes read it the same
 * way. The list ITEM's is read here, because it is the only value with no leaf of its own
 * to be asked about — one descriptor stands for every entry a person adds.
 */
function planLeafShape(
  schema: Readonly<Record<string, unknown>>,
  memberPath: readonly string[],
  key: string,
  isRequired: boolean,
): SchemaLeafEntry | SchemaFallback {
  const kind = fieldKindOf(schema);
  if (kind !== undefined) {
    return { form: "field", field: fieldDescriptor(schema, kind, memberPath, key, isRequired) };
  }
  if (declaredType(schema) !== "array") {
    return outOfSet(memberPath);
  }
  const items = asRecord(schema["items"]);
  const itemKind = items === undefined ? undefined : fieldKindOf(items);
  if (items === undefined || itemKind === undefined) {
    // A tuple's positional `items`, an array of objects, an array of arrays: each is a
    // repetition of something this form has no control for, so the array goes with it.
    return outOfSet(memberPath);
  }
  // The ITEM's own declared value, which is what every added entry opens holding. Its
  // control is the repeated one, so the same reading applies one level in — asked of the
  // entry's own descriptor, and the member named is the collection's, because that is the
  // control a person can see.
  const item = listItemDescriptor(items, itemKind, memberPath, key, isRequired);
  const declaredEntryValue = items["default"];
  if (declaredEntryValue !== undefined && !valueSuitsField(item, declaredEntryValue)) {
    return undrawableDefault(memberPath);
  }
  return {
    form: "list",
    list: {
      memberPath,
      label: labelOf(schema, key),
      description: descriptionOf(schema),
      isRequired,
      defaultValue: schema["default"],
      item,
    },
  };
}

/**
 * Whether a planned entry came back as the fallback rather than as something to draw.
 *
 * Widened to every entry form rather than to the leaf pair, because both planners return
 * through it — the group planner answers with a group or a fallback, and the leaf planner
 * with a field, a list, or one. The discriminant is `cause`, which no entry form carries.
 */
function isFallback(value: SchemaFormEntry | SchemaFallback): value is SchemaFallback {
  return "cause" in value;
}

/**
 * One level down: a group's own leaves, or the first fallback one of them forces.
 *
 * `isRequired` is the ENCLOSING level's reading of this group, taken the same way the leaf
 * planner takes it: a group is a member of the level above and its legend says so.
 */
function planGroup(
  schema: Readonly<Record<string, unknown>>,
  memberPath: readonly string[],
  key: string,
  isRequired: boolean,
): SchemaFormEntry | SchemaFallback {
  const properties = asRecord(schema["properties"]);
  if (properties === undefined || Object.keys(properties).length === 0) {
    return outOfSet(memberPath);
  }
  const required = requiredKeysOf(schema);
  const entries: SchemaLeafEntry[] = [];
  for (const [childKey, childSchema] of Object.entries(properties)) {
    const leaf = planLeaf(childSchema, [...memberPath, childKey], childKey, required.has(childKey));
    if (isFallback(leaf)) {
      return leaf;
    }
    entries.push(leaf);
  }
  const declaredDefault = schema["default"];
  if (declaredDefault !== undefined) {
    const declaredMembers = asRecord(declaredDefault);
    if (declaredMembers === undefined || !groupDefaultIsDrawable(declaredMembers, entries)) {
      return undrawableDefault(memberPath);
    }
  }
  // The group's OWN constraints, asked of the controls this group drew — the same reading
  // the root makes of its own, one level in. It sends the WHOLE schema to the raw editor
  // rather than only this group, because a group drawn beside a finding no control in it
  // can clear is the state this check exists to prevent, and there is no half-raw form.
  const undrawnConstraint = undrawnConstraintFallback(schema, memberPath, entries);
  if (undrawnConstraint !== undefined) {
    return undrawnConstraint;
  }
  return {
    form: "group",
    group: {
      memberPath,
      label: labelOf(schema, key),
      description: descriptionOf(schema),
      isRequired,
      entries,
      defaultValue: declaredDefault,
    },
  };
}

/** The key each drawn entry answers under at its own level, whichever form it took. */
function drawnMemberNames(entries: readonly SchemaFormEntry[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    const key = entry.form === "group" ? memberKeyOf(entry.group.memberPath) : leafKeyOf(entry);
    if (key !== undefined) {
      names.add(key);
    }
  }
  return names;
}

/**
 * The fallback one level's own constraints force, or nothing where every name they can
 * require reaches a control that level drew.
 *
 * ONE RULE AT BOTH DEPTHS, AND THE ROOT IS THE DEPTH-0 INSTANCE. `enclosingPath` is empty
 * at the root and is the group's path inside a group, which is the whole difference — the
 * member is named by its FULL path either way, so one cause covers both and a person
 * reading `/release/signedBy` is told which group is missing the control rather than only
 * which key.
 *
 * ONE NAME AND NOT THE SET, because the fallback shows a person one sentence and that
 * sentence names one member — the first met walking the schema as written, which is the
 * one an author reading their own document would look for first. The rest are the same
 * defect and are found again the moment this one is declared.
 */
function undrawnConstraintFallback(
  schema: Readonly<Record<string, unknown>>,
  enclosingPath: readonly string[],
  entries: readonly SchemaFormEntry[],
): SchemaFallback | undefined {
  const drawn = drawnMemberNames(entries);
  const undrawn = membersConstraintsCanRequire(schema).find((memberName) => !drawn.has(memberName));
  return undrawn === undefined ? undefined : undrawableConstraint([...enclosingPath, undrawn]);
}
