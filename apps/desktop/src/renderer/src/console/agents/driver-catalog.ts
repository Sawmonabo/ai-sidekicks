// The two LIVE-NOW driver reads, and the selectors every axis control asks of them.
//
// `driver.listModels` and `driver.listCapabilities` are registered daemon methods
// today — the only wires these surfaces have that are not fixture-only — and both
// are no-arg group lists keyed by driver name. They are read TOGETHER because no
// axis control can be composed from either alone: a model's effort vocabulary comes
// from the model catalog, the output-speed vocabulary and the capability gate come
// from the capability report, and a form that asked for one and then the other would
// render half its axes before deciding whether it may render the rest.
//
// ALL-OR-NOTHING IS THE DAEMON'S RULE AND THIS MODULE KEEPS IT. A driver that fails
// fails the whole read rather than silently reporting no models, so the pair is read
// with `Promise.all` and a rejection from either becomes the read's rejection. A
// partial catalog would let a control offer a vocabulary that is missing exactly the
// entries the failed driver would have supplied, which reads as "this provider has
// no models" — the conflation the five kinds of nothing exist to prevent.
//
// THE SELECTORS DERIVE NOTHING THEY COULD READ. An effort vocabulary is per MODEL
// and provider-published: a provider-wide list is wrong for some model in the same
// reply (`Spec-005 §Provider Parameter Vocabularies`), and an absent list means the
// model exposes no effort selection at all — which is a different answer from an
// empty one and is preserved as `undefined` rather than flattened to `[]`.

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
 * One model's effort vocabulary.
 *
 * `undefined` means the model publishes no effort surface, and a form that gets it
 * shows NO effort control at all rather than an empty one — an empty select asserts
 * an axis exists with nothing on it, which is a claim no provider surface makes.
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
 * One driver's declared output-speed vocabulary.
 *
 * Statically declared by the driver and client-visible for exactly this reason. An
 * absent or empty vocabulary makes the axis unsettable and the mutation refuses
 * fail-closed, so a control is never drawn over one.
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
 * One capability flag as the driver declared it.
 *
 * `undefined` where the catalog named no such driver — which is not `false`. A
 * control gated on an unanswered flag is absent for the same reason a control gated
 * on a `false` one is: the console does not assert a capability it was not told
 * about, in either direction.
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
