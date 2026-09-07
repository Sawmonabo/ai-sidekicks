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
//   2. **Every string is identifier-shaped.** That grammar — the charset, the
//      ceiling, and the address exclusion built on it — lives one module down in
//      `identifier-grammar.ts`; this module applies it to every string a value
//      carries, including its object keys.
//
// The rule is deliberately stricter than "no obvious prose". A filesystem path
// contains `/`, which the charset admits, so path-shaped strings are excluded by
// the CLASS shapes instead: no class below has a field that takes a path. Both
// conjuncts are load-bearing.
//
// WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT. The closed set, the shape each of
// its classes declares, the walk that applies the grammar to a value, and the one
// byte measurement over a whole record — one subject, the VALUE, from four angles.
// The refusal vocabulary every one of those raises is declared below them all in
// `refusals.ts`, and the string grammar in `identifier-grammar.ts`, because each is
// consumed by modules this one never sees: both adapters raise refusals, and the
// grammar settles record ADDRESSES, which have no class and so no shape.
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
// hand-maintained lists that only a reader ever compared.

import { isWireRecord } from "../core/index.js";
import { SCHEME_PREFERENCES, isSchemePreference } from "../tokens/index.js";
import { isIdentifierShaped, validatePersistedAddress } from "./identifier-grammar.js";
import {
  PERSISTENCE_REFUSAL_CODES,
  PERSISTENCE_REFUSAL_ORIGIN,
  refusePersistence,
  type PersistenceRefusal,
} from "./refusals.js";

// Re-exported rather than only imported: the co-located `value-classes.test.ts`
// reaches these four through this module, which is the surface it has always read
// them from. Nothing else re-exports through here — every other consumer in this
// family imports the module that owns the symbol, and the identifier CEILING is not
// among them at all: it is a bound, so its home is `core/constants.ts` and the test
// reads it from the door it already reads `isConsoleRefusal` through.
export {
  PERSISTENCE_REFUSAL_CODES,
  PERSISTENCE_REFUSAL_ORIGIN,
  refusePersistence,
  validatePersistedAddress,
};

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

// The rule the detail states is Spec-022's (participant- and machine-authored
// content has no durable home in the renderer); the identifier stays here, in a
// comment, because a governance ID never rides a runtime string.
function notIdentifier(where: string, value: string): PersistenceRefusal {
  return refusePersistence(
    "value-not-identifier-shaped",
    `${where} holds a string that is not identifier-shaped (${String(value.length)} chars). UI state carries identifiers; participant- and machine-authored content has no durable home in the renderer.`,
  );
}

/**
 * The record rule, re-narrowed over the tree this family walks.
 *
 * The decision — an object, not `null`, not an array — is `core/wire-record.ts`'s and
 * is not restated here. What this adds is the narrowing, and it is load-bearing: both
 * callers below go straight on to `Object.entries` / `Object.values` and hand each
 * member back to a `PersistableValue` walk, which `Readonly<Record<string, unknown>>`
 * cannot feed. A local that only narrows is one line and no second rule; a cast at
 * each caller would be the same claim made twice with nothing checking either.
 */
function isPlainObject(
  value: PersistableValue,
): value is { readonly [key: string]: PersistableValue } {
  return isWireRecord(value);
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
  /**
   * A settings record: identifier-named switches to booleans, and nothing else.
   *
   * BOOLEANS ONLY, which is what keeps this from becoming the arbitrary-JSON class
   * the enumeration exists to refuse. A preference that needed a string would be
   * carrying a name, a path, or a sentence — the three things Spec-022 gives no
   * durable home in the renderer — and a preference that needed a number would be a
   * threshold, which is a constant with a rationale rather than a stored value.
   */
  preference: recordOf(
    (value) => (typeof value === "boolean" ? undefined : invalid("a preference is on or off")),
    "preference",
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
 * THE byte measurement. Every cap the chokepoint applies is counted through this
 * one function, over the whole record rather than over its value alone.
 *
 * It sits with the value type it serialises rather than in a module of its own:
 * `JSON.stringify` over a `PersistableValue` is the measurement, and a module
 * holding the ruler while the thing being measured is declared next door would be
 * two files for one fact.
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
 * The encoder the measurement below runs on. Stateless, so one serves every caller
 * rather than one being minted per call — which is what a second implementation did.
 */
const UTF8_ENCODER = new TextEncoder();

/**
 * How many bytes a string occupies once encoded, for every cap in this console.
 *
 * `apps/desktop/AGENTS.md` §Chokepoints: one byte-measurement function serves every
 * cap. It is published rather than module-private because a second cap now exists —
 * the run controls bound a cancellation reason exactly as the engine bounds a park
 * cause — and the two measured the same sentence through two functions until this
 * line. They agreed on ASCII, which is the whole hazard: the first surrogate-pair or
 * normalisation rule either of them grew would have moved one cap and not the other.
 *
 * UTF-8 bytes rather than `String.length`, which counts UTF-16 code units — a cap
 * counted in code units refuses a shorter sentence in one script than in another.
 */
export function measureUtf8ByteLength(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}
