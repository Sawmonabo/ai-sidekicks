// The closed value-class enumeration the persistence write chokepoint enforces. The durable
// store holds UI state only; a write outside the enumeration (message text, form values,
// paths, code, names, anything user- or machine-authored) is a tripwire failure.
//
// Two conjuncts tell an expansion set from a sentence, and neither alone would:
//
//   1. A class, with a shape. Each class declares the structure its value must have, and there
//      is no "arbitrary JSON" class, so a caller cannot smuggle a body through one.
//   2. Every string is identifier-shaped. The grammar lives in `lib/identifier-grammar.ts`;
//      this module applies it to every string a value carries, including object keys. A path
//      contains `/`, which the charset admits, so paths are excluded by the class shapes: no
//      class has a field that takes one.
//
// This module owns the closed set, each class's shape, the walk that applies the grammar, and
// the byte measurement over a whole record. The refusal vocabulary is in
// `persistence-refusals.ts`, because both adapters raise refusals and the grammar also settles
// record addresses, which have no class.
//
// Drafts are absent on purpose: composer text is user-authored content, and its only durable
// homes are the daemon's encrypted stores. A draft lives in window memory (`draft-store.ts`).
// The class names are one `as const` array, the union derives from it, and the validator table
// is keyed by the union, so the two halves cannot drift.

import { isWireRecord } from "@renderer/lib/wire-record.js";
import { SCHEME_PREFERENCES, isSchemePreference } from "@renderer/styles/tokens.js";
import {
  IDENTIFIER_MAX_LENGTH,
  isIdentifierShaped,
  isSingleNameIdentifierShaped,
} from "@renderer/lib/identifier-grammar.js";
import { measureUtf8ByteLength } from "@renderer/lib/utf8-byte-length.js";
import { refusePersistence, type PersistenceRefusal } from "./persistence-refusals.js";

/**
 * The classes of UI state the durable store admits. Closed, and the single source
 * for both the type and the validator table.
 */
export const PERSISTED_VALUE_CLASSES = [
  "layout",
  "scroll-position",
  "selection",
  "pin",
  "expansion",
  "scheme",
  "preference",
] as const;

/** One admitted class. Derived from the enumeration, never restated beside it. */
export type PersistedValueClass = (typeof PERSISTED_VALUE_CLASSES)[number];

/** Values a persisted record may hold, before class validation. */
export type PersistableValue =
  | string
  | number
  | boolean
  | null
  | readonly PersistableValue[]
  | { readonly [key: string]: PersistableValue };

type ShapeValidator = (value: PersistableValue) => PersistenceRefusal | undefined;

function invalid(detail: string): PersistenceRefusal {
  return refusePersistence("value-shape-invalid", detail);
}

// User- and machine-authored content has no durable home in the renderer.
function notIdentifier(where: string, value: string): PersistenceRefusal {
  return refusePersistence(
    "value-not-identifier-shaped",
    `${where} holds a string that is not identifier-shaped ` +
      `(${String(value.length)} chars). UI state carries identifiers; user- ` +
      `and machine-authored content has no durable home in the renderer.`,
  );
}

/**
 * The record rule from `lib/wire-record.ts`, re-narrowed over the `PersistableValue` tree.
 * Both callers hand each member back to a `PersistableValue` walk, which
 * `Readonly<Record<string, unknown>>` cannot feed.
 */
function isPlainObject(
  value: PersistableValue,
): value is { readonly [key: string]: PersistableValue } {
  return isWireRecord(value);
}

/**
 * Walks a value and refuses the first string that is not identifier-shaped. Object keys are
 * checked too, since a key is as good a smuggling channel as a value.
 *
 * `ancestors` holds the containers on the current descent, so a cyclic value is refused as a
 * shape fault rather than overflowing the stack; this walk runs first, on whatever an untyped
 * boundary handed in. A container reached twice by different paths is walked twice and
 * admitted, which is why this is a descent stack and not a visited set.
 */
function everyStringIsIdentifierShaped(
  value: PersistableValue,
  path: string,
  ancestors: ReadonlySet<object> = new Set(),
): PersistenceRefusal | undefined {
  if (typeof value === "string") {
    return isIdentifierShaped(value) ? undefined : notIdentifier(path, value);
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (ancestors.has(value)) {
    return invalid(
      `${path} reaches back into one of its own containers; a persisted value is a tree`,
    );
  }
  const descent: ReadonlySet<object> = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      const refusal = everyStringIsIdentifierShaped(element, `${path}[${String(index)}]`, descent);
      if (refusal !== undefined) {
        return refusal;
      }
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    for (const [key, member] of Object.entries(value)) {
      if (!isIdentifierShaped(key)) {
        return notIdentifier(`${path}.<key>`, key);
      }
      const refusal = everyStringIsIdentifierShaped(member, `${path}.${key}`, descent);
      if (refusal !== undefined) {
        return refusal;
      }
    }
    return undefined;
  }
  return undefined;
}

function recordOf(elementCheck: ShapeValidator, label: string): ShapeValidator {
  return (value) => {
    if (!isPlainObject(value)) {
      return invalid(`${label} must be an object keyed by identifier`);
    }
    for (const member of Object.values(value)) {
      const refusal = elementCheck(member);
      if (refusal !== undefined) {
        return refusal;
      }
    }
    return undefined;
  };
}

