// The deck's half of "Step in", driven: which checkout it opens, which pane addresses
// the composer, and what it says when neither is resolvable.
//
// THE RESOLUTION IS THE CLAIM. A run's checkout is named by `createdByRunId` on the
// execution-root read and by nothing else, so the two ways to get this wrong are
// opening a retired record and picking one of several. Both are cases below, and both
// answer a disposition the receipt renders rather than a pane.
//
// The fixture bridge is the collaborator rather than a hand-rolled double, for the
// reason `StepIn.test.tsx` gives: a double answers whatever this file taught it and
// would prove nothing about the shape the wire actually admits.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleScenario } from "../../bridge/scenario-runtime/scenario.js";
import { DECK_RESTORED_PANE_CAP } from "../../core/index.js";
import { takeTheFloor, unregisterTakeTheFloorHandler } from "../../seats/index.js";
import { SessionStore } from "../../store/index.js";
import { DeckLayout } from "./deck-layout.js";
import { resolveRunWorktreeId, useTakeTheFloorSeat } from "./take-the-floor.js";

/** A real UUID, because the registered session identifier is a branded UUID. */
const SESSION_ID = "9f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const AGENT_ID = "agent-ada";
/** Every identifier the execution-root read carries is a branded UUID on the wire. */
const OTHER_RUN_ID = "5b1c9d40-8f2a-4c31-9d77-2e6a41b0c9de";
const MOUNT_ID = "7c2d0e51-9a3b-4d42-8e88-3f7b52c1dae0";
const WORKTREE_MINE = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const WORKTREE_OTHER = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
const WORKTREE_SECOND = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";

/** One worktree row, carried as the read carries it. */
function worktreeRow(overrides: {
  readonly worktreeId: string;
  readonly createdByRunId?: string;
  readonly state?: string;
}): Record<string, unknown> {
  return {
    worktreeId: overrides.worktreeId,
    repoMountId: MOUNT_ID,
    branchName: "feature/step-in",
    fsRoot: `/checkouts/${overrides.worktreeId}`,
    state: overrides.state ?? "ready",
    createdBySessionId: SESSION_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(overrides.createdByRunId === undefined ? {} : { createdByRunId: overrides.createdByRunId }),
  };
}

function bridgeServing(worktrees: readonly Record<string, unknown>[]): ConsoleBridge {
  const scenario: ConsoleScenario = {
    id: "take-the-floor-unit",
    label: "Take the floor unit",
    purpose: "One canned execution-root read, so the deck's resolution is observable.",
    sessionId: SESSION_ID,
    participantIdsInJoinOrder: ["participant-you"],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    beats: [],
    replies: [
      {
        call: "repo.worktreeStatusRead",
        result: { worktrees, ephemeralClones: [] },
      },
    ],
  };
  return createFixtureBridge({ scenario });
}

/** A store holding one run, bound to one agent exactly as the wire binds it. */
function storeWithBoundRun(agentId: string | undefined): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({
    cursor: 1,
    participantJoinLog: [],
    entities: [
      {
        kind: "run",
        id: RUN_ID,
        state: "running",
        ...(agentId === undefined ? {} : { body: { agentId } }),
      },
    ],
  });
  return store;
}

/** Mount the seat over one deck, and hand back the deck the acts move. */
function mountedDeckOver(bridge: ConsoleBridge, sessionStore: SessionStore): DeckLayout {
  const layout = new DeckLayout({ restoredPaneCap: DECK_RESTORED_PANE_CAP });
  function FloorHost(): null {
    useTakeTheFloorSeat({ layout, bridge, sessionStore });
    return null;
  }
  render(<FloorHost />);
  return layout;
}

afterEach(() => {
  // The seat is module scope, so a case that filled it would leak into the next one.
  unregisterTakeTheFloorHandler();
});

