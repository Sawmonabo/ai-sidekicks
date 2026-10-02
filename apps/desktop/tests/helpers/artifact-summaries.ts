// The served manifest the artifacts suites read, as the wire hands it over.

import type { ArtifactManifest } from "@ai-sidekicks/contracts";

import { ARTIFACT_PRODUCER_ID, ARTIFACT_RUN_ID, SESSION_ID } from "./artifact-list-readers.js";

/**
 * One served manifest, before the row reader has read it. The overrides are `unknown` per
 * member, since suites driving the reader's guards need replies the declared type forbids (an
 * absent free-form map, an object where a string is declared).
 */
export function artifactManifest(
  overrides: Readonly<Record<string, unknown>> = {},
): ArtifactManifest {
  return {
    id: "artifact-01",
    sessionId: SESSION_ID,
    runId: ARTIFACT_RUN_ID,
    createdBy: ARTIFACT_PRODUCER_ID,
    artifactType: "file",
    digest: "sha256:3b1f0c",
    size: 4096,
    annotations: {},
    state: "published",
    metadata: {},
    createdAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  } as unknown as ArtifactManifest;
}
