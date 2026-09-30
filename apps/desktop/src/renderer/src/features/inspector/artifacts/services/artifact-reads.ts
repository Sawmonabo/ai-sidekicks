// The artifact list read, and what its answer reads as.
//
// The reader owns who asked and when; this file owns what a served list means.

import type {
  ArtifactManifest,
  ArtifactReadRequest,
  ArtifactReadResponse,
} from "@ai-sidekicks/contracts";

import { artifactManifestRowFrom, type ArtifactsSectionState } from "../artifact-model.js";

/** The call that lists a session's artifact manifests, supplied by whoever mounts the pane. */
export type ListArtifacts = (sessionId: string) => Promise<readonly ArtifactManifest[]>;

/** The call that reads one artifact, supplied by whoever mounts the pane. */
export type ReadArtifact = (request: ArtifactReadRequest) => Promise<ArtifactReadResponse>;

/** Both calls the pane makes. */
export interface ArtifactOperations {
  readonly listArtifacts: ListArtifacts;
  readonly readArtifact: ReadArtifact;
}

/**
 * The session's manifests as the panel draws them.
 *
 * A list with no rows is `listed` with an empty array, not `loading`: a read that found
 * none must not look like a read still in flight. A rejected call propagates.
 */
export async function readArtifactList(
  listArtifacts: ListArtifacts,
  sessionId: string,
): Promise<ArtifactsSectionState> {
  const manifests = await listArtifacts(sessionId);
  return { kind: "listed", rows: manifests.map(artifactManifestRowFrom) };
}