describe("resolveRunWorktreeId", () => {
  it("names the one live checkout this run created", () => {
    expect(
      resolveRunWorktreeId(
        [
          worktreeRow({ worktreeId: WORKTREE_OTHER, createdByRunId: OTHER_RUN_ID }),
          worktreeRow({ worktreeId: WORKTREE_MINE, createdByRunId: RUN_ID }),
        ] as never,
        RUN_ID,
      ),
    ).toStrictEqual({ disposition: "opened", worktreeId: WORKTREE_MINE });
  });

  it("does not send a person to a retired record", () => {
    expect(
      resolveRunWorktreeId(
        [
          worktreeRow({ worktreeId: WORKTREE_MINE, createdByRunId: RUN_ID, state: "retired" }),
        ] as never,
        RUN_ID,
      ),
    ).toStrictEqual({ disposition: "unnamed" });
  });

  it("refuses to pick between two live checkouts naming one run", () => {
    expect(
      resolveRunWorktreeId(
        [
          worktreeRow({ worktreeId: WORKTREE_MINE, createdByRunId: RUN_ID }),
          worktreeRow({ worktreeId: WORKTREE_SECOND, createdByRunId: RUN_ID }),
        ] as never,
        RUN_ID,
      ),
    ).toStrictEqual({ disposition: "ambiguous" });
  });

  it("negative control: a run naming no row at all is unnamed, not ambiguous", () => {
    // Without this the two cases above would pass over a resolution that answered
    // `ambiguous` for everything it could not name.
    expect(resolveRunWorktreeId([], RUN_ID)).toStrictEqual({ disposition: "unnamed" });
  });
});

describe("the deck's two acts", () => {
  it("opens the run's checkout and leaves the agent's pane focused", async () => {
    // The ORDER is the claim: the composer resolves its address from the focused
    // pane, so a worktree pane focused last would leave the composer on the channel
    // path and make "you have the floor" false.
    const layout = mountedDeckOver(
      bridgeServing([worktreeRow({ worktreeId: WORKTREE_MINE, createdByRunId: RUN_ID })]),
      storeWithBoundRun(AGENT_ID),
    );

    const outcome = await takeTheFloor({ runId: RUN_ID });

    expect(outcome).toStrictEqual({
      status: "moved",
      composerAddressed: true,
      worktree: "opened",
    });
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual([
      "inspector",
      "agent-console",
    ]);
    const focused = layout
      .snapshot()
      .panes.find((pane) => pane.paneId === layout.snapshot().focusedPaneId);
    expect(focused?.kind).toBe("agent-console");
    expect(focused?.entity).toStrictEqual({ kind: "agent", id: AGENT_ID });
  });

  it("says the composer was not addressed when the store names no agent", async () => {
    const layout = mountedDeckOver(
      bridgeServing([worktreeRow({ worktreeId: WORKTREE_MINE, createdByRunId: RUN_ID })]),
      storeWithBoundRun(undefined),
    );

    const outcome = await takeTheFloor({ runId: RUN_ID });

    expect(outcome).toStrictEqual({
      status: "moved",
      composerAddressed: false,
      worktree: "opened",
    });
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual(["inspector"]);
  });

  it("carries a refused execution-root read as its own disposition", async () => {
    // The read refusing is the daemon's answer, not an absence: a person told "this
    // run names no checkout" when nobody could look would go and check the wrong
    // thing.
    const scenario: ConsoleScenario = {
      id: "take-the-floor-refusal",
      label: "Take the floor refusal",
      purpose: "The execution-root read refuses, so the deck's third disposition is reachable.",
      sessionId: SESSION_ID,
      participantIdsInJoinOrder: ["participant-you"],
      startedAtIso: "2026-01-01T00:00:00.000Z",
      beats: [],
      replies: [
        {
          call: "repo.worktreeStatusRead",
          refusal: { code: "session.not_found", message: "No such session." },
        },
      ],
    };
    const layout = mountedDeckOver(createFixtureBridge({ scenario }), storeWithBoundRun(AGENT_ID));

    const outcome = await takeTheFloor({ runId: RUN_ID });

    expect(outcome).toStrictEqual({
      status: "moved",
      composerAddressed: true,
      worktree: "unreadable",
    });
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual(["agent-console"]);
  });

  it("opens no pane and says why when the run names no checkout", async () => {
    const layout = mountedDeckOver(bridgeServing([]), storeWithBoundRun(AGENT_ID));

    const outcome = await takeTheFloor({ runId: RUN_ID });

    expect(outcome).toStrictEqual({
      status: "moved",
      composerAddressed: true,
      worktree: "unnamed",
    });
    expect(layout.snapshot().panes.map((pane) => pane.kind)).toStrictEqual(["agent-console"]);
  });
});
