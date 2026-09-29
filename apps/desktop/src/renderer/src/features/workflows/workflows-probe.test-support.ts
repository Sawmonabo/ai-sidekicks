// What every suite in this family needs before it can assert anything: the shared
// identities, a definition-row factory, one `settle` boundary, and the runs the suites read.
//
// `settle` is one `act` boundary awaiting a macrotask boundary rather than a count of
// microtasks, so a suite waiting on a read is not also asserting a count of turns nobody
// chose. The row factory takes overrides so a new required member of the wire type is one
// edit here and every caller keeps compiling because it only names what it asserts on.

import { act } from "@testing-library/react";

import type { WorkflowRunSnapshot } from "@renderer/services/wire-shapes/workflow-projection.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import type { WorkflowDefinitionRow } from "./definitions/definition-rows.js";

/** The session every workflows suite addresses. One id, so every suite probes one. */
export const PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";

/** The other session, for a case whose whole claim is that the scope moved off the first. */
export const SECOND_PROBE_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3402";

/** The continuation token the paged cases hand back. */
export const SECOND_PAGE_CURSOR = "definitions-page-2";

/** One definition, as the enumeration carries it. Override only what a case asserts on. */
export function definition(overrides: Partial<WorkflowDefinitionRow> = {}): WorkflowDefinitionRow {
  return {
    id: "release-checklist",
    name: "Release checklist",
    scope: "session",
    scopeRef: PROBE_SESSION_ID,
    latestVersionNumber: 3,
    latestWorkflowVersionId: "release-checklist-version-3",
    contentHash: "b3:0f1e2d",
    resolvesAtThisContext: false,
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

/** Let every read a surface put reach its own settlement, so an assertion is about answers. */
export async function settle(): Promise<void> {
  await act(async () => {
    await crossMacrotaskBoundary();
  });
}

/** The first phase of every fixture run: drafting. */
export const PHASE_DRAFT = "019b7a10-0280-7e44-8100-9ba5e1150001";

/** The build phase: running in the working run, parked on a usage window in the parked one. */
export const PHASE_BUILD = "019b7a10-0280-7e44-8100-9ba5e1150002";

/** The review phase: pending in the working run, skipped in the canceled one. */
export const PHASE_REVIEW = "019b7a10-0280-7e44-8100-9ba5e1150003";

/** The phase the parked run waits on a person for. */
export const PHASE_SIGN_OFF = "019b7a10-0280-7e44-8100-9ba5e1150004";

/** The phase that runs on the sign-off answer; pending in the parked run. */
export const PHASE_PUBLISH = "019b7a10-0280-7e44-8100-9ba5e1150005";

/** The release checks workflow's latest version, pinned by the working run. */
export const VERSION_RELEASE_CHECKS_LATEST = "019b7a10-0280-7d22-8100-be5100150004";

/** The ship pipeline's latest version, pinned by the parked run. */
export const VERSION_SHIP_PIPELINE_LATEST = "019b7a10-0280-7d22-8100-be5100150003";

/** An older ship pipeline version, pinned by the run that trails the latest. */
export const VERSION_SHIP_PIPELINE_PINNED = "019b7a10-0280-7d22-8100-be5100150001";

/** The incident triage workflow's latest version, pinned by the canceled run. */
export const VERSION_INCIDENT_TRIAGE_LATEST = "019b7a10-0280-7d22-8100-be5100150002";

/** A run parked on a provider's usage window and on a person's sign-off. */
export const PARKED_RUN: WorkflowRunSnapshot = {
  workflowRunId: "019b7a10-0280-7b33-8100-4011115a0002",
  sessionId: PROBE_SESSION_ID,
  workflowVersionId: VERSION_SHIP_PIPELINE_LATEST,
  state: "suspended",
  startedAt: "2026-01-01T09:31:00.000Z",
  phaseStates: [
    {
      phaseId: PHASE_DRAFT,
      phaseRunId: "019b7a10-0280-7aa1-8100-701a11150003",
      attemptNumber: 1,
      state: "completed",
      gateState: "open",
    },
    {
      phaseId: PHASE_BUILD,
      phaseRunId: "019b7a10-0280-7aa1-8100-701a11150004",
      attemptNumber: 1,
      state: "running",
      gateState: "closed",
      parkReason: "provider-usage-limited",
      parkCause:
        "The provider account reached its five-hour usage window. The next window opens at 10:45 UTC.",
      autoResumeAt: "2026-01-01T10:45:00.000Z",
      parkAttentionKey: "019b7a10-0280-7f55-8100-acc0117a0001",
    },
    {
      phaseId: PHASE_SIGN_OFF,
      phaseRunId: "019b7a10-0280-7aa1-8100-701a11150005",
      attemptNumber: 1,
      state: "running",
      gateState: "closed",
      formRevision: 0,
      parkReason: "waiting-human",
      parkCause: "Waiting on a release sign-off from a person before the publish phase runs.",
      prompt: "Sign off on this release, or send it back. The publish phase runs on your answer.",
      inputSchema: {
        type: "object",
        title: "Release sign-off",
        properties: {
          decision: {
            type: "string",
            title: "Decision",
            enum: ["approve", "send-back"],
          },
          notes: {
            type: "string",
            format: "long_text",
            title: "Notes",
            description: "What the next person needs to know about this decision.",
          },
        },
        required: ["decision"],
      },
    },
    { phaseId: PHASE_PUBLISH, state: "pending", gateState: "closed" },
  ],
};

/** The four runs an enumeration ranks: working, parked, canceled and pinned to an old version. */
export const PROBE_RUNS: readonly WorkflowRunSnapshot[] = [
  {
    workflowRunId: "019b7a10-0280-7b33-8100-4011115a0001",
    sessionId: PROBE_SESSION_ID,
    workflowVersionId: VERSION_RELEASE_CHECKS_LATEST,
    state: "running",
    startedAt: "2026-01-01T09:52:00.000Z",
    phaseStates: [
      {
        phaseId: PHASE_DRAFT,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150001",
        attemptNumber: 1,
        state: "completed",
        gateState: "open",
      },
      {
        phaseId: PHASE_BUILD,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150002",
        attemptNumber: 2,
        state: "running",
        gateState: "closed",
      },
      { phaseId: PHASE_REVIEW, state: "pending", gateState: "closed" },
    ],
  },
  PARKED_RUN,
  {
    workflowRunId: "019b7a10-0280-7b33-8100-4011115a0003",
    sessionId: PROBE_SESSION_ID,
    workflowVersionId: VERSION_INCIDENT_TRIAGE_LATEST,
    state: "canceled",
    failureReason: "Canceled: the incident was resolved out of band.",
    startedAt: "2026-01-01T08:47:00.000Z",
    endedAt: "2026-01-01T09:04:00.000Z",
    phaseStates: [
      {
        phaseId: PHASE_DRAFT,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150006",
        attemptNumber: 1,
        state: "completed",
        gateState: "open",
      },
      { phaseId: PHASE_REVIEW, state: "skipped", gateState: "closed" },
    ],
  },
  {
    workflowRunId: "019b7a10-0280-7b33-8100-4011115a0004",
    sessionId: PROBE_SESSION_ID,
    workflowVersionId: VERSION_SHIP_PIPELINE_PINNED,
    state: "suspended",
    startedAt: "2026-01-01T07:12:00.000Z",
    phaseStates: [
      {
        phaseId: PHASE_DRAFT,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150007",
        attemptNumber: 1,
        state: "completed",
        gateState: "open",
      },
      {
        phaseId: PHASE_BUILD,
        phaseRunId: "019b7a10-0280-7aa1-8100-701a11150008",
        attemptNumber: 3,
        state: "running",
        gateState: "closed",
        parkReason: "provider-usage-limited",
        parkCause:
          "The provider account reached its weekly usage window. No reset boundary was reported, so no resume is scheduled.",
      },
    ],
  },
];
