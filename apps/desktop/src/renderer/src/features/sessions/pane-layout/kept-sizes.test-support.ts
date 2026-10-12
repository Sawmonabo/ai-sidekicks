// What a suite that mounts the pane layout hands it for the kept sizes' refusals: a case about
// something else fails loudly on one rather than drawing past it.

import { type Refusal } from "#renderer/lib/refusal/contract.js";

/** Fails the case on any refusal of the kept pane sizes, naming its code and words. */
export function failOnPaneSizesRefusal(refusal: Refusal): void {
  throw new Error(`the kept pane sizes were refused: ${refusal.code}: ${refusal.detail}`);
}
