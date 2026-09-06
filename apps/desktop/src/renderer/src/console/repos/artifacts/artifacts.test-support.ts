// The one manifest row all three artifact suites are drawn against.
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
