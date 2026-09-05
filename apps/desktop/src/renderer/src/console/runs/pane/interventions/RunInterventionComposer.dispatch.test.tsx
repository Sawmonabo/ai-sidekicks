// Dispatch: which comparand goes out, and whether the form outlives its own send.
//
// Every case here is about the interval between a press and a settlement — a composer
// that outlives its own dispatch, and a version that advanced between two readings. A
// surface that sent a comparand it had already been told was stale would be wrong in
// exactly this interval and nowhere else.
//
// What the form is KEYED by, and when a dispatch is recorded at all, are the other
// half of the same seam and live in `RunInterventionComposer.keying.test.tsx`: those
// cases re-key a form under an open send, which is a premise none of these take.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { RunInterventionComposer } from "./RunInterventionComposer.js";
import { useRunControlSurface } from "../controls/run-control-surface.js";
import {
  APPLIED_ROLLBACK,
  bodyValue,
  renderComposer,
  runAt,
  interventionDispatchBridge,
  submit,
  type ScriptedAnswer,
  typeInto,
} from "./run-intervention-composer.test-support.js";
import type { RecordedDaemonCall } from "../../../bridge/fixture-bridge.test-support.js";

describe("the composer outlives its dispatch", () => {
  const REJECTED_ROLLBACK: ScriptedAnswer = () => ({
    interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
    interventionType: "rollback",
    state: "rejected",
    rejectionReason: "target-position-not-a-boundary",
    runVersion: 9,
  });

  const TRANSPORT_REJECTION: ScriptedAnswer = () => {
    throw { code: "run.invalid_transition", message: "the run is not in a rewindable state" };
  };

  it("keeps the replacement text when the dispatch is refused at transport", async () => {
    const { container, dismissCount } = renderComposer("rollback", TRANSPORT_REJECTION);
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "try this instead");
    await submit(container);
    // The one thing the participant cannot reproduce is the one thing that used to
    // be dropped: the form closed the moment the dispatch STARTED.
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("try this instead");
    expect(container.textContent).toContain("run.invalid_transition");
  });

  it("keeps the text and shows the daemon's own reason when the intervention is rejected", async () => {
    const { container, dismissCount } = renderComposer("rollback", REJECTED_ROLLBACK);
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    typeInto(container.querySelector(".meridian-run-composer__body"), "try this instead");
    await submit(container);
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("try this instead");
    expect(container.textContent).toContain("target-position-not-a-boundary");
  });

  it("keeps a refused steer's directive rather than dropping it", async () => {
    const { container, dismissCount } = renderComposer("steer", TRANSPORT_REJECTION);
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop editing that file");
    await submit(container);
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("stop editing that file");
  });

  it("negative control: a settlement that landed closes the composer", async () => {
    // Without this the three cases above would pass over a form that never closed at
    // all, which would leave a landed rewind sitting behind its own composer.
    const { container, dismissCount } = renderComposer("rollback");
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    await submit(container);
    expect(dismissCount()).toBe(1);
  });

  it("latches the confirm while the dispatch is in flight, so one body sends once", async () => {
    // A never-settling answer holds the form in its sending state; the second submit
    // arrives the way a keyboard one does, through the form rather than the button.
    const { container, calls } = renderComposer("rollback", () => new Promise(() => undefined));
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
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
  // One bridge for the surface's whole life, so the dispatcher's cache survives a
  // rerender; the composer itself is remounted (keyed) each time the stream's
  // reading of the run moves. The applied answer reports version 9, which the
  // dispatcher caches; the stream then reports 10.
  function StableHarness(props: {
    readonly bridge: ConsoleBridge;
    readonly runVersion: number;
  }): React.JSX.Element {
    const surface = useRunControlSurface(props.bridge);
    return (
      <RunInterventionComposer
        key={props.runVersion}
        bridge={props.bridge}
        run={runAt("paused", props.runVersion)}
        control="rollback"
        surface={surface}
        onDismiss={() => undefined}
      />
    );
  }

  async function rewindAt(container: HTMLElement): Promise<void> {
    typeInto(container.querySelector(".meridian-run-composer__position"), "4");
    await submit(container);
  }

  it("sends the stream's version once it has moved past the cached settlement", async () => {
    const calls: RecordedDaemonCall[] = [];
    const bridge = interventionDispatchBridge(calls, APPLIED_ROLLBACK);
    const { container, rerender } = render(<StableHarness bridge={bridge} runVersion={8} />);
    await rewindAt(container);
    expect(calls[0]?.params).toMatchObject({ expectedRunVersion: 8 });
    rerender(<StableHarness bridge={bridge} runVersion={10} />);
    await rewindAt(container);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 10 });
  });

  it("negative control: the cached settlement still wins over a stream that is behind it", async () => {
    const calls: RecordedDaemonCall[] = [];
    const bridge = interventionDispatchBridge(calls, APPLIED_ROLLBACK);
    const { container, rerender } = render(<StableHarness bridge={bridge} runVersion={8} />);
    await rewindAt(container);
    rerender(<StableHarness bridge={bridge} runVersion={8} />);
    await rewindAt(container);
    expect(calls[1]?.params).toMatchObject({ expectedRunVersion: 9 });
  });
});
