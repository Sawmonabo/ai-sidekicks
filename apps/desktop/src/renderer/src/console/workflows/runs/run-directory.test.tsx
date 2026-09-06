// The run enumeration has four endings, and it is always about one session.
//
// Every case drives a REAL growth port — the refusing one, or the real one with the
// enumeration answered per session, the shape `definition-directory.test.tsx` already
// uses. A stand-in port would agree with whatever the hook did with it.
//
// EVERY CASE OBSERVES THE COMMITTED STATE, through the probe the store already owns.
// This hook re-addresses DURING the render, and a render React discards still ran — so
// a log written from a render body shows a value no commit ever carried, under a
// correct hook as readily as under a broken one. An effect runs once per COMMIT, which
// is the frame a surface paints and a screen reader is handed, and
// `store/subject-read-commits.test-support.tsx` is where that probe lives: a second
// copy here would be a second answer to when this file's cases are looking.

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { type GrowthPort, type WorkflowRunListEntry } from "../../bridge/index.js";
import { createRefusingGrowthPort } from "../../bridge/growth-port/growth-port.js";
import { WORKFLOWS_SCENARIO_RUNS } from "../../bridge/scenarios/workflow-fixture-runs.js";
import {
  latestCommitted,
  observeSubjectRead,
  type ObservedSubjectRead,
} from "../../store/subject-read-commits.test-support.js";
import {
  PROBE_SESSION_ID,
  SECOND_PROBE_SESSION_ID,
  settle,
} from "../workflows-probe.test-support.js";
import { useWorkflowRunDirectory, type WorkflowRunDirectoryState } from "./run-directory.js";

/** One enumeration entry per session, so a row can be traced back to what was asked. */
function entriesFor(sessionId: string): readonly WorkflowRunListEntry[] {
  const [run] = WORKFLOWS_SCENARIO_RUNS;
  if (run === undefined) {
    throw new Error("the workflows fixture carries no runs");
  }
  return [{ ...run, sessionId, definitionName: `Definition of ${sessionId}` }];
}

/** The real port with the enumeration answered per session, and nothing else changed. */
function sessionScopedGrowthPort(): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowRunList: async ({ sessionId }) => ({
      status: "served",
      value: { runs: entriesFor(sessionId) },
    }),
  };
}

/** This read under the shared commit observer, addressed at one port and one session. */
function observeRunDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): ObservedSubjectRead<GrowthPort, WorkflowRunDirectoryState, string> {
  return observeSubjectRead(useWorkflowRunDirectory, { source: growth, subject: sessionId });
}

/**
 * The first value a commit carried, for a case whose claim is about the opening frame.
 *
 * Derived from the shared reader rather than written again, so an empty log refuses
 * here with the same sentence it refuses with everywhere else.
 */
function firstCommitted(
  committed: readonly WorkflowRunDirectoryState[],
): WorkflowRunDirectoryState {
  return latestCommitted(committed.slice(0, 1));
}

function servedSessionIds(state: WorkflowRunDirectoryState): readonly string[] {
  return state.status === "served" ? state.runs.map((run) => run.sessionId) : [];
}

