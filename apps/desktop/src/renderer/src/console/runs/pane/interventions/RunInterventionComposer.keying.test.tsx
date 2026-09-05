// What the form is keyed by, and when a dispatch is recorded at all.
//
// Split from the comparand's own cases because the premise is different: every case
// here re-targets or re-keys a form while a send is still open, so the subject is the
// IDENTITY the surface holds its records under rather than the version it sent. A
// composer that carried one run's draft into another, or recorded a dispatch the
// surface never admitted, would be wrong here and nowhere else.

import { useLayoutEffect, useState } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunInterventionComposer, type ComposedControl } from "./RunInterventionComposer.js";
import { useRunControlSurface } from "../controls/run-control-surface.js";
import {
  APPLIED_ROLLBACK,
  bodyValue,
  renderComposer,
  runAt,
  stubBridge,
  submit,
  type ScriptedAnswer,
  typeInto,
} from "./run-intervention-composer.test-support.js";
import { RUN_ID, SECOND_RUN_ID } from "../runs-pane.test-support.js";
import { drainMicrotasks } from "../../../bridge/fixture-bridge.test-support.js";

describe("the form is keyed by what it is composing against", () => {
  /** A dispatch that never settles, so the form stays pending across the switch. */
  const NEVER_SETTLES: ScriptedAnswer = () => new Promise(() => undefined);

  /**
   * What the DOM held at COMMIT time, before any passive effect could correct it.
   *
   * A layout effect, which is the only moment that answers this question: React has
   * written the frame and no passive effect has run, so a reset implemented as a
   * `useEffect` has not happened yet and whatever this reads is what a person could
   * see and press. Mounted after the form so the form's own frame is already there.
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
   * The composer over a target the case can change, with or without the key.
   *
   * Both arms matter: the keyed one is the pane's own shape, and the unkeyed one is
   * what a later caller that drops the key would render — the arm the component's
   * own reset has to hold on its own.
   */
  function TargetSwitchHarness(props: {
    readonly runId: string;
    readonly control: ComposedControl;
    readonly keyed: boolean;
    readonly answer: ScriptedAnswer;
    readonly onCommit?: (committed: { body: string; isConfirmDisabled: boolean }) => void;
  }): React.JSX.Element {
    const [bridge] = useState(() => stubBridge([], props.answer));
    const surface = useRunControlSurface(bridge);
    const identity = `${props.runId}:${props.control}`;
    const { onCommit } = props;
    return (
      <>
        <RunInterventionComposer
          key={props.keyed ? identity : "fixed"}
          bridge={bridge}
          run={runAt("paused", 8, props.runId)}
          control={props.control}
          surface={surface}
          onDismiss={() => undefined}
        />
        {onCommit === undefined ? null : <CommitProbe record={onCommit} />}
      </>
    );
  }

  function renderSwitchable(
    keyed: boolean,
    answer: ScriptedAnswer = APPLIED_ROLLBACK,
  ): {
    container: HTMLElement;
    retarget: (runId: string, control: ComposedControl) => void;
  } {
    const { container, rerender } = render(
      <TargetSwitchHarness runId={RUN_ID} control="steer" keyed={keyed} answer={answer} />,
    );
    return {
      container,
      retarget: (runId, control) => {
        act(() => {
          rerender(
            <TargetSwitchHarness runId={runId} control={control} keyed={keyed} answer={answer} />,
          );
        });
      },
    };
  }

  it("carries no body from one run to the next", () => {
    const { container, retarget } = renderSwitchable(true);
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop and re-read the diff");
    retarget(SECOND_RUN_ID, "steer");
    expect(bodyValue(container)).toBe("");
  });

  it("carries no body across the key a later caller might drop", () => {
    // The component's own half of the rule: the same switch with one element reused.
    const { container, retarget } = renderSwitchable(false);
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop and re-read the diff");
    retarget(SECOND_RUN_ID, "steer");
    expect(bodyValue(container)).toBe("");
  });

  it("carries no refusal from one target to the next", async () => {
    const { container, retarget } = renderSwitchable(false);
    retarget(RUN_ID, "rollback");
    await submit(container);
    expect(container.textContent).toContain("target-position-unnamed");
    retarget(SECOND_RUN_ID, "rollback");
    expect(container.textContent).not.toContain("target-position-unnamed");
  });

  it("leaves the new target unlatched while the old one's dispatch is still in flight", async () => {
    const { container, retarget } = renderSwitchable(false, NEVER_SETTLES);
    typeInto(container.querySelector(".meridian-run-composer__body"), "keep going");
    await submit(container);
    const confirm = container.querySelector(".meridian-run-composer__confirm");
    expect(confirm instanceof HTMLButtonElement && confirm.disabled).toBe(true);
    retarget(SECOND_RUN_ID, "steer");
    const afterSwitch = container.querySelector(".meridian-run-composer__confirm");
    expect(afterSwitch instanceof HTMLButtonElement && afterSwitch.disabled).toBe(false);
    expect(bodyValue(container)).toBe("");
  });

  it("shows the new target's own empty form in the commit that re-addresses", async () => {
    // The commit itself, not the settled state after it. A reset implemented as a
    // passive effect is one commit late by construction: the render that first sees
    // the new run read the PREVIOUS run's body, target position, refusal and pending
    // dispatch, nothing disabled the form for that commit, and a submit in it
    // dispatched text authored for one run against another's comparand.
    const committed: { body: string; isConfirmDisabled: boolean }[] = [];
    const { container, rerender } = render(
      <TargetSwitchHarness
        runId={RUN_ID}
        control="steer"
        keyed={false}
        answer={NEVER_SETTLES}
        onCommit={(reading) => committed.push(reading)}
      />,
    );
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop and re-read the diff");
    await submit(container);
    // The old target's dispatch is parked, so its confirm is latched — which is what
    // makes the reading after the switch decisive rather than incidental.
    expect(committed.at(-1)).toStrictEqual({
      body: "stop and re-read the diff",
      isConfirmDisabled: true,
    });

    committed.length = 0;
    await act(async () => {
      rerender(
        <TargetSwitchHarness
          runId={SECOND_RUN_ID}
          control="steer"
          keyed={false}
          answer={NEVER_SETTLES}
          onCommit={(reading) => committed.push(reading)}
        />,
      );
    });
    expect(committed[0]).toStrictEqual({ body: "", isConfirmDisabled: false });
  });

  it("negative control: a re-render at the same target keeps what was typed", () => {
    // Without this every case above would pass over a form that cleared itself on
    // every render, which would make it impossible to type into at all.
    const { container, retarget } = renderSwitchable(false);
    typeInto(container.querySelector(".meridian-run-composer__body"), "stop and re-read the diff");
    retarget(RUN_ID, "steer");
    expect(bodyValue(container)).toBe("stop and re-read the diff");
  });
});

