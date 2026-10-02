// The chip tone for each artifact state, and the producer label.
//
// Copy names the model's types (`artifact-model.ts`) and no model function names a sentence.
// The table is total over `ArtifactState`, so a state the wire drops fails the compile.

import type { ChipTone } from "@renderer/components/Chip/Chip.js";

import type { ArtifactManifestRow, ArtifactState } from "./artifact-model.js";

/** The chip tone each artifact state wears. */
export const ARTIFACT_STATE_TONES: Readonly<Record<ArtifactState, ChipTone>> = {
  pending: "neutral",
  published: "neutral",
  superseded: "neutral",
};

/** The producer label shown when `createdBy` is absent. */
export const ARTIFACT_PRODUCER_ABSENT_LABEL = "the background service";

/** Who produced a row; an absent producer is named as the background service, not blanked. */
export function artifactProducerLabel(row: ArtifactManifestRow): string {
  return row.createdBy ?? ARTIFACT_PRODUCER_ABSENT_LABEL;
}
