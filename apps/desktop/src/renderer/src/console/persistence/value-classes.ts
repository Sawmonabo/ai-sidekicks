// The closed value-class enumeration the persistence write chokepoint enforces.
//
// `Spec-023 §Console Design (Meridian)` §Persistence on the renderer scheme:
// "The durable store therefore holds **UI state only** — a closed value-class
// enumeration the persistence layer's schema encodes, and a write outside it
// (message text, form values, paths, code, names, anything participant- or
// machine-authored) is a tripwire failure at the store's write chokepoint."
//
// The hard part is mechanical: how does a chokepoint tell an expansion set from a
// sentence? Two conjuncts do it, and neither alone would:
//
//   1. **A class, with a shape.** Each class below declares the structure its
//      value must have. There is no "arbitrary JSON" class, so a caller cannot
//      smuggle a body through by claiming a class that accepts anything.
//   2. **Every string is identifier-shaped.** Participant- and machine-authored
//      content is prose: it carries spaces, punctuation, and length. Identifiers
//      are bounded, whitespace-free, and drawn from a narrow charset. A value
//      whose strings all pass `IDENTIFIER_PATTERN` cannot be carrying a message,
//      a path, a name, or a line of code — and the moment someone tries, the
//      chokepoint refuses with a typed code rather than truncating or escaping.
//
// The rule is deliberately stricter than "no obvious prose". A filesystem path
// contains `/`, which the charset admits, so path-shaped strings are excluded by
// the CLASS shapes instead: no class below has a field that takes a path. Both
// conjuncts are load-bearing.
//
// A RECORD IS A VALUE AND AN ADDRESS, and both halves come through here. The
// partition and the key are written verbatim, so validating the value alone would
// leave a caller free to persist a sentence or a path in the key while handing
// the value check an ordinary boolean. `validatePersistedAddress` applies the same
// grammar to both components — minus the path separator, which the value side is
// only safe to admit because it has a class shape behind it and an address has
// none — and `measureRecordByteLength` is the one byte measurement every cap in
// this family counts through, over the whole record rather than over its value.
//
// Drafts are absent from this enumeration on purpose. Composer text, form values,
// paths, and code a participant typed and did not send are participant-authored
// content, and the only durable homes the corpus gives such content are the
// daemon's encrypted, PII-mapped stores (Spec-022). A draft lives in its window's
// memory for that window's lifetime — see `draft-store.ts`.
//
// ONE DECLARATION OF EACH CLOSED SET. The class names are written once, as the
// `as const` array below; the union is `(typeof …)[number]` and the validator
// table is keyed by that union. A validator with no enumerated class is an excess
// property and an enumerated class with no validator is a missing one, so the two
// halves cannot drift — which they could while the union and the array were two
// hand-maintained lists that only a reader ever compared. The refusal codes are
// declared the same way, once.

import { refuse, type ConsoleRefusal } from "../core/index.js";
import { SCHEME_PREFERENCES, isSchemePreference } from "../tokens/index.js";

/**
 * The classes of UI state the durable store admits. Closed, and the single source
 * for both the type and the validator table. Stable order: tests and the
 * diagnostics page read it as written.
 */
export const PERSISTED_VALUE_CLASSES = [
  "layout",
  "scroll-position",
  "selection",
  "pin",
  "expansion",
  "scheme",
  "keybinding",
] as const;

/** One admitted class. Derived from the enumeration, never restated beside it. */
export type PersistedValueClass = (typeof PERSISTED_VALUE_CLASSES)[number];

/**
 * The longest identifier the store admits. A UUID is 36 characters and a
 * namespaced command id is well under this; prose is not.
 */
export const IDENTIFIER_MAX_LENGTH = 128;

/**
 * The identifier charset: no whitespace, no quotes, no brackets. Chosen from what
 * the corpus's own identifiers actually use — UUIDs, dotted method and command
 * names, `kind:id` refs, chord strings like `$mod+Shift+P`.
 */
export const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z0-9._:@/#+$-]{1,128}$/;

/** True when a string is identifier-shaped and therefore not authored content. */
export function isIdentifierShaped(value: string): boolean {
  return value.length <= IDENTIFIER_MAX_LENGTH && IDENTIFIER_PATTERN.test(value);
}

