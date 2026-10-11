// The steer form: a body typed for one run is never sent to or cleared by another, a dispatch
// is recorded only where the dispatch state admitted it, the text survives a refusal and a failed
// delivery, and it reaches the child's queue as typed.

import { useLayoutEffect, useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SteerBox } from "./SteerBox.js";
import { useRunControlDispatch } from "../../run/controls/hooks/useRunControlDispatch.js";
import {
  QUEUED_STEER,
  QUEUED_STEER_RESPONSE,
  bodyValue,
  renderSteerBox,
  runAt,
  STEERED_AGENT_NAME,
  STEERED_CHILD_HANDLE,
  steerCalls,
  steerField,
  submit,
  type ScriptedAnswer,
  typeInto,
} from "./SteerBox.test-support.js";
import { inertBridge } from "../../Composer.test-support.js";
import { RUN_ID, SECOND_RUN_ID } from "../../run/controls/commands.test-support.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";

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
      const body = screen.queryByRole("textbox", { name: `Steer ${STEERED_AGENT_NAME}` });
      const confirm = screen.queryByRole("button", { name: "Send" });
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
    const [runControlCalls] = useState(() => steerCalls([], props.answer));
    const dispatchState = useRunControlDispatch(bridge, runControlCalls);
    const { onCommit } = props;
    return (
      <>
        <SteerBox
          key={props.keyed ? props.runId : "fixed"}
          bridge={bridge}
          run={runAt("paused", 8, props.runId)}
          childHandle={STEERED_CHILD_HANDLE}
          agentName={STEERED_AGENT_NAME}
          dispatchState={dispatchState}
          onDismiss={() => undefined}
        />
        {onCommit === undefined ? null : <CommitProbe record={onCommit} />}
      </>
    );
  }

  function renderSwitchable(
    keyed: boolean,
    answer: ScriptedAnswer = QUEUED_STEER,
  ): {
    container: HTMLElement;
    retarget: (runId: string) => void;
  } {
    const { container, rerender } = render(
      <TargetSwitchHarness runId={RUN_ID} keyed={keyed} answer={answer} />,
      { wrapper: LiveAnnouncerProvider },
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
    // one commit late, and a submit in that commit would send the old run's text as the new
    // run's steer.
    const committed: { body: string; isConfirmDisabled: boolean }[] = [];
    const { container, rerender } = render(
      <TargetSwitchHarness
        runId={RUN_ID}
        keyed={false}
        answer={NEVER_SETTLES}
        onCommit={(reading) => committed.push(reading)}
      />,
      { wrapper: LiveAnnouncerProvider },
    );
    typeInto(steerField(container), "stop and re-read the diff");
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
    typeInto(steerField(container), "stop and re-read the diff");
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
    const [runControlCalls] = useState(() => steerCalls([], props.answer));
    const dispatchState = useRunControlDispatch(bridge, runControlCalls);
    return (
      <SteerBox
        key={props.formKey}
        bridge={bridge}
        run={runAt("paused")}
        childHandle={STEERED_CHILD_HANDLE}
        agentName={STEERED_AGENT_NAME}
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
      { wrapper: LiveAnnouncerProvider },
    );
    typeInto(steerField(container), "the first body");
    await submit(container);
    // Closed and reopened while the first request is still in flight.
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
    typeInto(steerField(container), "the second body");
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
      { wrapper: LiveAnnouncerProvider },
    );
    typeInto(steerField(container), "the first body");
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
    typeInto(steerField(container), "the second body");
    await submit(container);
    // The first request lands, queued; it is not this form's settlement.
    await act(async () => {
      held.release(QUEUED_STEER_RESPONSE);
      await crossMacrotaskBoundary();
    });
    expect(dismissals).toBe(0);
    expect(bodyValue(container)).toBe("the second body");
  });

  it("negative control: an admitted dispatch settles and closes the form", async () => {
    // Without this the two cases above would pass over a form that never read a settlement.
    const { container, calls, dismissCount } = renderSteerBox();
    typeInto(steerField(container), "keep going");
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(dismissCount()).toBe(1);
  });
});

describe("the composer outlives its dispatch", () => {
  it("keeps the text and says why when the message is refused", async () => {
    const refusal = {
      code: "run.child_control_refused",
      message: "The child has ended.",
    };
    const { container, dismissCount } = renderSteerBox(vi.fn().mockRejectedValue(refusal));
    typeInto(steerField(container), "stop editing that file");
    await submit(container);
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("stop editing that file");
    expect(container.querySelector(".meridian-refusal")?.textContent).toContain(
      "The child has ended.",
    );
  });
});

describe("a steer the background service could not deliver", () => {
  it("reads Not delivered · Retry, and Retry sends that steer's words again in its place", async () => {
    // Negative control: the second answer is queued, and that one closes the box.
    let answers = 0;
    const undeliveredThenQueued: ScriptedAnswer = () => {
      answers += 1;
      return answers === 1
        ? { ...QUEUED_STEER_RESPONSE, state: "not_delivered", notDeliveredReason: "failed" }
        : QUEUED_STEER_RESPONSE;
    };
    const { container, calls, dismissCount } = renderSteerBox(undeliveredThenQueued);
    typeInto(steerField(container), "stop editing that file");
    await submit(container);
    expect(dismissCount()).toBe(0);
    expect(bodyValue(container)).toBe("stop editing that file");
    const line = container.querySelector(".meridian-composer__not-delivered");
    expect(line?.textContent).toBe("Not delivered · Retry");
    // The line carries the daemon's reason, not the answer's state.
    expect(line?.getAttribute("data-refusal-code")).toBe("failed");

    // Words typed after the failure are a new steer, not the one Retry sends again.
    typeInto(steerField(container), "and the test file");
    const retry = within(container).getByRole("button", { name: "Retry" });
    await act(async () => {
      retry.click();
    });
    expect(calls).toHaveLength(2);
    // It replaces the failed steer, keyed by it, so a second press answers as the first.
    expect(calls[1]?.params).toMatchObject({
      childHandle: STEERED_CHILD_HANDLE,
      content: "stop editing that file",
      replacesQueueItemId: QUEUED_STEER_RESPONSE.queueItemId,
      clientIdempotencyKey: QUEUED_STEER_RESPONSE.queueItemId,
    });
    expect(dismissCount()).toBe(1);
  });
});

describe("what reaches the wire", () => {
  it("sends a typed steer to the child byte-identical, at the run's version", async () => {
    // A trim before the wire would cost a pasted block the shape that was the reason for
    // pasting it.
    const indented = "  if (ready) {\n    ship();\n  }\n\n";
    const { container, calls } = renderSteerBox();
    typeInto(steerField(container), indented);
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("run.childSteer");
    expect(calls[0]?.params).toMatchObject({
      targetRunId: RUN_ID,
      childHandle: STEERED_CHILD_HANDLE,
      expectedRunVersion: 8,
      content: indented,
    });
  });
});