describe("a dispatch is recorded only where the surface admitted one", () => {
  /** Answers when the case releases it, so a request can be left in flight. */
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
   * The finding's own sequence: one surface, one run and control, and a form the
   * case can close and reopen while the first request is still in flight.
   *
   * The surface is held across the remount — that is the whole point, since the
   * latch it keeps is what the second form runs into.
   */
  function ReopenableHarness(props: {
    readonly formKey: string;
    readonly answer: ScriptedAnswer;
    readonly onDismiss: () => void;
  }): React.JSX.Element {
    const [bridge] = useState(() => stubBridge([], props.answer));
    const surface = useRunControlSurface(bridge);
    return (
      <RunInterventionComposer
        key={props.formKey}
        bridge={bridge}
        run={runAt("paused")}
        control="steer"
        surface={surface}
        onDismiss={props.onDismiss}
      />
    );
  }

  it("refuses the second body while the first request is still settling, and keeps it", async () => {
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
    // Cancelled and reopened while the first request is still in flight.
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
    expect(container.textContent).toContain("in-flight");
    expect(container.textContent).toContain("still settling");
    // The body the participant typed is still on screen, and the form is still open.
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
    // The first request lands, applied. It is not this form's settlement.
    await act(async () => {
      held.release({
        interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
        interventionType: "steer",
        state: "applied",
        runVersion: 9,
      });
      await drainMicrotasks();
    });
    expect(dismissals).toBe(0);
    expect(bodyValue(container)).toBe("the second body");
  });

  it("negative control: an admitted dispatch settles and closes the form", async () => {
    // Without this the two cases above would pass over a form that never read a
    // settlement at all, which would leave every intervention open forever.
    const { container, calls, dismissCount } = renderComposer("steer");
    typeInto(container.querySelector(".meridian-run-composer__body"), "keep going");
    await submit(container);
    expect(calls).toHaveLength(1);
    expect(dismissCount()).toBe(1);
  });
});