/**
 * The one character an ADDRESS excludes that a value string may carry.
 *
 * The charset above admits `/` deliberately, and the header says why: a
 * path-shaped VALUE is excluded by the class shapes instead, because no admitted
 * class has a field that takes a path. An address has no class shape behind it —
 * `partition` and `key` are two bare strings the caller chooses — so the
 * exclusion the value side gets from its shape has to be made at the address
 * itself. The Windows separator needs no entry: `\` is outside the charset, so
 * `isIdentifierShaped` already refuses it.
 */
const PATH_SEPARATOR = "/";

/**
 * True when a string may name half of a record's address.
 *
 * Derived from the one grammar rather than declared as a second one: an address
 * component is an identifier that is additionally not path-shaped, so the charset
 * and the length ceiling are still written in exactly one place.
 */
function isAddressComponentShaped(component: string): boolean {
  return isIdentifierShaped(component) && !component.includes(PATH_SEPARATOR);
}

/** Why the chokepoint refused a write. Rendered verbatim; never swallowed. */
export const PERSISTENCE_REFUSAL_CODES = [
  "address-not-identifier-shaped",
  "value-class-unknown",
  "value-shape-invalid",
  "value-not-identifier-shaped",
  "value-too-large",
  "adapter-unavailable",
  "quota-exceeded",
] as const;

/** One refusal code. Derived, so the vocabulary is declared exactly once. */
export type PersistenceRefusalCode = (typeof PERSISTENCE_REFUSAL_CODES)[number];

/**
 * The subsystem name every refusal this family raises carries.
 *
 * `core/refusal.ts` gives `origin` as the field that lets a refusal surfacing
 * three layers from where it was raised still name its author. This is that name,
 * written once rather than spelled at each construction site.
 */
export const PERSISTENCE_REFUSAL_ORIGIN = "persistence";

/**
 * A typed refusal.
 *
 * The console's ONE refusal shape (`core/refusal.ts`), narrowed on `code` to the
 * closed union this family owns. Deliberately not a second refusal vocabulary:
 * that module's header states the arrangement — "each producer keeps its own
 * closed code union and widens into this shape at its boundary" — so a
 * persistence refusal satisfies `isConsoleRefusal` and renders through the same
 * three refusal renderings as every other one, instead of needing a translation
 * at every surface that wants to show two kinds of refusal at once.
 */
export interface PersistenceRefusal extends ConsoleRefusal {
  readonly code: PersistenceRefusalCode;
}

/**
 * Build one. THE constructor for this family — every refusal below and in the
 * three adapters comes through here, so `origin` is spelled once and no site can
 * ship a refusal that names nobody.
 *
 * Built by narrowing `core`'s `refuse` rather than by writing the same three
 * fields again. `refuse` types `code` as `string` because it serves every
 * family; this module knows its own closed vocabulary, so the spread re-narrows
 * it and the literal is written in exactly one place in the console.
 *
 * This import was type-only for one release of this file, to keep a runtime edge
 * out of `core/index.js` — whose barrel pulls `core/tripwires.ts`, whose module
 * body reads the build-time fixture gate — because the architecture tier
 * imported this module and declared no such gate. Both halves of that premise
 * are now gone: that tier reads source TEXT and imports no console module, and
 * it declares the gate its sibling tiers already did. A duplicated literal
 * outliving the constraint that caused it is how two sources of truth start.
 */
export function refusePersistence(
  code: PersistenceRefusalCode,
  detail: string,
): PersistenceRefusal {
  return { ...refuse(PERSISTENCE_REFUSAL_ORIGIN, code, detail), code };
}

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

// The rule the detail states is Spec-022's (participant- and machine-authored
// content has no durable home in the renderer); the identifier stays here, in a
// comment, because a governance ID never rides a runtime string.
function notIdentifier(where: string, value: string): PersistenceRefusal {
  return refusePersistence(
    "value-not-identifier-shaped",
    `${where} holds a string that is not identifier-shaped (${String(value.length)} chars). UI state carries identifiers; participant- and machine-authored content has no durable home in the renderer.`,
  );
}

