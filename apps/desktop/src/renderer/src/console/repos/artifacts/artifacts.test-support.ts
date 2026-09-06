// The one manifest row all three artifact suites are drawn against, and the served
// summary it is READ from.
//
// Written three times before this module existed — byte-identical in
// `ArtifactsPanel.test.tsx`, `ArtifactsPanel.acts.test.tsx` and `artifact-model.test.ts`
// — so a member the wire added had to be added three times, and nothing failed when it
// was added once. `AGENTS.md` §Shared code hoists on the second use.

import {
  REPOS_IMPLEMENTER_RUN_ID,
  REPOS_SESSION_ID,
  REPOS_VIEWING_PARTICIPANT_ID,
} from "../../bridge/scenarios/repos.js";
import type { GrowthArtifactSummary } from "../../bridge/index.js";
import type { ArtifactManifestRow } from "./artifact-model.js";

/** One published, local-only file artifact, with whatever a case cares about replaced. */
export function artifactRow(overrides: Partial<ArtifactManifestRow> = {}): ArtifactManifestRow {
  return {
    id: "artifact-01",
    sessionId: REPOS_SESSION_ID,
    runId: REPOS_IMPLEMENTER_RUN_ID,
    createdBy: REPOS_VIEWING_PARTICIPANT_ID,
    artifactType: "file",
    digest: "sha256:3b1f0c",
    size: 4096,
    annotations: {},
    visibility: "local-only",
    state: "published",
    metadata: {},
    createdAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * One served summary as the wire hands it over, BEFORE the row reader has read it.
 *
 * A SECOND BUILDER RATHER THAN A WIDENED `artifactRow`, because the two are on opposite
 * sides of one boundary: a row is what this console has already read, and a summary is
 * whatever crossed the process boundary. The suites that drive the reader's guards need
 * the second, and a builder that produced only the first could not reach them.
 *
 * THE OVERRIDES ARE `unknown` PER MEMBER AND NOT THE SIGNATURE'S OWN TYPE, for the same
 * reason: half of what those suites drive is a reply the declared type forbids — an
 * absent free-form map, an object where a string is declared — and a builder that could
 * only express a conforming value could not express the case at all.
 */
export function artifactSummary(
  overrides: Readonly<Record<string, unknown>> = {},
): GrowthArtifactSummary {
  return {
    artifactId: "artifact-01",
    sessionId: REPOS_SESSION_ID,
    runId: REPOS_IMPLEMENTER_RUN_ID,
    createdBy: REPOS_VIEWING_PARTICIPANT_ID,
    artifactType: "file",
    digest: "sha256:3b1f0c",
    size: 4096,
    annotations: {},
    visibility: "local-only",
    state: "published",
    replicationStatus: "pinned",
    metadata: {},
    createdAt: "2026-01-01T09:00:00.000Z",
    ...overrides,
  } as unknown as GrowthArtifactSummary;
}
