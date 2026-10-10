// The driver catalog's shape, the answers of `driver.listModels` and `driver.listCapabilities`
// held together, and the selectors every axis control asks of it. The two answers are held
// together, all or nothing, because a partial catalog would read as "this provider has no
// models". A row is found by its model id and whether it is the larger window, since a model's
// two rows share the id. Effort levels are per model, and an absent list (`undefined`) is a
// different answer from an empty one. Speed levels are per model where the provider publishes
// them so, else the driver's one list.

import type {
  ListCapabilitiesResult,
  ListModelsResult,
} from "@ai-sidekicks/contracts/provider/driver/methods";
import {
  findProviderModelRow,
  type ProviderModel,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";

/** Both catalog reads, held together because no axis control can use one alone. */
export interface DriverCatalogReading {
  readonly models: ListModelsResult;
  readonly capabilities: ListCapabilitiesResult;
}

/** The row a choice names: its model id, and whether it is that model's larger window. */
export interface ModelRowChoice {
  readonly modelId: string;
  readonly largerWindow: boolean;
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
 * One model's effort vocabulary, on the row the choice names. `undefined` means the model
 * publishes none, so a form shows no effort control rather than an empty select.
 */
export function effortLevelsFor(
  catalog: DriverCatalogReading,
  driverName: string | undefined,
  choice: ModelRowChoice | undefined,
): readonly string[] | undefined {
  return findModelRow(catalog, driverName, choice)?.effortLevels;
}

/**
 * Whether the catalog lists the row the choice names under this driver, its larger window
 * included. An unread catalog answers no; callers that must tell "not carried" from "not yet
 * read" test the catalog itself.
 */
export function catalogCarriesModel(
  catalog: DriverCatalogReading | undefined,
  driverName: string | undefined,
  choice: ModelRowChoice,
): boolean {
  return catalog !== undefined && findModelRow(catalog, driverName, choice) !== undefined;
}

/**
 * Whether the row the choice names publishes this effort level. Unread catalog: no. An absent
 * vocabulary and an empty one answer the same: nothing vouches for the level.
 */
export function catalogCarriesEffortLevel(
  catalog: DriverCatalogReading | undefined,
  driverName: string | undefined,
  choice: ModelRowChoice | undefined,
  effort: string,
): boolean {
  if (catalog === undefined) {
    return false;
  }
  return effortLevelsFor(catalog, driverName, choice)?.includes(effort) === true;
}

/**
 * One model's output-speed vocabulary, on the row the choice names: the model's own list where
 * its provider publishes one, else the driver's list on the capability report. `undefined` where
 * the driver declares no speed axis or the row is not listed, so a form shows no speed control.
 */
export function outputSpeedLevelsFor(
  catalog: DriverCatalogReading,
  driverName: string | undefined,
  choice: ModelRowChoice | undefined,
): readonly string[] | undefined {
  const report = catalog.capabilities.drivers.find((entry) => entry.driverName === driverName);
  if (report?.capabilities.flags.output_speed !== true) {
    return undefined;
  }
  const model = findModelRow(catalog, driverName, choice);
  if (model === undefined) {
    return undefined;
  }
  return model.outputSpeedLevels ?? report.outputSpeedLevels;
}

// The driver's row a choice names, or `undefined` with no choice or no such row.
function findModelRow(
  catalog: DriverCatalogReading,
  driverName: string | undefined,
  choice: ModelRowChoice | undefined,
): ProviderModel | undefined {
  return choice === undefined
    ? undefined
    : findProviderModelRow(modelsFor(catalog, driverName), choice.modelId, choice.largerWindow);
}
