// Dispatch: which comparand goes out, and whether the form outlives its own send.

import { useState } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunControlCalls } from "../../run-controls/services/run-control-dispatch.js";
import { SteerBox } from "./SteerBox.js";
import { useRunControlDispatch } from "../../run-controls/hooks/useRunControlDispatch.js";
import {
  APPLIED_STEER,
  bodyValue,
  inertBridge,
  interventionCalls,
  renderSteerBox,
  runAt,
  submit,
  type ScriptedAnswer,
  typeInto,
} from "./steer-box.test-support.js";
import type { RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";

describe("the composer outlives its dispatch", () => {
  const REJECTED_STEER: ScriptedAnswer = () => ({
    interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
    interventionType: "steer",
    state: "rejected",
    rejectionReason: "run_not_paused",
    runVersion: 9,
  });

  it("keeps the text and shows the daemon's own reason when the intervention is rejected", async () => {
    const { container, dismissCount } = renderSteerBox(REJECTED_STEER);
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop editing that file");
    await submit(container);
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("stop editing that file");
    expect(container.textContent).toContain("run_not_paused");
  });

  it("negative control: a settlement that landed closes the composer", async () => {
    // Without this the cases above would pass over a form that never closed.
    const { container, dismissCount } = renderSteerBox();
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop editing that file");
    await submit(container);
    expect(dismissCount()).toBe(1);
  });

  it("latches the confirm while the dispatch is in flight, so one body sends once", async () => {
    // A never-settling answer holds the form in its sending state; the second submit comes
    // through the form, as a keyboard one does, not through the button.
    const { container, calls } = renderSteerBox(() => new Promise(() => undefined));
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop editing that file");
    await submit(container);
    const form = container.querySelector(".meridian-run-composer");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("the composer drew no form");
    }
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(calls).toHaveLength(1);
  });
});

describe("the comparand is the newer of the two readings", () => {
  // One bridge for the harness's whole life so the dispatcher's cache survives a rerender.
  // The applied answer reports version 9, which the dispatcher caches; the stream then
  // reports 10.
  function StableHarness(props: {
    readonly calls: RunControlCalls;
    readonly runVersion: number;
  }): React.JSX.Element {
    const [bridge] = useState(inertBridge);
    const dispatchState = useRunControlDispatch(bridge, props.calls);
    return (
      <SteerBox
        key={props.runVersion}
        bridge={bridge}
        run={runAt("paused", props.runVersion)}
        dispatchState={dispatchState}
        onDismiss={() => undefined}
      />
    );
  }

  async function steerAt(container: HTMLElement): Promise<void> {
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop editing that file");
    await submit(container);
  }

  it("sends the stream's version once it has moved past the cached settlement", async () => {
    const calls: RecordedDaemonCall[] = [];
    const runControlCalls = interventionCalls(calls, APPLIED_STEER);
    const { container, rerender } = render(
      <StableHarness calls={runControlCalls} runVersion={8} />,
    );
    await steerAt(container);
    expect(calls[0]?.params).toMatchObject({ expectedRunVersion: 8 });
    rerender(<StableHarness calls={runControlCalls} runVersion={10} />);
    await steerAt(container);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 10 });
  });

  it("negative control: the cached settlement still wins over a stream that is behind it", async () => {
    const calls: RecordedDaemonCall[] = [];
    const runControlCalls = interventionCalls(calls, APPLIED_STEER);
    const { container, rerender } = render(
      <StableHarness calls={runControlCalls} runVersion={8} />,
    );
    await steerAt(container);
    rerender(<StableHarness calls={runControlCalls} runVersion={8} />);
    await steerAt(container);
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 9 });
  });
});
