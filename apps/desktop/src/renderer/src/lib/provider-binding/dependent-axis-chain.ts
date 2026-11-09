// Which axes of a resolved chain (provider, model, effort) a published vocabulary vouches for.
// Each axis is valid only relative to its parent. Callers pass what the agent will run under,
// inherited axes included, because the daemon merges those in before it validates.

import type { AgentBindingSwitchTarget } from "@ai-sidekicks/contracts/agent/provider-binding";

import {
  catalogCarriesEffortLevel,
  catalogCarriesModel,
  driverNamesOf,
  type DriverCatalogReading,
} from "./driver-catalog.js";

/**
 * The chain, parent first: the binding members a switch moves whose vocabulary hangs off the one
 * before. The order is the order vocabularies are published in and the order a form lists what
 * is still needed.
 */
export type DependentAxis = Extract<
  keyof AgentBindingSwitchTarget,
  "providerName" | "modelId" | "effort"
>;
const DEPENDENT_AXES: readonly DependentAxis[] = ["providerName", "modelId", "effort"];

/**
 * One resolved reading of the chain. Every axis is optional; absent differs from refused.
 * `largerWindow` says which of the model's rows is chosen, absent being its default window.
 */
export type ResolvedAxisChain = Partial<Record<DependentAxis, string>> & {
  readonly largerWindow?: boolean;
};

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
  const largerWindow = chain.largerWindow ?? false;
  switch (axis) {
    case "providerName":
      return catalog !== undefined && driverNamesOf(catalog).includes(value);
    case "modelId":
      return catalogCarriesModel(catalog, chain.providerName, { modelId: value, largerWindow });
    case "effort":
      return catalogCarriesEffortLevel(
        catalog,
        chain.providerName,
        chain.modelId === undefined ? undefined : { modelId: chain.modelId, largerWindow },
        value,
      );
  }
}
