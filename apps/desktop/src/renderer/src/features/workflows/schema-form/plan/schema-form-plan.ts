// Walks a human phase's input schema into a form plan. Never refuses: a schema it cannot draw
// (`$ref`, tuple `items`, a nullable union, objects nested two deep) becomes the raw-editor
// fallback naming the member that forced it. A declared value no control could show, and a
// constraint requiring a member the level never declared, also fall back, decided here so
// nobody starts typing into a form whose answer can never be made valid.

import { encodeMemberPointer, type SchemaMemberPath } from "../schema-member-path.js";
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
 * Turn one input schema into the form the console draws for it. Total: an unreadable, empty or
 * out-of-set schema resolves to the raw arm.
 */
export function planSchemaForm(inputSchema: unknown): SchemaFormPlan {
  const schema = asRecord(inputSchema);
  // The root's shape is decided by `schema-root-shape.ts`; a root it refuses is not drawn.
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
    // A group carries this level's requiredness onto its legend as a scalar and a list do.
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
  // Last, against the controls actually drawn: a required name that reaches none is a finding on
  // the whole answer with nothing on screen to clear it.
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
 * Whether one declared value is one this leaf's control would display. A collection's value must
 * be a list of what its repeated control draws, judged by the item's own descriptor.
 */
function valueSuitsLeaf(leaf: SchemaLeafEntry, value: unknown): boolean {
  if (leaf.form === "field") {
    return valueSuitsField(leaf.field, value);
  }
  return Array.isArray(value) && value.every((entry) => valueSuitsField(leaf.list.item, entry));
}

/**
 * Whether a group's declared value is one its own controls could show. Every member of it must
 * reach a drawn child of a matching shape, or the accepted answer carries what the screen does
 * not show; a child the value says nothing about is not a gap.
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
  // The schema's `default` is what this control opens holding, so a value of another kind
  // would leave the control showing its empty state over an answer that already carries one.
  const declaredDefault = schema["default"];
  return declaredDefault !== undefined && !valueSuitsLeaf(leaf, declaredDefault)
    ? undrawableDefault(memberPath)
    : leaf;
}

/**
 * Which of the two leaf shapes a member schema draws as. The member's own declared value is
 * checked by the caller; the list item's is checked here, since one descriptor stands for every
 * entry.
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
    // A tuple, an array of objects or of arrays repeats something with no control.
    return outOfSet(memberPath);
  }
  // The item's declared value is what every added entry opens holding; the collection is the
  // member named because that is the control a person can see.
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
 * Whether a planned entry came back as the fallback. Widened to every entry form because both
 * planners return through it; `cause` is the discriminant no entry form carries.
 */
function isFallback(value: SchemaFormEntry | SchemaFallback): value is SchemaFallback {
  return "cause" in value;
}

/**
 * One level down: a group's own leaves, or the first fallback one of them forces.
 * `isRequired` is the enclosing level's reading of this group.
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
  // The whole schema goes raw, not just this group: there is no half-raw form, and a group drawn
  // beside a finding none of its controls can clear is the state this check prevents.
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
 * The fallback one level's own constraints force, or nothing where every name they can require
 * reaches a control that level drew. `enclosingPath` is empty at the root; the member is named by
 * its full path so a person learns which group lacks the control. Only the first name met in
 * schema order is named, since the rest are found again once it is declared.
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
