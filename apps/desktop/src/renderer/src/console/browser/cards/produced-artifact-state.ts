// The lifecycle state a produced object reaches, declared once for every reader.
//
// FOUR SURFACES READ IT and they must agree: the fold that reduces the log to one row
// per produced object, the identity row, the capture card, and the download card. A
// card that could not say which state its object had reached rendered a superseded
// capture as an ordinary one — the object was still on the shelf, still named, still
// carrying its size, and the one fact that had changed about it was the one nothing
// drew.
//
// ITS OWN MODULE, AND NOT A SECTION OF THE FOLD. `produced-objects.ts` names the two
// card prop types to compose its card union, so a card reaching back into it for this
// vocabulary closes a cycle — and `.dependency-cruiser.mjs` runs with
// `tsPreCompilationDeps`, so a type-only edge counts exactly as a value edge does.
// The vocabulary therefore sits below both, where every reader can take it and it
// takes nothing.
//
// THE SET IS THE CONSOLE'S OWN, STATED RATHER THAN DERIVED. `packages/contracts`
// registers the three `artifact.*` event TYPES and no payload variant for any of
// them, so there is no wire union to derive this from; the values are the ones
// `Spec-006 §Artifact and Diff Publication (artifact_publication)` puts on the
// family's `state` member. Declared as a tuple with the union read off it, so the
// presentation tables below and in every consumer are total by construction and a
// fourth state does not compile until each of them says what it renders.

export const PRODUCED_ARTIFACT_STATES = ["pending", "published", "superseded"] as const;

export type ProducedArtifactState = (typeof PRODUCED_ARTIFACT_STATES)[number];

/**
 * How each state reads on a row or a card. Total over the set by construction.
 *
 * One table for both row shapes rather than one each: the identity row and the two
 * cards are three renderings of one fact, and three copies of these three words is
 * three places for a shelf to call the same object stored in one row and published in
 * the next.
 */
export const PRODUCED_ARTIFACT_STATE_LABELS: Readonly<Record<ProducedArtifactState, string>> = {
  pending: "Ingest in flight",
  published: "Stored",
  superseded: "Superseded",
};

/**
 * Whether an unread wire value is one of the states the shelf can render.
 *
 * The reader lives with the vocabulary because it IS the vocabulary's boundary: a
 * value outside the set is not a shade of one of them, it is a state this console has
 * no rendering for, and admitting it would put an unrenderable arm into a total
 * table.
 */
export function isProducedArtifactState(value: unknown): value is ProducedArtifactState {
  return PRODUCED_ARTIFACT_STATES.some((state) => state === value);
}
