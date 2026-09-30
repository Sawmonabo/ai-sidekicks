// The driver catalog reads (`driver.listModels`, `driver.listCapabilities`) and the selectors
// every axis control asks of them. The two are read together, all or nothing, because a
// partial catalog would read as "this provider has no models". Effort levels are per model,
// and an absent list (`undefined`) is a different answer from an empty one.

import type {
  DriverCapabilityFlag,
  ListCapabilitiesResult,
  ListModelsResult,
  ProviderModel,
} from "@ai-sidekicks/contracts";

/** Both catalog reads, held together because no axis control can use one alone. */
export interface DriverCatalogReading {
  readonly models: ListModelsResult;
  readonly capabilities: ListCapabilitiesResult;
}

/** The driver names the catalog answered for, in the daemon's own order. */
export function driverNamesOf(catalog: DriverCatalogReading): readonly string[] {
  return catalog.models.drivers.map((report) => report.driverName);
}

/** One driver's models. Empty where the catalog named no such driver. */
export function modelsFor(
  catalog: DriverCatalogReading,
  driverName: string | undefined,
): readonly ProviderModel[] {
  if (driverName === undefined) {
    return [];
  }
  return catalog.models.drivers.find((report) => report.driverName === driverName)?.models ?? [];
}

/**
 * One model's effort vocabulary. `undefined` means the model publishes none, so a form shows
 * no effort control rather than an empty select.
 */
export function effortLevelsFor(
  catalog: DriverCatalogReading,
  driverName: string | undefined,
  modelId: string | undefined,
): readonly string[] | undefined {
  if (modelId === undefined) {
    return undefined;
  }
  return modelsFor(catalog, driverName).find((model) => model.id === modelId)?.effortLevels;
}

/**
 * One driver's declared output-speed vocabulary. An absent or empty one makes the axis
 * unsettable (the mutation refuses fail-closed), so no control is drawn.
 */
export function outputSpeedLevelsFor(
  catalog: DriverCatalogReading,
  driverName: string | undefined,
): readonly string[] | undefined {
  if (driverName === undefined) {
    return undefined;
  }
  return catalog.capabilities.drivers.find((report) => report.driverName === driverName)
    ?.outputSpeedLevels;
}

/**
 * One capability flag as the driver declared it. `undefined` where the catalog named no such
 * driver, which is not `false`: the console asserts no capability it was not told about.
 */
export function capabilityFlagFor(
  catalog: DriverCatalogReading,
  driverName: string | undefined,
  flag: DriverCapabilityFlag,
): boolean | undefined {
  if (driverName === undefined) {
    return undefined;
  }
  const report = catalog.capabilities.drivers.find(
    (candidate) => candidate.driverName === driverName,
  );
  return report?.capabilities.flags[flag];
}

/**
 * Whether the catalog lists this model under this driver. An unread catalog answers no;
 * callers that must tell "not carried" from "not yet read" test the catalog itself.
 */
export function catalogCarriesModel(
  catalog: DriverCatalogReading | undefined,
  driverName: string | undefined,
  modelId: string,
): boolean {
  return (
    catalog !== undefined && modelsFor(catalog, driverName).some((model) => model.id === modelId)
  );
}

/**
 * Whether this model publishes this effort level. Unread catalog: no. An absent vocabulary
 * and an empty one answer the same: nothing vouches for the level.
 */
export function catalogCarriesEffortLevel(
  catalog: DriverCatalogReading | undefined,
  driverName: string | undefined,
  modelId: string | undefined,
  effort: string,
): boolean {
  if (catalog === undefined) {
    return false;
  }
  return effortLevelsFor(catalog, driverName, modelId)?.includes(effort) === true;
}
