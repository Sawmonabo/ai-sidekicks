// The vocabulary one entity's record is written in: what a detail is handed, and
// what it may put on a row.
//
// WHY FACETS ARE DATA AND NOT NODES. Eleven detail components each declare the
// rows their kind carries. If a row were a `React.ReactNode` the eleven would each
// pick a formatter, and eleven pickings is eleven chances to reach for `toFixed`
// instead of `primitives/wire-figures.ts`. A facet is therefore a VALUE with a
// closed form, and `EntityRecord.tsx` is the only module that turns one into
// markup — which is the same chokepoint discipline the figures module itself is.
//
// WHY THE BUILDERS TAKE `unknown`. `ConsoleEntity.body` is
// `Readonly<Record<string, unknown>>` — a renderer-local extension point whose
// shape belongs to whichever view family registers the projector for that kind, and
// no family has registered one yet. So a detail reads a body member by NAME, and
// the name is this console's read-side expectation rather than a claim about a
// wire: where a registered contract member exists the detail quotes it verbatim
// (`membership.created`'s `role` and `identityHandle`, `channel.created`'s `name`,
// the repo / workspace / worktree lifecycle payload's `repoMountId` /
// `workspaceId` / `worktreeId` / `actor`, `RunStateChangeEvent`'s `runVersion` and
// `previousState`), and where the console owns the vocabulary itself it quotes its
// own (`bridge/growth-port.ts`'s artifact and navigation summaries). Nothing here
// invents a method string, an event type, or a wire member.
//
// AND WHY EVERY BUILDER HAS AN ABSENT ARM. A member the body does not carry is not
// a member whose value is empty. `Spec-023 §Console Design (Meridian)` rule 8 keeps
// those two apart, so a builder that cannot narrow its input renders the
// `not-checked` absence naming the member — never a blank cell, never a zero, and
// never a dash standing in for both.

import type { ConsoleEntity, SessionStore, useSessionDegradedCause } from "../../../store/index.js";
import { formatByteQuantity, formatClockTime, formatCount } from "../../../primitives/index.js";

/**
 * Why the session's projection is known-incomplete.
 *
 * Derived from the hook that answers it rather than restated: the closed set is
 * the store family's, it does not travel through the store's door as a type, and a
 * second union written here would be the mirrored closed set
 * `apps/desktop/AGENTS.md` rejects.
 */
export type ProjectionDegradedCause = NonNullable<ReturnType<typeof useSessionDegradedCause>>;

/**
 * What every per-kind detail is handed.
 *
 * It lives beside the facet vocabulary rather than beside the registry that
 * composes the eleven details, because the registry imports all eleven and all
 * eleven import this — putting the props there would close a cycle.
 */
export interface EntityDetailProps {
  /** The stored record, or `undefined` where the store holds none for this id. */
  readonly entity: ConsoleEntity | undefined;
  /** The id the deck addressed this pane with, wire-verbatim. */
  readonly entityId: string;
  /** The session store the record is read from. Details that compose read from it. */
  readonly sessionStore: SessionStore;
  /** `false` until the store's first read has answered. */
  readonly isInitialised: boolean;
  /** Set while the projection is known-incomplete; `undefined` while it is whole. */
  readonly degradedCause: ProjectionDegradedCause | undefined;
  /**
   * The pane this inspector was opened from, when the deck linked the two.
   *
   * A PROP and never a coupling: an inspector may be linked to a source pane, and
   * §4.2's Never list still requires every pane to be independently movable and
   * closable. Holding a handle on the source pane would make one of those two
   * false; holding its id makes the link a fact the record can state.
   */
  readonly linkedSourcePaneId: string | undefined;
}

/**
 * What a facet's value is, closed at three forms.
 *
 * Closed because the forms are the provenance signature rule 4 fixes — a value the
 * wire supplied is mono, a value the console computed is not, and a value that is
 * not there is neither. A fourth form would be a fourth provenance.
 */
