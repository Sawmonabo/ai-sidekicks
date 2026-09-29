// What the console says about an artifact: the tone and sentence for each state, and the
// producer reading.
//
// Split from `artifact-model.ts`, which owns what an artifact is. The dependency runs one
// way: copy names the model's types and no model function names a sentence. The table is
// total over the wire's own state set, so a member the wire drops fails the compile here.

import type { ChipTone } from "@renderer/components/Chip/Chip.js";

import type { ArtifactManifestRow, ArtifactState } from "./artifact-model.js";

/** A vocabulary member's tone and its one sentence. */
export interface ArtifactPresentation {
  readonly tone: ChipTone;
  readonly meaning: string;
}

/** The three states. Total over `ArtifactState` by construction. */
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

/** What an absent `createdBy` names. A producer, stated as one. */
export const ARTIFACT_PRODUCER_ABSENT_LABEL = "the background service";

/** Who produced a row. An absent producer is the daemon, named rather than blanked. */
export function artifactProducerLabel(row: ArtifactManifestRow): string {
  return row.createdBy ?? ARTIFACT_PRODUCER_ABSENT_LABEL;
}
