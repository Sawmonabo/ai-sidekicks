// The run enumeration has four endings, and it is always about one session.
//
// Every case drives a REAL growth port — the refusing one, or the real one with the
// enumeration answered per session, the shape `definition-directory.test.tsx` already
// uses. A stand-in port would agree with whatever the hook did with it.
//
// THE SESSION-CHANGE CASE OBSERVES THE COMMITTED STATE. The hook settles a new
// session during the render that brings it, which React discards and re-runs, so the
// last state a re-render leaves behind is the committed one — and that is the frame a
// surface paints and a screen reader is handed.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { type GrowthPort, type WorkflowRunListEntry } from "../bridge/index.js";
import { createRefusingGrowthPort } from "../bridge/growth-port.js";
import { WORKFLOWS_SCENARIO_RUNS } from "../bridge/scenarios/workflow-fixture-runs.js";
import {
  latestCommitted,
  observeStampedRead,
} from "../store/subject-stamped-state.test-support.js";
import { useWorkflowRunDirectory, type WorkflowRunDirectoryState } from "./run-directory.js";

const FIRST_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3401";
const SECOND_SESSION_ID = "019b7a12-0280-75e5-8510-ada11a5a3402";

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

function DirectoryProbe(props: {
  readonly growth: GrowthPort;
  readonly sessionId: string | undefined;
  readonly onObserve: (state: WorkflowRunDirectoryState) => void;
}): React.JSX.Element {
  props.onObserve(useWorkflowRunDirectory(props.growth, props.sessionId));
  return <></>;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function observeDirectory(
  growth: GrowthPort,
  sessionId: string | undefined,
): {
  readonly observed: WorkflowRunDirectoryState[];
  readonly rescope: (next: string) => void;
} {
  const observed: WorkflowRunDirectoryState[] = [];
  const collect = (state: WorkflowRunDirectoryState): void => {
    observed.push(state);
  };
  const view = render(<DirectoryProbe growth={growth} sessionId={sessionId} onObserve={collect} />);
  return {
    observed,
    rescope: (next) => {
      view.rerender(<DirectoryProbe growth={growth} sessionId={next} onObserve={collect} />);
    },
  };
}

function firstState(observed: readonly WorkflowRunDirectoryState[]): WorkflowRunDirectoryState {
  const state = observed[0];
  if (state === undefined) {
    throw new Error("the probe never rendered, so there is no state to read");
  }
  return state;
}

function lastState(observed: readonly WorkflowRunDirectoryState[]): WorkflowRunDirectoryState {
  const state = observed.at(-1);
  if (state === undefined) {
    throw new Error("the probe never rendered, so there is no state to read");
  }
  return state;
}

function servedSessionIds(state: WorkflowRunDirectoryState): readonly string[] {
  return state.status === "served" ? state.runs.map((run) => run.sessionId) : [];
}

describe("useWorkflowRunDirectory — one read, always about one session", () => {
  afterEach(() => {
    cleanup();
  });

  it("puts no question at all where no session is in scope", () => {
    // `unasked` on the FIRST render as well as the last, so the arm that must stay
    // unasked is held to the same moment as the arm below that must not be.
    const { observed } = observeDirectory(createRefusingGrowthPort(), undefined);
    expect(firstState(observed).status).toBe("unasked");
    expect(lastState(observed).status).toBe("unasked");
  });

  it("is already reading on the first render a session is in scope for", () => {
    // The state was initialised `unasked` and only became `reading` in the effect,
    // which runs after the commit — so every scoped mount painted one frame claiming
    // nobody had asked, which the runs surface draws as "no session is in scope".
    const { observed } = observeDirectory(sessionScopedGrowthPort(), FIRST_SESSION_ID);
    expect(firstState(observed).status).toBe("reading");
  });

  it("settles on the runs the enumeration served for that session", async () => {
    const { observed } = observeDirectory(sessionScopedGrowthPort(), FIRST_SESSION_ID);
    await settle();
    expect(servedSessionIds(lastState(observed))).toEqual([FIRST_SESSION_ID]);
  });

  it("carries the port's own refusal when no wire is registered", async () => {
    const { observed } = observeDirectory(createRefusingGrowthPort(), FIRST_SESSION_ID);
    await settle();
    const settled = lastState(observed);
    expect(settled.status).toBe("unavailable");
    if (settled.status === "unavailable") {
      expect(settled.refusal.code).toBe("wire-unregistered");
    }
    // Never an empty list: that would assert this session holds no runs, a claim
    // about the daemon that nothing established.
    expect(observed.map((state) => state.status)).not.toContain("served");
  });

  it("shows the previous session's runs nowhere once the scope moves", async () => {
    const probe = observeDirectory(sessionScopedGrowthPort(), FIRST_SESSION_ID);
    await settle();
    expect(servedSessionIds(lastState(probe.observed))).toEqual([FIRST_SESSION_ID]);

    act(() => {
      probe.rescope(SECOND_SESSION_ID);
    });

    // Reading, not the first session's rows: before the stamp, those stayed
    // renderable under the second session's name until the effect reset them.
    expect(lastState(probe.observed).status).toBe("reading");

    await settle();
    expect(servedSessionIds(lastState(probe.observed))).toEqual([SECOND_SESSION_ID]);
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
    // passive effect afterwards took them down. The cases here read what each COMMIT
    // carried, which is the only vantage that can tell the two hooks apart.
    const probe = observeStampedRead(useWorkflowRunDirectory, {
      source: labelledGrowthPort("first scenario"),
      subject: FIRST_SESSION_ID,
    });
    await settle();
    expect(servedDefinitionNames(latestCommitted(probe.committed))).toEqual(["first scenario"]);
    const commitsBeforeSwap = probe.committed.length;

    probe.readdress({ source: labelledGrowthPort("second scenario"), subject: FIRST_SESSION_ID });

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
    const probe = observeStampedRead(useWorkflowRunDirectory, {
      source: growth,
      subject: FIRST_SESSION_ID,
    });
    await settle();

    probe.readdress({ source: growth, subject: FIRST_SESSION_ID });

    expect(servedDefinitionNames(latestCommitted(probe.committed))).toEqual(["first scenario"]);
  });
});
