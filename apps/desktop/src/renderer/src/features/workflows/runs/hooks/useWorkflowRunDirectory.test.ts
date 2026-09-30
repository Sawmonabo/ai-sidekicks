// The run list's read settles on what the enumeration served for the session in scope, observed
// through the shared commit probe.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowRunListEntry } from "@renderer/services/wire-shapes/workflow-projection.js";
import {
  latestCommitted,
  observeSubjectRead,
  type ObservedSubjectRead,
} from "@test/helpers/subject-read-commits.js";
import { PARKED_RUN, PROBE_SESSION_ID, settle } from "../../workflows-probe.test-support.js";
import {
  useWorkflowRunDirectory,
  type WorkflowRunDirectoryState,
  type WorkflowRunListCall,
} from "./useWorkflowRunDirectory.js";

/** One enumeration entry per session, so a row can be traced back to what was asked. */
function entriesFor(sessionId: string, definitionName: string): readonly WorkflowRunListEntry[] {
  return [{ ...PARKED_RUN, sessionId, definitionName }];
}

/** A stub call that answers each session with its own entry, under one definition name. */
function listRunsNamed(definitionName: string): WorkflowRunListCall {
  return async ({ sessionId }) => ({ runs: entriesFor(sessionId, definitionName) });
}

/** This read under the shared commit observer, addressed at one call and one session. */
function observeRunDirectory(
  listRuns: WorkflowRunListCall,
  sessionId: string | undefined,
): ObservedSubjectRead<WorkflowRunListCall, WorkflowRunDirectoryState, string> {
  return observeSubjectRead(useWorkflowRunDirectory, { source: listRuns, subject: sessionId });
}

function servedSessionIds(state: WorkflowRunDirectoryState): readonly string[] {
  return state.status === "served" ? state.runs.map((run) => run.sessionId) : [];
}

describe("useWorkflowRunDirectory", () => {
  afterEach(() => {
    cleanup();
  });

  it("settles on the runs the enumeration served for that session", async () => {
    const probe = observeRunDirectory(listRunsNamed("Ship pipeline"), PROBE_SESSION_ID);
    await settle();
    expect(servedSessionIds(latestCommitted(probe.committed))).toEqual([PROBE_SESSION_ID]);
  });
});
