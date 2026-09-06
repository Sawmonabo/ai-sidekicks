// The definitions the workflows browser groups.
//
// One of the workflow fixture's four data modules; `workflow-fixture-ids.ts` carries
// the framing all four share and the version ids this table and the run table must
// agree on.

import type { WorkflowDefinitionSummary } from "../wire-shapes/workflow-projection.js";

import {
  VERSION_INCIDENT_TRIAGE_LATEST,
  VERSION_RELEASE_CHECKS_LATEST,
  VERSION_SHIP_PIPELINE_LATEST,
  WORKFLOWS_SESSION_ID,
} from "./workflow-fixture-ids.js";

// Definition ids, named rather than inlined and local to this module because no other
// table in the fixture addresses a definition — a run carries a workflow VERSION id,
// which is the shared axis and lives beside the rest of them.
const DEFINITION_RELEASE_CHECKS = "019b7a10-0280-7c11-8100-def111150001";
const DEFINITION_SHIP_PIPELINE = "019b7a10-0280-7c11-8100-def111150002";
const DEFINITION_INCIDENT_TRIAGE = "019b7a10-0280-7c11-8100-def111150003";

/**
 * The definitions the browser groups, in the daemon's own resolution order.
 *
 * Two names appear at more than one scope on purpose, because that is the only shape
 * in which `resolvesAtThisContext` says anything: the flag marks the one row per NAME
 * that most-specific-first resolution would pick, so a table where every name appeared
 * once would set it true everywhere and teach a reader nothing. Here a session copy
 * wins over a project copy of the same name, and a project copy wins over the shared
 * original — the rule read off the data rather than asserted beside it.
 *
 * `scopeRef` is the scope's identity and is not decorative: the authoring session's id
 * at `session`, the resolved repository root at `project`, and the empty string at
 * `shared`, which is daemon-wide and refers to nothing narrower.
 *
 * `contentHash` is BLAKE3 over the RFC 8785 canonicalization, carried verbatim and
 * rendered in mono. The console never parses one; it is here so a detail pane has a
 * real string to show rather than a placeholder shaped like a hash.
 */
export const WORKFLOWS_SCENARIO_DEFINITIONS: readonly WorkflowDefinitionSummary[] = [
  {
    id: DEFINITION_RELEASE_CHECKS,
    name: "Release checks",
    scope: "session",
    scopeRef: WORKFLOWS_SESSION_ID,
    latestVersionNumber: 4,
    latestWorkflowVersionId: VERSION_RELEASE_CHECKS_LATEST,
    contentHash: "b3:0f3c9a1d7e5b42c8a06d1f93be27540ac1d8e6b3927fa04c5de81b6203794acd",
    resolvesAtThisContext: true,
    // Inside the session, and therefore after it. The `project` and `shared` rows
    // below keep their older instants because they belong to a repository root and
    // to the daemon, neither of which this session's creation bounds; only a
    // `session`-scoped definition is owned by the session and constrained by it.
    createdAt: "2026-01-01T07:04:00.000Z",
  },
  {
    id: "019b7a10-0280-7c11-8100-def111150004",
    name: "Release checks",
    scope: "project",
    scopeRef: "/Users/operator/work/atlas",
    latestVersionNumber: 2,
    latestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150005",
    contentHash: "b3:5a7e2b04c1d93f68027ba4e1d5c3098fa62b7413ed05c9a8b1f42760de3915cb",
    // False, and this is the row that makes the group order legible: a session
    // definition of the same name is more specific, so a run started here picks that
    // one and never this.
    resolvesAtThisContext: false,
    createdAt: "2025-11-02T16:40:00.000Z",
  },
  {
    id: DEFINITION_SHIP_PIPELINE,
    name: "Ship pipeline",
    scope: "project",
    scopeRef: "/Users/operator/work/atlas",
    latestVersionNumber: 3,
    latestWorkflowVersionId: VERSION_SHIP_PIPELINE_LATEST,
    contentHash: "b3:c4109de7f3b28a56014c9e2b7d6a3f5081ba9c37e2d40615fa8b73c091d2e648",
    resolvesAtThisContext: true,
    createdAt: "2025-10-21T11:05:00.000Z",
  },
  {
    id: "019b7a10-0280-7c11-8100-def111150005",
    name: "Ship pipeline",
    scope: "shared",
    scopeRef: "",
    latestVersionNumber: 7,
    latestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150006",
    contentHash: "b3:9e21b7c0d4a63f18052e7ba9c136d40f8b27ea51c9038d647fa2b105e37c96da",
    resolvesAtThisContext: false,
    createdAt: "2025-08-09T08:30:00.000Z",
  },
  {
    id: DEFINITION_INCIDENT_TRIAGE,
    name: "Incident triage",
    scope: "shared",
    scopeRef: "",
    latestVersionNumber: 5,
    latestWorkflowVersionId: VERSION_INCIDENT_TRIAGE_LATEST,
    contentHash: "b3:76d0e39b2c8a41f5093be7d2a6c14f08e5b3a2701cd946fb85e37201da6cb493",
    resolvesAtThisContext: true,
    createdAt: "2025-07-14T13:22:00.000Z",
  },
];