export type EntityFacetValue =
  | { readonly form: "wire"; readonly text: string }
  | { readonly form: "derived"; readonly text: string }
  | { readonly form: "unrecorded"; readonly detail: string };

/** One labelled row of an entity's record. */
export interface EntityFacet {
  /** The member's name in the console's own words, not the body key. */
  readonly label: string;
  readonly value: EntityFacetValue;
}

/**
 * The sentence an absent member carries.
 *
 * One generator rather than thirty hand-written strings: the fact is the same
 * every time — the record the console holds does not carry this member — and a
 * fact restated thirty times drifts into thirty slightly different claims.
 */
function unrecorded(memberName: string): EntityFacetValue {
  return {
    form: "unrecorded",
    detail: `The record the console holds carries no ${memberName}. A member that has not been projected is not a member that is empty.`,
  };
}

/** Read one member of an entity's kind-specific body. `undefined` where absent. */
export function readBodyMember(entity: ConsoleEntity | undefined, memberName: string): unknown {
  return entity?.body?.[memberName];
}

/** A string the wire supplied — an id, a handle, a state name. Mono and verbatim. */
export function wireFacet(label: string, value: unknown, memberName: string): EntityFacet {
  return {
    label,
    value:
      typeof value === "string" && value.length > 0
        ? { form: "wire", text: value }
        : unrecorded(memberName),
  };
}

/** A whole number the wire supplied, grouped per locale by the figures chokepoint. */
export function countFacet(label: string, value: unknown, memberName: string): EntityFacet {
  return {
    label,
    value:
      typeof value === "number" && Number.isFinite(value)
        ? { form: "derived", text: formatCount(value) }
        : unrecorded(memberName),
  };
}

/** A count the console composed from what it holds. Always present, never mono. */
export function composedCountFacet(label: string, count: number): EntityFacet {
  return { label, value: { form: "derived", text: formatCount(count) } };
}

/**
 * A byte quantity, scaled by 1024 in the one module that scales bytes.
 *
 * Negative is refused rather than rendered: a byte count below zero is a defect in
 * whatever produced it, and a record that showed `-1 B` would be asserting a size.
 */
export function byteFacet(label: string, value: unknown, memberName: string): EntityFacet {
  return {
    label,
    value:
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? { form: "derived", text: formatByteQuantity(value).text }
        : unrecorded(memberName),
  };
}

/**
 * An instant, as a wall-clock reading.
 *
 * Wall clock rather than relative, and that is a budget decision as much as a
 * formatting one: a relative phrase is only true for an instant, so a record
 * carrying one would need something telling it when now is — and the console has
 * no timer (`Spec-023 §Console Design (Meridian)`, the budget rules).
 *
 * A string that does not parse takes the absent arm rather than the figures
 * module's em dash, because a dash beside a label reads as "there is none" and the
 * fact is that the console was handed something that is not an instant.
 */
export function instantFacet(label: string, value: unknown, memberName: string): EntityFacet {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return { label, value: unrecorded(memberName) };
  }
  return { label, value: { form: "derived", text: formatClockTime(value) } };
}

/**
 * An expiry, which has three answers rather than two.
 *
 * `Spec-023 §Console Design (Meridian)` §7.6 asks for "a verbatim expiry with an
 * explicit 'no expiry' label", so a member the projector set to `null` is a
 * decision that never lapses and says so — which is a different sentence from a
 * member nobody projected.
 */
export function expiryFacet(label: string, value: unknown, memberName: string): EntityFacet {
  if (value === null) {
    return { label, value: { form: "derived", text: "No expiry" } };
  }
  return instantFacet(label, value, memberName);
}

/**
 * How many entities of one kind this session attributes to a participant.
 *
 * Over `ConsoleEntity.attributedTo`, which the store TYPES — so this is a read of
 * the projection rather than a guess at a body member, and it is the one relation
 * the inspector can compose today without a projector having landed.
 */
export function countAttributedTo(
  entities: Readonly<Record<string, ConsoleEntity>>,
  participantId: string,
): number {
  return Object.values(entities).filter((entity) => entity.attributedTo === participantId).length;
}
