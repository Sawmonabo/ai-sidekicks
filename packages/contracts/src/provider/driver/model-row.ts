// Finding the catalog row a model choice names.
import type { ProviderModel } from "../../generated/provider/driver/capabilities.js";

/**
 * The catalog row a choice names, or `undefined` when the catalog holds none. A model's default
 * row and its larger-window row share the model's id, so a row is found by its id and its
 * `largerWindow` together, never by the id alone.
 */
export function findProviderModelRow<Row extends Pick<ProviderModel, "id" | "largerWindow">>(
  rows: readonly Row[],
  modelId: string,
  largerWindow: boolean,
): Row | undefined {
  return rows.find((row) => row.id === modelId && row.largerWindow === largerWindow);
}
