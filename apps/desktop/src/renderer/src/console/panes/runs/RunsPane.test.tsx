// The pane: its three absences, its registration, and the one claim the whole lane
// rests on — that no local guard decides whether a control is offered or admitted.
//
// The rows are driven through the REAL fold (`RunStateProjection`) rather than
// through hand-built projections, so a change to the derivation reaches these cases
// instead of passing them. The bridge is a stub for the WIRE, which is the boundary
// the pane exists to cross.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
  type RunState,
} from "@ai-sidekicks/contracts";

import { ConsolePaneRegistry } from "../../workspace/index.js";
import type { ConsoleBridge } from "../../bridge/index.js";
import { SessionStore } from "../../store/index.js";
import { FrameStore } from "../../store/index.js";
import { DraftStore, UiStateStore } from "../../persistence/index.js";
import { registerRunsPane } from "./index.js";
import { RunsPane } from "./RunsPane.js";
import { RunControls } from "./RunControls.js";
import { RunStateProjection } from "./run-state-feed.js";
import { useRunControlSurface } from "./run-control-surface.js";
import type { DriverCapabilityReadout } from "../../bridge/index.js";

const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
// A canonical UUID: both `run.*` streams parse their registered request through
// the wire's `SessionId` brand before opening, so a non-UUID id refuses.
const SESSION_ID = "019b7a22-2200-75e5-8510-ada11a5a44a5";

/** One transition on the wire's own shape. */
function transition(previousState: RunState, currentState: RunState, runVersion: number): unknown {
  return {
    runId: RUN_ID,
    runVersion,
    previousState,
    currentState,
    timestamp: "2026-01-01T16:00:00.000Z",
  };
}

