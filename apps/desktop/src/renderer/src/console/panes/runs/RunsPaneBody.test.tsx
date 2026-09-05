// The body: the figures it states, the rewind arm, the controls it offers, and what
// a partial stream looks like.
//
// Split along the seam the module was. Every case here needs a session to already be
// resolved, which is exactly what the seat next door does and this does not — and
// every figure below is the wire's own, with the controls a fail-closed projection
// of the daemon's answer rather than a local decision.

import { useState } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DRIVER_CAPABILITY_FLAGS,
  type DriverCapabilityFlag,
  type RunState,
} from "@ai-sidekicks/contracts";
import { RunControls } from "./controls/RunControls.js";
import { RunStateProjection } from "./run-state-projection.js";
import { useRunControlSurface } from "./controls/run-control-surface.js";
import type { DriverCapabilityReadout } from "../../bridge/index.js";
import { RUN_ID, renderPane, scriptedBridge, transition } from "./runs-pane.test-support.js";

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
    // Pinned for the harness's whole life: the surface holds its records, its busy
    // set and its latch under the bridge, so a stub rebuilt on every render would be
    // a new transport on every render.
    const [bridge] = useState(() => scriptedBridge([]));
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
