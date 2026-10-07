// The chip tone for each artifact state.
//
// Copy names the model's types (`model.ts`) and no model function names a sentence.
// The table is total over `ArtifactState`, so a state the wire drops fails the compile.

import type { ChipTone } from "#renderer/components/Chip/Chip.js";

import type { ArtifactState } from "./model.js";

/** The chip tone each artifact state wears. */
export const ARTIFACT_STATE_TONES: Readonly<Record<ArtifactState, ChipTone>> = {
  pending: "neutral",
  published: "neutral",
  superseded: "neutral",
};