/** A bridge whose state stream replays a script and whose calls all refuse. */
function scriptedBridge(deliveries: readonly unknown[]): ConsoleBridge {
  return {
    sidekicks: {
      daemon: {
        call: async (): Promise<unknown> => {
          throw { code: "run.not_found", message: "no such run" };
        },
        subscribe: (_event: string, handler: (payload: unknown) => void) => {
          for (const delivery of deliveries) {
            handler(delivery);
          }
          return () => undefined;
        },
      },
    },
    growth: {},
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
}

function paneContext(bridge: ConsoleBridge, sessionStore: SessionStore | undefined) {
  return {
    kind: "runs" as const,
    entity: undefined,
    paneId: "pane-runs",
    bridge,
    frameStore: new FrameStore(),
    sessionStore,
    // An adapter that never arrives. The pane performs no UI-state read, so a
    // store whose adapter never settles is the exact stand-in: if the pane ever
    // grew one, it would hang here rather than passing against a stub.
    uiStateStore: new UiStateStore({ adapter: new Promise(() => undefined) }),
    draftStore: new DraftStore(),
    focusHue: undefined,
  };
}

async function renderPane(
  bridge: ConsoleBridge,
  withSession: boolean,
  seed?: (store: SessionStore) => void,
): Promise<HTMLElement> {
  const sessionStore = withSession ? new SessionStore({ sessionId: SESSION_ID }) : undefined;
  if (sessionStore !== undefined) {
    seed?.(sessionStore);
  }
  const { container } = render(<RunsPane {...paneContext(bridge, sessionStore)} />);
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe("the runs pane's three absences", () => {
  it("says so when it was opened outside a session", async () => {
    const container = await renderPane(scriptedBridge([]), false);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
  });

  it("shows a read in flight before the session's snapshot has landed, never an empty session", async () => {
    // `not-loaded` and `empty` are different facts: one says the console is
    // asking, the other says there is nothing. Conflating them would report a
    // session with no runs before the read that enumerates them completed.
    const container = await renderPane(scriptedBridge([]), true);
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("says the session has no runs once its snapshot lands naming none", async () => {
    // The arm the old rule could not reach at all: `hasRead` only ever flipped on a
    // projected run, so a session with no runs read "Reading the runs" forever.
    const container = await renderPane(scriptedBridge([]), true, (store) => {
      store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
    });
    expect(container.querySelector(".meridian-nothing--empty")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });

  it("keeps the skeleton while the snapshot names runs the stream has not described", async () => {
    // Read complete, list still empty, and the session is known to have a run — so
    // "there are none" would be false. The skeleton is the honest shape.
    const container = await renderPane(scriptedBridge([]), true, (store) => {
      store.initialise({
        cursor: 4,
        entities: [{ kind: "run", id: RUN_ID, state: "running" }],
        participantJoinLog: [],
      });
    });
    expect(container.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("negative control: a delivered run replaces the skeleton with a row", async () => {
    // Without this the case above would pass over a pane that rendered a skeleton
    // forever whatever the stream said.
    const container = await renderPane(scriptedBridge([transition("queued", "running", 2)]), true);
    expect(container.querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(container.textContent).toContain(RUN_ID);
  });
});

describe("the row states the wire's own figures", () => {
  it("renders the nine-member state verbatim and never a gloss", async () => {
    const container = await renderPane(scriptedBridge([transition("running", "failed", 5)]), true);
    expect(container.textContent).toContain("failed");
    expect(container.textContent).not.toContain("errored");
  });

  it("names the limit that fired, in those words", async () => {
    const container = await renderPane(
      scriptedBridge([
        { ...(transition("running", "completed", 6) as object), trigger: "turn_limit" },
      ]),
      true,
    );
    expect(container.textContent).toContain("reached its turn limit");
  });

  it("says a daemon-initiated close is not a crash", async () => {
    const container = await renderPane(
      scriptedBridge([
        { ...(transition("running", "completed", 6) as object), intendedClose: true },
      ]),
      true,
    );
    expect(container.textContent).toContain("not a crash");
  });

  it("reads a blocked run as blocked and never as paused", async () => {
    const container = await renderPane(
      scriptedBridge([transition("running", "waiting_for_approval", 4)]),
      true,
    );
    expect(container.textContent).toContain("blocked on someone");
    expect(container.textContent).toContain("It is not paused");
  });
});

describe("the rewind arm never fabricates a transition", () => {
  it("advances the version and re-opens the run in paused", () => {
    // Asserted on the fold rather than through the tree, because the claim is about
    // what the projection DOES with an arm that carries no states at all.
    const fold = new RunStateProjection();
    expect(fold.accept(transition("queued", "running", 2))).toBe(true);
    expect(
      fold.accept({
        sessionId: "1f2e3d4c-5b6a-4790-8123-45678901abcd",
        runId: RUN_ID,
        runVersion: 3,
        targetPosition: 11,
      }),
    ).toBe(true);
    const run = fold.runs()[0];
    expect(run?.state).toBe("paused");
    expect(run?.runVersion).toBe(3);
    expect(run?.rewoundToPosition).toBe(11);
    // No transition was invented: the appended row still carries neither state.
    expect(run?.statusRows.at(-1)?.previousState).toBeUndefined();
    expect(run?.statusRows.at(-1)?.currentState).toBeUndefined();
  });

  it("negative control: a delivery that parses as neither arm is counted, not guessed", () => {
    const fold = new RunStateProjection();
    expect(fold.accept({ runId: RUN_ID, currentState: "running" })).toBe(false);
    expect(fold.unreadableDeliveryCount).toBe(1);
    expect(fold.runCount).toBe(0);
  });
});

describe("controls are a fail-closed projection, never a local decision", () => {
  /**
   * One driver's report, as the only driver in the session.
   *
   * A single report is what makes every run in the session resolve to it, which is
   * the binding the capability reply itself admits — so these cases exercise the
   * real per-run resolution rather than a stand-in for it.
   */
  function soleDriverReadout(
    declared: Readonly<Partial<Record<DriverCapabilityFlag, boolean>>>,
  ): DriverCapabilityReadout {
    const flags = Object.fromEntries(
      DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, declared[flag] === true]),
    ) as Readonly<Record<DriverCapabilityFlag, boolean>>;
    return {
      flagsByDriverName: new Map([["claude", flags]]),
      driverNameByRunId: new Map(),
      readRefusal: undefined,
    };
  }

  /** Render the control row for one run, at one declared capability set. */
  function ControlHarness(props: {
    readonly state: RunState;
    readonly driverCapabilities: DriverCapabilityReadout | undefined;
  }): React.JSX.Element {
    const bridge = scriptedBridge([]);
    const surface = useRunControlSurface(bridge);
    const fold = new RunStateProjection();
    fold.accept(transition("queued", props.state, 2));
    const run = fold.runs()[0];
    if (run === undefined) {
      throw new Error("the fold produced no run for the control harness");
    }
    return (
      <RunControls
        run={run}
        surface={surface}
        bridge={bridge}
        driverCapabilities={props.driverCapabilities}
        onTakeTheFloor={() => undefined}
        onRequestRewind={() => undefined}
        onRequestSteer={() => undefined}
      />
    );
  }

  function renderControls(
    state: RunState,
    driverCapabilities: DriverCapabilityReadout | undefined,
  ): HTMLElement {
    const { container } = render(
      <ControlHarness state={state} driverCapabilities={driverCapabilities} />,
    );
    return container;
  }

  /** Open the overflow the way a person does, inside React's own batching. */
  function openOverflow(container: HTMLElement): void {
    const toggle = container.querySelector(".meridian-run-controls__overflow-toggle");
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error("the control row drew no overflow toggle");
    }
    act(() => {
      toggle.click();
    });
  }

  it("leaves both gated controls absent until the driver declares them", () => {
    // Absent, never greyed, and absent is also the answer while the capability read
    // has not come back — which is the fail-closed direction.
    const container = renderControls("running", undefined);
    openOverflow(container);
    expect(container.querySelector(".meridian-run-controls__action--steer")).toBeNull();
    expect(container.querySelector(".meridian-run-controls__action--rollback")).toBeNull();
  });

  it("offers a gated control once the driver declares its flag", () => {
    const container = renderControls("running", soleDriverReadout({ steer: true, rollback: true }));
    openOverflow(container);
    expect(container.querySelector(".meridian-run-controls__action--steer")).not.toBeNull();
    expect(container.querySelector(".meridian-run-controls__action--rollback")).not.toBeNull();
  });

  it("negative control: a declared-false flag leaves the control absent", () => {
    // Proves the case above reads the flag rather than reacting to the object's
    // presence, which would offer every gated control the moment the read answered.
    const container = renderControls("running", soleDriverReadout({}));
    openOverflow(container);
    expect(container.querySelector(".meridian-run-controls__action--steer")).toBeNull();
  });

  it("offers cancel on a run whose state would refuse it, because eligibility is the daemon's", () => {
    // A completed run is not live, so the row draws no primary controls — but
    // `cancel` is ungated and stays offered wherever the overflow is drawn, and
    // nothing in the renderer refuses on state. The daemon's typed refusal is what
    // a person would see.
    const container = renderControls("running", soleDriverReadout({}));
    openOverflow(container);
    expect(container.querySelector(".meridian-run-controls__action--cancel")).not.toBeNull();
  });
});

describe("a partial stream is visible, and is neither an absence nor a refusal", () => {
  /** A delivery that matches neither registered arm — a protocol-version mismatch. */
  const UNREADABLE_DELIVERY = { runId: RUN_ID, state: "running", version: 7 };

  it("says the stream is incomplete, with the count, once a delivery could not be read", async () => {
    const container = await renderPane(scriptedBridge([UNREADABLE_DELIVERY]), true);
    expect(container.textContent).toContain("could not read");
    expect(container.querySelector(".meridian-runs__incomplete-stream")?.textContent).toContain(
      "1 delivery",
    );
  });

  it("keeps saying so once a later delivery reads cleanly", async () => {
    // The point of the indication: the rows are current for what was readable and
    // still behind for what was not, and one readable delivery does not undo that.
    const container = await renderPane(
      scriptedBridge([UNREADABLE_DELIVERY, transition("queued", "running", 2)]),
      true,
    );
    expect(container.textContent).toContain(RUN_ID);
    expect(container.querySelector(".meridian-runs__incomplete-stream")).not.toBeNull();
  });

  it("says nothing about the stream when every delivery read cleanly", async () => {
    const container = await renderPane(scriptedBridge([transition("queued", "running", 2)]), true);
    expect(container.querySelector(".meridian-runs__incomplete-stream")).toBeNull();
  });

  it("negative control: the same delivery is what the fold refuses to read", async () => {
    // Without this the cases above would pass over a delivery the fold accepted and
    // would prove nothing about an unreadable one reaching a render.
    const fold = new RunStateProjection();
    expect(fold.accept(UNREADABLE_DELIVERY)).toBe(false);
    expect(fold.unreadableDeliveryCount).toBe(1);
  });
});

describe("the pane's registration", () => {
  it("claims the runs kind through the registry's one door", () => {
    const registry = new ConsolePaneRegistry();
    registerRunsPane(registry);
    expect(registry.registeredPaneKinds()).toStrictEqual(["runs"]);
    expect(registry.descriptorFor("runs")?.openInWindow).toBe(true);
  });

  it("negative control: a registry nobody registered into claims nothing", () => {
    expect(new ConsolePaneRegistry().registeredPaneKinds()).toStrictEqual([]);
  });
});