function isPlainObject(
  value: PersistableValue,
): value is { readonly [key: string]: PersistableValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk a value and refuse the first string that is not identifier-shaped. Object
 * KEYS are checked too: a key is as good a smuggling channel as a value.
 *
 * `ancestors` holds the containers on the current descent, so a value that
 * reaches back into itself is refused as a shape fault rather than overflowing
 * the stack. The type says a persisted value is a tree, but this walk runs
 * before any other check on whatever an untyped boundary handed in, and a
 * cyclic object would otherwise take the whole renderer down inside a write
 * refusal. A container reached twice by two different paths — a shared leaf, no
 * cycle — is walked twice and admitted, which is why this is a descent stack and
 * not a visited set.
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
   * A deck layout: pane ids to a record of numbers (sizes, order) and booleans
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
  pin: recordOf(
    (value) =>
      value === "front" || value === "back"
        ? undefined
        : invalid('a pin tier is "front" or "back"'),
    "pin",
  ),
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
  keybinding: recordOf(
    (value) =>
      value === null || typeof value === "string"
        ? undefined
        : invalid("a binding is a chord identifier or null for explicitly unbound"),
    "keybinding",
  ),
};

/**
 * True when a string names one of the admitted classes.
 *
 * A narrowing guard rather than a bare `includes`, so the lookup below needs no
 * cast and a caller that has only a `string` — everything arriving across a
 * boundary the compiler does not see — can ask the same question the chokepoint
 * asks, through the same predicate.
 */
export function isPersistedValueClass(candidate: string): candidate is PersistedValueClass {
  return (PERSISTED_VALUE_CLASSES as readonly string[]).includes(candidate);
}

/**
 * The chokepoint's validator. Returns a refusal or `undefined`; it never
 * normalises, truncates, or repairs, because a store that silently fixes a write
 * hides the caller that made it.
 */
export function validatePersistedValue(
  valueClass: string,
  value: PersistableValue,
): PersistenceRefusal | undefined {
  if (!isPersistedValueClass(valueClass)) {
    return refusePersistence(
      "value-class-unknown",
      `"${valueClass}" is not one of the ${String(PERSISTED_VALUE_CLASSES.length)} UI-state value classes (${PERSISTED_VALUE_CLASSES.join(", ")})`,
    );
  }
  const shapeRefusal = SHAPE_VALIDATORS[valueClass](value);
  if (shapeRefusal !== undefined) {
    return shapeRefusal;
  }
  return everyStringIsIdentifierShaped(value, valueClass);
}

/**
 * The chokepoint's OTHER validator: the record's address.
 *
 * `partition` and `key` are written to the record verbatim, so a caller that
 * derived either from participant- or machine-authored input would put prose, a
 * path, or a name into durable storage while handing the value check a perfectly
 * ordinary boolean. Validating one half of a record and copying the other half
 * through is not a chokepoint, it is a chokepoint on one field.
 *
 * A code of its own rather than a reuse of `value-not-identifier-shaped`: the
 * store counts refusals BY CODE for the diagnostics surface, and an operator
 * reading a count that named values while every one of them was an address would
 * go and audit the wrong half of every write.
 *
 * Neither component is echoed, only its length and which half it is — the
 * discipline `notIdentifier` already keeps, because a refusal that quotes the
 * prose it refused has carried that prose one layer further out than the store
 * that stopped it.
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
    if (!isAddressComponentShaped(value)) {
      return refusePersistence(
        "address-not-identifier-shaped",
        `the record ${component} is not identifier-shaped (${String(value.length)} chars, ceiling ${String(IDENTIFIER_MAX_LENGTH)}, no path separator). A record address is an identifier; participant- and machine-authored content has no durable home in the renderer.`,
      );
    }
  }
  return undefined;
}

/**
 * THE byte measurement. Every cap the chokepoint applies is counted through this
 * one function, over the whole record rather than over its value alone.
 *
 * The address counts because it is stored: a cap that measured only the value
 * would let a caller spend the entire ceiling on the value and then a further
 * unbounded amount on the key beside it, and the key is the part an index holds a
 * second copy of.
 *
 * UTF-8 bytes rather than `String.length`, which counts UTF-16 code units. Today
 * every string that reaches here has already passed the ASCII-only identifier
 * grammar, so the two agree — which is exactly why the cheaper one would go
 * unnoticed if the charset ever widened, and a ceiling described in bytes would
 * quietly start admitting several times what it claims.
 */
export function measureRecordByteLength(
  partition: string,
  key: string,
  valueClass: string,
  value: PersistableValue,
): number {
  return (
    measureUtf8ByteLength(partition) +
    measureUtf8ByteLength(key) +
    measureUtf8ByteLength(valueClass) +
    measureUtf8ByteLength(JSON.stringify(value) ?? "")
  );
}

/**
 * The encoder the measurement above runs on. Stateless, so one serves the module
 * rather than one being minted per write.
 */
const UTF8_ENCODER = new TextEncoder();

function measureUtf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}
