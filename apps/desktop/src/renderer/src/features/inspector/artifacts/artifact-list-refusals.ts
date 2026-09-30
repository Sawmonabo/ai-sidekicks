// The refusal codes of the inspector's `Artifacts` section, and the constructors that mint them.
//
// Declared apart from the reader, the acts and the payload fetch, which all construct
// refusals: a vocabulary beside any one of them would make its siblings import it.

import { normalizeWireRejection, type WireRefusal } from "@renderer/lib/wire-rejection.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";

/**
 * Which subsystem refused, when the refusal is the section's own and not the port's.
 *
 * Suites spell the string instead of importing it: a test importing the constant it asserts
 * would pass whatever the constant became.
 */
export const ARTIFACT_READER_REFUSAL_ORIGIN = "artifact-list-reader";

/**
 * The codes the section mints; the port owns every other refusal it renders.
 *
 * One `as const` array with the union derived from it. Each literal is `satisfies`-checked at
 * the site that mints it, so dropping a member from the array breaks the build.
 */
export const ARTIFACT_LIST_REFUSAL_CODES = [
  "read-threw",
  "payload-fetch-in-flight",
  "manifest-read-in-flight",
] as const;

/** One code the section mints. */
export type ArtifactListRefusalCode = (typeof ARTIFACT_LIST_REFUSAL_CODES)[number];

/**
 * The refusal a read that threw becomes.
 *
 * Delegates to `normalizeWireRejection`, which keeps what a rejection carries: a JSON-RPC
 * envelope's dotted code and words, a rate-limit retry hint, a bridge `Refusal`'s origin, and
 * an `Error` from the preload realm (which fails `instanceof`). Only the origin and the
 * sentence for a rejection that said nothing machine-readable are added here. The rejected
 * value is never quoted into the sentence, since a wire rejection can carry user content.
 */
export function readFailureRefusal(error: unknown): WireRefusal {
  return normalizeWireRejection(ARTIFACT_READER_REFUSAL_ORIGIN, error, {
    code: "read-threw" satisfies ArtifactListRefusalCode,
    detail: "The artifact read failed before it could answer.",
  });
}

/**
 * The refusal a second payload fetch becomes while the first is on the wire.
 *
 * Names the artifact being waited on, not the one pressed. The control is held while a fetch
 * is pending, so this is unreachable from the section; it exists so no press is a silent no-op.
 */
export function payloadFetchInFlightRefusal(pendingArtifactId: string): Refusal {
  return refuse(
    ARTIFACT_READER_REFUSAL_ORIGIN,
    "payload-fetch-in-flight" satisfies ArtifactListRefusalCode,
    `The payload of ${pendingArtifactId} has been asked for and the background service has not answered yet. Nothing else is fetched until it settles.`,
  );
}

/**
 * The refusal a second manifest re-read becomes while this row's first is on the wire.
 *
 * Names the row: two reads of one manifest can settle in either order, and the older reply
 * would put the staler row back. Unreachable from the section for the same reason as above.
 */
export function manifestReadInFlightRefusal(artifactId: string): Refusal {
  return refuse(
    ARTIFACT_READER_REFUSAL_ORIGIN,
    "manifest-read-in-flight" satisfies ArtifactListRefusalCode,
    `The manifest of ${artifactId} has been asked for again and the background service has not answered yet. That row is read once until it settles.`,
  );
}
