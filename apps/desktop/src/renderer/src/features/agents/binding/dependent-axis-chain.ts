// Which axes of a resolved chain (driver, model, effort) a published vocabulary vouches for.
// Each axis is valid only relative to its parent. Callers pass what the agent will run under,
// inherited axes included, because the daemon merges those in before it validates.

import type { AgentBindingSwitchTarget } from "@ai-sidekicks/contracts";

import {
  catalogCarriesEffortLevel,
  catalogCarriesModel,
  driverNamesOf,
  type DriverCatalogReading,
} from "./driver-catalog.js";

/**
 * The chain, parent first: the binding members a switch moves, less the two this rule does not
 * judge (`providerAccountId` and `outputSpeed`). The order is the order vocabularies are
 * published in and the order a form lists what is still needed.
 */
export type DependentAxis = Exclude<
  keyof AgentBindingSwitchTarget,
  "providerAccountId" | "outputSpeed"
>;
const DEPENDENT_AXES: readonly DependentAxis[] = ["driverName", "modelId", "effort"];

/** One resolved reading of the chain. Every axis is optional; absent differs from refused. */
export type ResolvedAxisChain = Partial<Record<DependentAxis, string>>;

/**
 * Which axes of this chain no published vocabulary carries, parent first. Only a settled axis
 * is judged, and it fails closed: an absent vocabulary, an unsettled parent, or an unread
 * catalog all answer no.
 */
export function findAxesOutsideCatalog(
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
