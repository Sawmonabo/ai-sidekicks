// The one rule both axis forms keep: which axes of a RESOLVED chain any published
// vocabulary actually vouches for.
//
// THE AXES ARE A CHAIN, AND THE CHAIN IS THE WHOLE POINT. A model belongs to one
// driver and an effort vocabulary is published per MODEL, so none of these three is
// valid on its own — each is valid only relative to the ones above it. Both forms
// that set these axes learned that, and each wrote its own half: the attach form
// checked the values a caller had ENTERED, the switch form checked the values in its
// DRAFT, and both left the inherited half unexamined — a definition's own model under
// an entered driver, an agent's own effort under a newly chosen model.
//
// AN UNEXAMINED INHERITED AXIS IS NOT AN ABSENT ONE. It is absent from the REQUEST,
// which the daemon reads as unchanged and merges back in before it validates; so the
// form enabled its action, the request went out short of the axis, and the refusal
// named a value the participant was never shown a problem with. That is the same
// defect on two surfaces, so it gets one rule and one module rather than a second
// loop that agrees with the first until it does not.
//
// THE SUBJECT IS THEREFORE WHAT THE AGENT WILL RUN UNDER, never what was typed. Each
// caller resolves its own chain — entry over definition, draft over binding — and
// hands the resolved reading here. This module holds no state, reads nothing, and
// composes no words: which values compose a chain belongs to the form that owns them,
// and what to CALL a refused axis belongs to the surface a person reads.
//
// WHAT IT REFUSES TO JUDGE, AND WHAT IT FAILS CLOSED ON. An axis nobody has settled
// is not unvouched — there is no value to vouch for, and a form that reported one
// would be blaming a field for being empty. A settled axis is judged against the
// vocabulary its parent publishes, and an ABSENT vocabulary, a parent that is itself
// unsettled, and an unread catalog all answer the same thing to that question: no.
// Membership is the test rather than presence, because a catalog read can move under
// a form nobody touched.

import {
  catalogCarriesEffortLevel,
  catalogCarriesModel,
  driverNamesOf,
  type DriverCatalogReading,
} from "./driver-catalog.js";

/**
 * The chain, parent first.
 *
 * Order is load-bearing twice over: it is the order a vocabulary is published in —
 * the catalog names drivers, a driver names models, a model names effort levels — and
 * it is the order a form lists what is still needed, so a person reads the cause
 * before the consequence.
 */
export const DEPENDENT_AXES = ["driverName", "modelId", "effort"] as const;
export type DependentAxis = (typeof DEPENDENT_AXES)[number];

/**
 * One resolved reading of the chain: what the agent would run under once submitted.
 *
 * Every axis is optional because every one of them legitimately has no value yet, and
 * an absent axis is a different answer from a refused one — see the header.
 */
export type ResolvedAxisChain = Partial<Record<DependentAxis, string>>;

/**
 * Which axes of this chain no published vocabulary carries, parent first.
 *
 * Every settled axis is judged, including one an unsettled parent leaves no
 * vocabulary for: an effort chosen against a model that has since been dropped is
 * exactly the entry this exists to catch, and calling it vouched because its parent
 * went missing would be the console excusing a value on the strength of a second
 * absence.
 */
export function unvouchedAxesOf(
  chain: ResolvedAxisChain,
  catalog: DriverCatalogReading | undefined,
): readonly DependentAxis[] {
  return DEPENDENT_AXES.filter((axis) => !vocabularyVouchesFor(axis, chain, catalog));
}

/** One axis against the vocabulary its parent publishes. An unread catalog answers no. */
function vocabularyVouchesFor(
  axis: DependentAxis,
  chain: ResolvedAxisChain,
  catalog: DriverCatalogReading | undefined,
): boolean {
  const value = chain[axis];
  if (value === undefined) {
    return true;
  }
  switch (axis) {
    case "driverName":
      return catalog !== undefined && driverNamesOf(catalog).includes(value);
    case "modelId":
      return catalogCarriesModel(catalog, chain.driverName, value);
    case "effort":
      return catalogCarriesEffortLevel(catalog, chain.driverName, chain.modelId, value);
  }
}
