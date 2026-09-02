// Why this family refuses, and the one constructor that says so.
//
// The closed refusal vocabulary is declared here, below every module that raises
// one: the two adapters, the identifier grammar, the value-class table, and the
// write chokepoint all construct refusals, and three of those four are things the
// vocabulary would otherwise have to import back from. A code union that lived
// beside any one of its producers would make the family's lowest module depend on
// one of its highest.
//
// ONE DECLARATION OF THE CLOSED SET. The codes are written once, as the `as const`
// array below; the union is `(typeof …)[number]`, so the chokepoint's caller-fault
// table is checked against this list in both directions and a new code does not
// compile until somebody has decided how it is treated.

import { refuse, type ConsoleRefusal } from "../core/index.js";

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
 * Build one. THE constructor for this family — every refusal in the grammar, the
 * value-class table, the chokepoint, and the three adapters comes through here, so
 * `origin` is spelled once and no site can ship a refusal that names nobody.
 *
 * Built by narrowing `core`'s `refuse` rather than by writing the same three
 * fields again. `refuse` types `code` as `string` because it serves every
 * family; this module knows its own closed vocabulary, so the spread re-narrows
 * it and the literal is written in exactly one place in the console.
 *
 * This import was type-only for one release of this vocabulary, to keep a runtime
 * edge out of `core/index.js` — whose barrel pulls `core/tripwires.ts`, whose
 * module body reads the build-time fixture gate — because the architecture tier
 * imported the module that then held it and declared no such gate. Both halves of
 * that premise are now gone: that tier reads source TEXT and imports no console
 * module, and it declares the gate its sibling tiers already did. A duplicated
 * literal outliving the constraint that caused it is how two sources of truth
 * start.
 */
export function refusePersistence(
  code: PersistenceRefusalCode,
  detail: string,
): PersistenceRefusal {
  return { ...refuse(PERSISTENCE_REFUSAL_ORIGIN, code, detail), code };
}
