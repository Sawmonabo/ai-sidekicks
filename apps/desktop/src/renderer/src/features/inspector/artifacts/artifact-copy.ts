// The sentence and tone for each artifact state, and the producer label.
//
// Copy names the model's types (`artifact-model.ts`) and no model function names a sentence.
// The table is total over `ArtifactState`, so a state the wire drops fails the compile.

import type { ChipTone } from "@renderer/components/Chip/Chip.js";

import type { ArtifactManifestRow, ArtifactState } from "./artifact-model.js";

/** A state's chip tone and its one sentence. */
export interface ArtifactPresentation {
  readonly tone: ChipTone;
  readonly meaning: string;
}

/** The tone and sentence for each artifact state. */
export const ARTIFACT_STATE_PRESENTATION: Readonly<Record<ArtifactState, ArtifactPresentation>> = {
  pending: {
    tone: "neutral",
    meaning: "In flight. The publish has started and has not completed.",
  },
  published: {
    tone: "neutral",
    meaning: "Published.",
  },
  superseded: {
    tone: "neutral",
    meaning: "Superseded by a later artifact. The row stays as history.",
  },
};

/** The producer label shown when `createdBy` is absent. */
export const ARTIFACT_PRODUCER_ABSENT_LABEL = "the background service";

/** Who produced a row; an absent producer is named as the background service, not blanked. */
export function artifactProducerLabel(row: ArtifactManifestRow): string {
  return row.createdBy ?? ARTIFACT_PRODUCER_ABSENT_LABEL;
}