const isFiniteNumber: ShapeValidator = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? undefined
    : invalid("expected a finite number");

const isIdentifierString: ShapeValidator = (value) =>
  typeof value === "string" ? undefined : invalid("expected an identifier string");

/**
 * One validator per admitted class, keyed by the derived union so the compiler
 * checks the table against the enumeration in both directions.
 */
const SHAPE_VALIDATORS: Readonly<Record<PersistedValueClass, ShapeValidator>> = {
  /**
   * A pane layout: pane ids to a record of numbers (sizes, order) and booleans
   * (collapsed). Deliberately no free-form member — a layout that needed one
   * would be carrying something that is not layout.
   */
  layout: recordOf(
    recordOf(
      (member) =>
        typeof member === "number" || typeof member === "boolean" || typeof member === "string"
          ? undefined
          : invalid("a layout member is a number, a boolean, or an identifier"),
      "layout entry",
    ),
    "layout",
  ),
  "scroll-position": recordOf(isFiniteNumber, "scroll-position"),
  selection: recordOf(isIdentifierString, "selection"),
  pin: recordOf((value) => (value === "pinned" ? undefined : invalid('a pin is "pinned"')), "pin"),
  expansion: (value) => {
    if (!Array.isArray(value)) {
      return invalid("expansion is an array of entity identifiers");
    }
    for (const element of value) {
      if (typeof element !== "string") {
        return invalid("expansion holds entity identifiers");
      }
    }
    return undefined;
  },
  scheme: (value) =>
    isSchemePreference(value)
      ? undefined
      : invalid(`scheme is one of ${SCHEME_PREFERENCES.join(", ")}`),
  /**
   * A settings record: identifier-named switches to booleans, and nothing else. Booleans only,
   * or this becomes the arbitrary-JSON class the enumeration exists to refuse: a string would
   * carry a name, path or sentence, and a number would be a threshold, which is a constant.
   */
  preference: recordOf(
    (value) => (typeof value === "boolean" ? undefined : invalid("a preference is on or off")),
    "preference",
  ),
};

/**
 * True when a string names one of the admitted classes. A narrowing guard, so a caller holding
 * only a `string` from across a boundary asks the same question the chokepoint does.
 */
export function isPersistedValueClass(candidate: string): candidate is PersistedValueClass {
  return (PERSISTED_VALUE_CLASSES as readonly string[]).includes(candidate);
}

/**
 * The chokepoint's validator. Returns a refusal or `undefined`; it never normalizes, truncates
 * or repairs, since that would hide the caller that made the bad write.
 */
export function validatePersistedValue(
  valueClass: string,
  value: PersistableValue,
): PersistenceRefusal | undefined {
  if (!isPersistedValueClass(valueClass)) {
    return refusePersistence(
      "value-class-unknown",
      `"${valueClass}" is not one of the ${String(PERSISTED_VALUE_CLASSES.length)} ` +
        `UI-state value classes (${PERSISTED_VALUE_CLASSES.join(", ")})`,
    );
  }
  const shapeRefusal = SHAPE_VALIDATORS[valueClass](value);
  if (shapeRefusal !== undefined) {
    return shapeRefusal;
  }
  return everyStringIsIdentifierShaped(value, valueClass);
}

/**
 * The byte measurement every cap the chokepoint applies is counted through, over the whole
 * record rather than its value alone: the address is stored too, and an index holds a second
 * copy of the key.
 *
 * UTF-8 bytes, not `String.length` (UTF-16 code units). Every string here has passed the
 * ASCII-only identifier grammar so the two agree today, but a byte ceiling counting code units
 * would silently admit several times its claim if the charset widened.
 */
export function measureRecordByteLength(
  partition: string,
  key: string,
  valueClass: string,
  value: unknown,
): number {
  return (
    measureUtf8ByteLength(partition) +
    measureUtf8ByteLength(key) +
    measureUtf8ByteLength(valueClass) +
    measureUtf8ByteLength(JSON.stringify(value) ?? "")
  );
}

/**
 * The chokepoint's address validator. `partition` and `key` are written verbatim, so a caller
 * deriving either from authored input would put prose or a path into durable storage beside an
 * ordinary boolean value.
 *
 * It has its own refusal code, since the store counts refusals by code and a count naming
 * values for what were addresses would send the person to audit the wrong half. Neither
 * component is echoed, only its length and which half it is.
 */
export function validatePersistedAddress(
  partition: string,
  key: string,
): PersistenceRefusal | undefined {
  const components = [
    ["partition", partition],
    ["key", key],
  ] as const;
  for (const [component, value] of components) {
    if (!isSingleNameIdentifierShaped(value)) {
      return refusePersistence(
        "address-not-identifier-shaped",
        `the record ${component} is not identifier-shaped (${String(value.length)} chars, ` +
          `ceiling ${String(IDENTIFIER_MAX_LENGTH)}, no path separator). A record address is an ` +
          `identifier; user- and machine-authored content has no durable home in the renderer.`,
      );
    }
  }
  return undefined;
}
