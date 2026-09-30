// Every case observes the committed state through the shared probe: the hook re-addresses during
// the render, and a render React discards still ran, so a log written from a render body shows a
// value no commit carried.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkflowRunListEntry } from "@renderer/services/wire-shapes/workflow-projection.js";
import {
  latestCommitted,
  observeSubjectRead,
  type ObservedSubjectRead,
} from "@test/helpers/subject-read-commits.js";
import {
  PARKED_RUN,
  PROBE_SESSION_ID,
  SECOND_PROBE_SESSION_ID,
  settle,
} from "../../workflows-probe.test-support.js";
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

/** The first value a commit carried, for a case whose claim is about the opening frame. */
function firstCommitted(
  committed: readonly WorkflowRunDirectoryState[],
): WorkflowRunDirectoryState {
  return latestCommitted(committed.slice(0, 1));
}

function servedSessionIds(state: WorkflowRunDirectoryState): readonly string[] {
  return state.status === "served" ? state.runs.map((run) => run.sessionId) : [];
}

function servedDefinitionNames(state: WorkflowRunDirectoryState): readonly string[] {
  return state.status === "served" ? state.runs.map((run) => run.definitionName) : [];
}

describe("useWorkflowRunDirectory — one read, always about one session", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts no question at all where no session is in scope", async () => {
    // Asserted on the first committed frame too, as the arm below is.
    const listRuns = vi.fn(listRunsNamed("Ship pipeline"));
    const probe = observeRunDirectory(listRuns, undefined);
    await settle();

    expect(firstCommitted(probe.committed).status).toBe("unasked");
    expect(latestCommitted(probe.committed).status).toBe("unasked");
    expect(listRuns).not.toHaveBeenCalled();
  });

  it("is already reading on the first frame it commits with a session in scope", () => {
    // A state that became `reading` only in the effect would paint one `unasked` frame.
    const probe = observeRunDirectory(listRunsNamed("Ship pipeline"), PROBE_SESSION_ID);
    expect(firstCommitted(probe.committed).status).toBe("reading");
  });

  it("settles on the runs the enumeration served for that session", async () => {
    const probe = observeRunDirectory(listRunsNamed("Ship pipeline"), PROBE_SESSION_ID);
    await settle();
    expect(servedSessionIds(latestCommitted(probe.committed))).toEqual([PROBE_SESSION_ID]);
  });

  it("shows the previous session's runs nowhere once the scope moves", async () => {
    const listRuns = listRunsNamed("Ship pipeline");
    const probe = observeRunDirectory(listRuns, PROBE_SESSION_ID);
    await settle();
    expect(servedSessionIds(latestCommitted(probe.committed))).toEqual([PROBE_SESSION_ID]);

    probe.readdress({ source: listRuns, subject: SECOND_PROBE_SESSION_ID });

    expect(latestCommitted(probe.committed).status).toBe("reading");

    await settle();
    expect(servedSessionIds(latestCommitted(probe.committed))).toEqual([SECOND_PROBE_SESSION_ID]);
  });
});

describe("useWorkflowRunDirectory — the call is half of what the read is about", () => {
  afterEach(() => {
    cleanup();
  });

  it("commits no run from the previous call once the call is replaced", async () => {
    // The same session id with a replaced call: a state keyed on the session alone would commit
    // the previous call's runs.
    const probe = observeRunDirectory(listRunsNamed("first call"), PROBE_SESSION_ID);
    await settle();
    expect(servedDefinitionNames(latestCommitted(probe.committed))).toEqual(["first call"]);
    const commitsBeforeSwap = probe.committed.length;

    probe.readdress({ source: listRunsNamed("second call"), subject: PROBE_SESSION_ID });

    expect(probe.committed.slice(commitsBeforeSwap).flatMap(servedDefinitionNames)).toStrictEqual(
      [],
    );

    await settle();
    expect(servedDefinitionNames(latestCommitted(probe.committed))).toEqual(["second call"]);
  });

  it("negative control: a re-render at the SAME call keeps the runs, asks nothing", async () => {
    // Guards the case above against a hook that reset on every render and never showed an answer.
    const listRuns = vi.fn(listRunsNamed("first call"));
    const probe = observeRunDirectory(listRuns, PROBE_SESSION_ID);
    await settle();

    probe.readdress({ source: listRuns, subject: PROBE_SESSION_ID });
    await settle();

    expect(servedDefinitionNames(latestCommitted(probe.committed))).toEqual(["first call"]);
    expect(listRuns).toHaveBeenCalledTimes(1);
  });
});
