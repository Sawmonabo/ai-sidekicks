// The steer form: a body typed for one run is never sent to or cleared by another, a dispatch
// is recorded only where the dispatch state admitted it, and the text survives a refusal and
// reaches the wire as typed.

import { useLayoutEffect, useState } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SteerBox } from "./SteerBox.js";
import { useRunControlDispatch } from "../../run-controls/hooks/useRunControlDispatch.js";
import {
  APPLIED_STEER,
  bodyValue,
  interventionCalls,
  renderSteerBox,
  runAt,
  submit,
  type ScriptedAnswer,
  typeInto,
} from "./SteerBox.test-support.js";
import { inertBridge } from "../../composer.test-support.js";
import { RUN_ID, SECOND_RUN_ID } from "../../run-controls/run-control-commands.test-support.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";

describe("the form is keyed by what it is composing against", () => {
  /** A dispatch that never settles, so the form stays pending across the switch. */
  const NEVER_SETTLES: ScriptedAnswer = () => new Promise(() => undefined);

  /**
   * What the DOM held at commit time, read in a layout effect: the frame is written and no
   * passive effect has run, so this is what a person could see and press before any reset
   * done in `useEffect`.
   */
  function CommitProbe(props: {
    readonly record: (committed: { body: string; isConfirmDisabled: boolean }) => void;
  }): null {
    const { record } = props;
    useLayoutEffect(() => {
      const body = document.querySelector(".meridian-run-composer__body");
      const confirm = document.querySelector(".meridian-run-composer__confirm");
      record({
        body: body instanceof HTMLTextAreaElement ? body.value : "<the form drew no body>",
        isConfirmDisabled: confirm instanceof HTMLButtonElement ? confirm.disabled : false,
      });
    });
    return null;
  }

  /**
   * The composer over a run the case can change, with or without the key. The unkeyed arm is
   * the one where the component's own reset has to hold on its own.
   */
  function TargetSwitchHarness(props: {
    readonly runId: string;
    readonly keyed: boolean;
    readonly answer: ScriptedAnswer;
    readonly onCommit?: (committed: { body: string; isConfirmDisabled: boolean }) => void;
  }): React.JSX.Element {
    const [bridge] = useState(inertBridge);
    const [runControlCalls] = useState(() => interventionCalls([], props.answer));
    const dispatchState = useRunControlDispatch(bridge, runControlCalls);
    const { onCommit } = props;
    return (
      <>
        <SteerBox
          key={props.keyed ? props.runId : "fixed"}
          bridge={bridge}
          run={runAt("paused", 8, props.runId)}
          dispatchState={dispatchState}
          onDismiss={() => undefined}
        />
        {onCommit === undefined ? null : <CommitProbe record={onCommit} />}
      </>
    );
  }

  function renderSwitchable(
    keyed: boolean,
    answer: ScriptedAnswer = APPLIED_STEER,
  ): {
    container: HTMLElement;
    retarget: (runId: string) => void;
  } {
    const { container, rerender } = render(
      <TargetSwitchHarness runId={RUN_ID} keyed={keyed} answer={answer} />,
    );
    return {
      container,
      retarget: (runId) => {
        act(() => {
          rerender(<TargetSwitchHarness runId={runId} keyed={keyed} answer={answer} />);
        });
      },
    };
  }

  it("shows the new target's own empty form in the commit that re-addresses", async () => {
    // The commit itself, not the settled state after it: a reset done in a passive effect is
    // one commit late, and a submit in that commit would send the old run's text against the
    // new run's comparand.
    const committed: { body: string; isConfirmDisabled: boolean }[] = [];
    const { container, rerender } = render(
      <TargetSwitchHarness
        runId={RUN_ID}
        keyed={false}
        answer={NEVER_SETTLES}
        onCommit={(reading) => committed.push(reading)}
      />,
    );
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop and re-read the diff");
    await submit(container);
    // The old target's dispatch is parked, so its confirm is latched; that makes the reading
    // after the switch decisive.
    expect(committed.at(-1)).toStrictEqual({
      body: "stop and re-read the diff",
      isConfirmDisabled: true,
    });

    committed.length = 0;
    await act(async () => {
      rerender(
        <TargetSwitchHarness
          runId={SECOND_RUN_ID}
          keyed={false}
          answer={NEVER_SETTLES}
          onCommit={(reading) => committed.push(reading)}
        />,
      );
    });
    expect(committed[0]).toStrictEqual({ body: "", isConfirmDisabled: false });
  });

  it("negative control: a re-render at the same target keeps what was typed", () => {
    // Without this the cases above would pass over a form that cleared itself every render.
    const { container, retarget } = renderSwitchable(false);
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop and re-read the diff");
    retarget(RUN_ID);
    expect(bodyValue(container)).toBe("stop and re-read the diff");
  });
});

