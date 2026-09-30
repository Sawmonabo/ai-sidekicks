// The served manifest the artifacts suites read, as the wire hands it over.

import type { ArtifactManifest } from "@ai-sidekicks/contracts";

import { SESSION_ID } from "./artifact-list-readers.js";

// The run every manifest here comes from, in the session the artifact-pane suites read.
const ARTIFACT_RUN_ID = "019b7b30-0280-7c11-8420-b1a5c0de2202";
/** The producer every manifest here is drawn as coming from. */
const ARTIFACT_PRODUCER_ID = "019b7b30-0280-7c11-8420-b1a5c0de2203";

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
