// The one manifest row the artifacts suites are drawn against, and the served manifest it
// is read from. One module for both, so the suites share one fixture.

import type { ArtifactId, ArtifactManifest } from "@ai-sidekicks/contracts";

import { SESSION_ID } from "./artifact-list-readers.js";
import type { ArtifactManifestRow } from "@renderer/features/inspector/artifacts/artifact-model.js";

// The run every row here comes from, in the session the artifact-pane suites read.
const ARTIFACT_RUN_ID = "019b7b30-0280-7c11-8420-b1a5c0de2202";
/** The producer every row here is drawn as coming from. */
export const ARTIFACT_PRODUCER_ID = "019b7b30-0280-7c11-8420-b1a5c0de2203";

/** One published file artifact, with whatever a case cares about replaced. */
export function artifactRow(
  overrides: Partial<Omit<ArtifactManifestRow, "id">> & { readonly id?: string } = {},
): ArtifactManifestRow {
  return {
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
    id: (overrides.id ?? "artifact-01") as ArtifactId,
  };
}

/**
 * One served manifest as the wire hands it over, before the row reader has read it.
 *
 * A second builder rather than a widened `artifactRow`, because the two sit on opposite sides of
 * a boundary: a row is what this console has read, a manifest is whatever crossed the process
 * boundary. The overrides are `unknown` per member, since suites driving the reader's guards
 * need replies the declared type forbids (an absent free-form map, an object where a string is
 * declared).
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