describe("a dispatch is recorded only where the dispatch state admitted one", () => {
  function heldAnswer(): { answer: ScriptedAnswer; release: (settlement: unknown) => void } {
    let settle: (settlement: unknown) => void = () => undefined;
    return {
      answer: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
      release: (settlement) => {
        settle(settlement);
      },
    };
  }

  /**
   * One dispatch state, one run, and a form the case can close and reopen while the first
   * request is in flight. The dispatch state survives the remount; its latch is what the
   * second form runs into.
   */
  function ReopenableHarness(props: {
    readonly formKey: string;
    readonly answer: ScriptedAnswer;
    readonly onDismiss: () => void;
  }): React.JSX.Element {
    const [bridge] = useState(inertBridge);
    const [runControlCalls] = useState(() => interventionCalls([], props.answer));
    const dispatchState = useRunControlDispatch(bridge, runControlCalls);
    return (
      <SteerBox
        key={props.formKey}
        bridge={bridge}
        run={runAt("paused")}
        dispatchState={dispatchState}
        onDismiss={props.onDismiss}
      />
    );
  }

  it("refuses and keeps a second body while the first request is settling", async () => {
    const held = heldAnswer();
    let dismissals = 0;
    const { container, rerender } = render(
      <ReopenableHarness
        formKey="first"
        answer={held.answer}
        onDismiss={() => {
          dismissals += 1;
        }}
      />,
    );
    typeInto(container.querySelector(".meridian-run-composer__body"), "the first body");
    await submit(container);
    // Canceled and reopened while the first request is still in flight.
    act(() => {
      rerender(
        <ReopenableHarness
          formKey="second"
          answer={held.answer}
          onDismiss={() => {
            dismissals += 1;
          }}
        />,
      );
    });
    typeInto(container.querySelector(".meridian-run-composer__body"), "the second body");
    await submit(container);
    expect(container.textContent).toContain("still settling");
    expect(bodyValue(container)).toBe("the second body");
    expect(dismissals).toBe(0);
  });

  it("does not let the first request's settlement close the second form", async () => {
    const held = heldAnswer();
    let dismissals = 0;
    const { container, rerender } = render(
      <ReopenableHarness
        formKey="first"
        answer={held.answer}
        onDismiss={() => {
          dismissals += 1;
        }}
      />,
    );
    typeInto(container.querySelector(".meridian-run-composer__body"), "the first body");
    await submit(container);
    act(() => {
      rerender(
        <ReopenableHarness
          formKey="second"
          answer={held.answer}
          onDismiss={() => {
            dismissals += 1;
          }}
        />,
      );
    });
    typeInto(container.querySelector(".meridian-run-composer__body"), "the second body");
    await submit(container);
    // The first request lands, applied; it is not this form's settlement.
    await act(async () => {
      held.release({
        interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
        interventionType: "steer",
        state: "applied",
        runVersion: 9,
      });
      await crossMacrotaskBoundary();
    });
    expect(dismissals).toBe(0);
    expect(bodyValue(container)).toBe("the second body");
  });

  it("negative control: an admitted dispatch settles and closes the form", async () => {
    // Without this the two cases above would pass over a form that never read a settlement.
    const { container, calls, dismissCount } = renderSteerBox();
    typeInto(container.querySelector(".meridian-run-composer__body"), "keep going");
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(dismissCount()).toBe(1);
  });
});

describe("the composer outlives its dispatch", () => {
  const REJECTED_STEER: ScriptedAnswer = () => ({
    interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
    interventionType: "steer",
    state: "rejected",
    rejectionReason: "run_not_paused",
    runVersion: 9,
  });

  it("keeps the text and says it was not applied when the intervention is rejected", async () => {
    const { container, dismissCount } = renderSteerBox(REJECTED_STEER);
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop editing that file");
    await submit(container);
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("stop editing that file");
    expect(container.textContent).toContain("The background service did not apply this.");
  });
});

describe("what reaches the wire", () => {
  it("dispatches a typed steer byte-identical", async () => {
    // A trim before the wire would cost a pasted block the shape that was the reason for
    // pasting it.
    const indented = "  if (ready) {\n    ship();\n  }\n\n";
    const { container, calls } = renderSteerBox();
    typeInto(container.querySelector(".meridian-run-composer__body"), indented);
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("run.intervene");
    expect(calls[0]?.params).toMatchObject({ type: "steer", content: indented });
  });
});
