// The manual retry, and the two things a control with no rendered state has to get
// right: how many runtimes one gesture spawns, and what a press that fails says.
//
// THE RULE IT IS THE EXCEPTION TO, asserted first. The shell's mutation block closes
// every daemon-bound write while the supervisor is reconnecting, incompatible,
// offline, or stopped, and the runtime's own lifecycle controls are how a person gets
// out of that state — so the first case drives this action in exactly the state that
// raises the block.
//
// THE DEFECT THE REST OF THE FILE PINS. Nothing here renders a disabled state: the
// retry sits on a banner whose own presence is the affordance, so there was no flag to
// read and nothing at all between a double-click and two concurrent spawns of the same
// runtime. The supervisor's next report is what eventually says `starting`, and it
// arrives over a subscription several frames after the press — so every case below
// puts the second press AFTER a macrotask boundary rather than inside the first press's
// own tick, which is the harder claim and the one a person actually makes.
//
// AND THE SLOT HAS TO COME BACK ON EVERY WAY THE SPAWN CAN END. A key released only on
// the answered arm leaves the control dead for the life of the window the first time
// the supervisor refuses — with the reason nowhere on screen, which is the shape
// `settings/pages/daemon/daemon-controls.ts` records having shipped once already.

import { act, render } from "@testing-library/react";

import { describe, expect, it } from "vitest";

import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";
import { unhandledRejectionsDuring } from "../../core/unhandled-rejection.test-support.js";
import { SidekicksBridgeProvider, type ConsoleBridge } from "../../bridge/index.js";
import {
  fixtureBridgeWithGrowth,
  growthRefusing,
  growthServing,
} from "../../bridge/fixture/call-plane/bridge.test-support.js";
import type { GrowthOutcome } from "../../bridge/growth-port/growth-outcome.js";
import { SHELL_SCENARIO } from "../../bridge/scenarios/shell.js";
import { FrameStore, shellMutationBlock } from "../../store/index.js";
import { CONNECTED_SHELL_REPORT, refusingBridge } from "./shell-status.test-support.js";
import { useDaemonStartAction } from "./shell-status-binding.js";

/** How one case answers the spawn: served, refused, held open, or rejected. */
type SpawnAnswer = (request: unknown) => Promise<GrowthOutcome<undefined>>;

/** The fixture with a spawn that records every press and answers as the case says. */
function bridgeStartingWith(starts: string[], answer: SpawnAnswer): ConsoleBridge {
  return fixtureBridgeWithGrowth(SHELL_SCENARIO, {
    daemonStart: async (request) => {
      starts.push("daemonStart");
      return await answer(request);
    },
  });
}

/** A spawn that never answers: what a second press meets while the first is in flight. */
function heldOpen(): SpawnAnswer {
  return () => new Promise<never>(() => undefined);
}

/** The retry, mounted the way the frame's offline banner mounts it. */
function RetryHarness(props: { readonly store: FrameStore }): React.JSX.Element {
  const start = useDaemonStartAction(props.store);
  return (
    <button type="button" onClick={start}>
      Start the local runtime
    </button>
  );
}

/** A window told the runtime is gone: every mutating act is closed. */
function stoppedStore(): FrameStore {
  const store = new FrameStore({ initialRoute: { kind: "sessions" } });
  store.publishShellReport({ ...CONNECTED_SHELL_REPORT, connection: { kind: "stopped" } });
  return store;
}

/** Mount the retry over one bridge, and hand back a press the case can repeat. */
function mountRetry(store: FrameStore, bridge: ConsoleBridge): () => Promise<void> {
  const { getByRole } = render(
    <SidekicksBridgeProvider bridge={bridge}>
      <RetryHarness store={store} />
    </SidekicksBridgeProvider>,
  );
  return async () => {
    await act(async () => {
      getByRole("button", { name: "Start the local runtime" }).click();
      await crossMacrotaskBoundary();
    });
  };
}

