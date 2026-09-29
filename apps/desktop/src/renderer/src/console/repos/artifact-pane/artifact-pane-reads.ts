// The artifact list read, and what its answer reads as.
//
// The reader owns who asked and when; this file owns what a served list means.

import type { ArtifactManifest, ArtifactReadResponse } from "@ai-sidekicks/contracts";

import { artifactManifestRowFrom, type ArtifactsPanelState } from "../artifacts/artifact-model.js";

/** The call that lists a session's artifact manifests, supplied by whoever mounts the pane. */
export type ListArtifacts = (sessionId: string) => Promise<readonly ArtifactManifest[]>;

/** What one artifact read asks for: the manifest alone, or the manifest with its bytes. */
export interface ReadArtifactRequest {
  readonly artifactId: string;
  readonly includePayload?: true;
}

/** The call that reads one artifact, supplied by whoever mounts the pane. */
export type ReadArtifact = (request: ReadArtifactRequest) => Promise<ArtifactReadResponse>;

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
): Promise<ArtifactsPanelState> {
  const manifests = await listArtifacts(sessionId);
  return { kind: "listed", rows: manifests.map(artifactManifestRowFrom) };
}
