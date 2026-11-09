// What the composer's speed chip reads for the lead's model: `Fast` or `Standard` where the model
// has fast output, else `Standard` grayed with the model's name in its reason. The model decides,
// never the provider. A model's speed levels lead with its standard level; its fast level is the
// last one it lists.

import type { ProviderModel } from "@ai-sidekicks/contracts/provider/driver/capabilities";

/** The speed chip's word: the two values it reads as. */
export type SpeedWord = "Fast" | "Standard";

/**
 * What the chip draws and what a press writes: live with the level each word stands for, or
 * grayed with its reason, or grayed with none while the lead's model is not read yet.
 */
export type SpeedChipReading =
  | {
      readonly kind: "live";
      readonly word: SpeedWord;
      readonly standardLevel: string;
      readonly fastLevel: string;
    }
  | { readonly kind: "grayed"; readonly reason: string | undefined };

/**
 * The chip for `model` with `levels`, its speed vocabulary, at `chosenLevel`, the level the next
 * turn runs at; `undefined` model reads grayed with no reason, since none is known yet.
 */
export function readSpeedChip(
  model: ProviderModel | undefined,
  levels: readonly string[] | undefined,
  chosenLevel: string | undefined,
): SpeedChipReading {
  if (model === undefined) {
    return { kind: "grayed", reason: undefined };
  }
  const standardLevel = levels?.[0];
  const fastLevel = levels?.at(-1);
  if (
    !model.fast ||
    standardLevel === undefined ||
    fastLevel === undefined ||
    fastLevel === standardLevel
  ) {
    return { kind: "grayed", reason: `${model.name} has no fast output.` };
  }
  return {
    kind: "live",
    word: chosenLevel === fastLevel ? "Fast" : "Standard",
    standardLevel,
    fastLevel,
  };
}