describe("useDaemonStartAction", () => {
  it("spawns the runtime in exactly the state that blocks every daemon call", async () => {
    // The rule this pins: the shell's mutation block closes daemon-bound writes, and
    // the runtime's OWN lifecycle controls are the way back from the state that
    // raised it. A block applied to this action would leave a stopped runtime with no
    // control that could start it.
    const store = stoppedStore();
    expect(shellMutationBlock(store.getState().shellState)).toBeDefined();

    const starts: string[] = [];
    const press = mountRetry(store, bridgeStartingWith(starts, growthServing(undefined)));
    await press();

    expect(starts).toStrictEqual(["daemonStart"]);
    // And it claimed nothing about the outcome: the supervisor's next report is what
    // says whether the runtime came back.
    expect(store.getState().shellState.connection.kind).toBe("stopped");
  });

  it("raises the port's refusal on the frame's banner stack — the control", async () => {
    // Without this the case above passes for an action that swallowed every answer:
    // a press that resolves in silence is indistinguishable from one that is broken.
    const store = stoppedStore();
    const press = mountRetry(store, refusingBridge());
    await press();

    expect(store.getState().banners).toHaveLength(1);
  });

  it("puts one spawn for a double press while the first is still running", async () => {
    // The defect. Two presses against a spawn that has not answered used to reach the
    // shell twice and start the same runtime concurrently — and the report that would
    // eventually have said `starting` is several frames away, so the whole window
    // between the press and that frame was the window in which it happened.
    const starts: string[] = [];
    const press = mountRetry(stoppedStore(), bridgeStartingWith(starts, heldOpen()));

    await press();
    await press();

    expect(starts).toStrictEqual(["daemonStart"]);
  });

  it("gives the slot back once the spawn has answered", async () => {
    // The positive control for the release: without it the case above is satisfied by
    // an action that takes the slot once and never returns it, which is a control that
    // works exactly one time per window.
    const starts: string[] = [];
    const press = mountRetry(stoppedStore(), bridgeStartingWith(starts, growthServing(undefined)));

    await press();
    await press();

    expect(starts).toStrictEqual(["daemonStart", "daemonStart"]);
  });

  it("gives the slot back when the spawn REFUSES", async () => {
    // The arm a slot released on the answered path alone would miss. A refused spawn
    // ended the act as surely as a served one did, and leaving the key held would kill
    // the one control a stopped runtime has left.
    const starts: string[] = [];
    const store = stoppedStore();
    const press = mountRetry(store, bridgeStartingWith(starts, growthRefusing("daemonStart")));

    await press();
    await press();

    expect(starts).toStrictEqual(["daemonStart", "daemonStart"]);
    // One banner and not two: the stack is keyed on origin and code, so the second
    // refusal replaces its own sentence rather than stacking a duplicate of it.
    expect(store.getState().banners).toHaveLength(1);
  });

  it("settles a spawn that REJECTED as a refusal, and lets nothing escape", async () => {
    // The port is TYPED to resolve, and the rejection channel of a promise exists
    // whether a contract uses it or not. Read only on the fulfilment arm, a transport
    // that went away mid-spawn escaped this action's detached body as an unhandled
    // rejection: no banner, and a slot the `finally` did give back into a control that
    // had said nothing about why the last press did nothing.
    const starts: string[] = [];
    const store = stoppedStore();
    const bridge = bridgeStartingWith(starts, async () => {
      throw new Error("the shell could not reach the supervisor");
    });

    const escaped = await unhandledRejectionsDuring(async () => {
      const press = mountRetry(store, bridge);
      await press();
      await press();
    });

    expect(escaped).toStrictEqual([]);
    expect(starts).toStrictEqual(["daemonStart", "daemonStart"]);
    // And what it says is what happened, rather than a fixed sentence about a seam:
    // the rejection's own message is the only account of why the spawn did not run.
    expect(store.getState().banners).toStrictEqual([
      {
        id: "growth-read:growth-read-call-failed",
        dismissible: true,
        code: "growth-read-call-failed",
        detail: "the shell could not reach the supervisor",
      },
    ]);
  });
});