describe("useWorkflowRunDirectory — one read, always about one session", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts no question at all where no session is in scope", () => {
    // `unasked` on the FIRST committed frame as well as the last, so the arm that must
    // stay unasked is held to the same moment as the arm below that must not be.
    const probe = observeRunDirectory(createRefusingGrowthPort(), undefined);
    expect(firstCommitted(probe.committed).status).toBe("unasked");
    expect(latestCommitted(probe.committed).status).toBe("unasked");
  });

  it("is already reading on the first frame it commits with a session in scope", () => {
    // The state was initialised `unasked` and only became `reading` in the effect,
    // which runs after the commit — so every scoped mount painted one frame claiming
    // nobody had asked, which the runs surface draws as "no session is in scope".
    const probe = observeRunDirectory(sessionScopedGrowthPort(), PROBE_SESSION_ID);
    expect(firstCommitted(probe.committed).status).toBe("reading");
  });

  it("settles on the runs the enumeration served for that session", async () => {
    const probe = observeRunDirectory(sessionScopedGrowthPort(), PROBE_SESSION_ID);
    await settle();
    expect(servedSessionIds(latestCommitted(probe.committed))).toEqual([PROBE_SESSION_ID]);
  });

  it("carries the port's own refusal when no wire is registered", async () => {
    const probe = observeRunDirectory(createRefusingGrowthPort(), PROBE_SESSION_ID);
    await settle();
    const settled = latestCommitted(probe.committed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      expect(settled.refusal.code).toBe("wire-unregistered");
    }
    // Never an empty list: that would assert this session holds no runs, a claim
    // about the daemon that nothing established.
    expect(probe.committed.map((state) => state.status)).not.toContain("served");
  });

  it("shows the previous session's runs nowhere once the scope moves", async () => {
    const growth = sessionScopedGrowthPort();
    const probe = observeRunDirectory(growth, PROBE_SESSION_ID);
    await settle();
    expect(servedSessionIds(latestCommitted(probe.committed))).toEqual([PROBE_SESSION_ID]);

    probe.readdress({ source: growth, subject: SECOND_PROBE_SESSION_ID });

    // Reading, not the first session's rows: before the stamp, those stayed
    // renderable under the second session's name until the effect reset them.
    expect(latestCommitted(probe.committed).status).toBe("reading");

    await settle();
    expect(servedSessionIds(latestCommitted(probe.committed))).toEqual([SECOND_PROBE_SESSION_ID]);
  });
});

/**
 * The real port answering with runs a case can trace back to the bridge that served
 * them, so a swap is observable in the rows and not only in the status.
 */
function labelledGrowthPort(scenarioLabel: string): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    workflowRunList: async ({ sessionId }) => ({
      status: "served",
      value: {
        runs: entriesFor(sessionId).map((run) => ({ ...run, definitionName: scenarioLabel })),
      },
    }),
  };
}

function servedDefinitionNames(state: WorkflowRunDirectoryState): readonly string[] {
  return state.status === "served" ? state.runs.map((run) => run.definitionName) : [];
}

describe("useWorkflowRunDirectory — the port is half of what the read is about", () => {
  afterEach(() => {
    cleanup();
  });

  it("commits no run from the previous bridge once the port is replaced", async () => {
    // The fixture's scenario switch mints a new bridge and hands back the same session
    // id. With the stamp keyed on the session alone the state agreed with itself, so
    // this render committed the previous scenario's runs under the new one and only the
    // passive effect afterwards took them down.
    const probe = observeRunDirectory(labelledGrowthPort("first scenario"), PROBE_SESSION_ID);
    await settle();
    expect(servedDefinitionNames(latestCommitted(probe.committed))).toEqual(["first scenario"]);
    const commitsBeforeSwap = probe.committed.length;

    probe.readdress({ source: labelledGrowthPort("second scenario"), subject: PROBE_SESSION_ID });

    expect(probe.committed.slice(commitsBeforeSwap).flatMap(servedDefinitionNames)).toStrictEqual(
      [],
    );

    await settle();
    // The reset is only half the claim: a hook that reset and never re-read would leave
    // the surface reading forever under a bridge that can answer.
    expect(servedDefinitionNames(latestCommitted(probe.committed))).toEqual(["second scenario"]);
  });

  it("negative control: a re-render at the SAME port keeps the runs it settled on", async () => {
    // Without this, the case above passes for a hook that reset on every render, which
    // would re-read the enumeration forever and never show an answer at all.
    const growth = labelledGrowthPort("first scenario");
    const probe = observeRunDirectory(growth, PROBE_SESSION_ID);
    await settle();

    probe.readdress({ source: growth, subject: PROBE_SESSION_ID });

    expect(servedDefinitionNames(latestCommitted(probe.committed))).toEqual(["first scenario"]);
  });
});
