// The intervention composer's shared scaffolding.
//
// Both suites mount the same form against the same run projection and the same
// fixture bridge, because the claims are about one composition: a form that composes
// against a run reads that run's own comparand and dispatches through the router the
// pane supplies.

import { useState } from "react";
import { act, render } from "@testing-library/react";
import type { RunState } from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { RunInterventionComposer, type ComposedControl } from "./RunInterventionComposer.js";
import { useRunControlSurface } from "../controls/run-control-surface.js";
import { RunStateProjection, type RunProjection } from "../run-state-projection.js";
import type { RecordedDaemonCall } from "../../../bridge/fixture-bridge.test-support.js";
import { RUN_ID } from "../runs-pane.test-support.js";

/** What the stub daemon answers one call with. Throwing is the refusal arm. */
export type ScriptedAnswer = () => unknown;

/** The applied settlement every case that is not about settlement rides on. */
export const APPLIED_ROLLBACK: ScriptedAnswer = () => ({
  interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
  interventionType: "rollback",
  state: "applied",
  runVersion: 9,
  result: { disposition: "conversation-only" },
});

export function stubBridge(calls: RecordedDaemonCall[], answer: ScriptedAnswer): ConsoleBridge {
  return {
    sidekicks: {
      daemon: {
        call: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          return answer();
        },
        subscribe: () => () => undefined,
      },
    },
    growth: {},
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
}

export function runAt(state: RunState, runVersion = 8, runId: string = RUN_ID): RunProjection {
  const fold = new RunStateProjection();
  fold.accept({
    runId,
    runVersion,
    previousState: "queued",
    currentState: state,
    timestamp: "2026-01-01T16:00:00.000Z",
  });
  const run = fold.runs()[0];
  if (run === undefined) {
    throw new Error("the fold produced no run");
  }
  return run;
}

export function ComposerHarness(props: {
  readonly control: ComposedControl;
  readonly calls: RecordedDaemonCall[];
  readonly answer: ScriptedAnswer;
  readonly onDismiss: () => void;
  /**
   * The run to compose against, for the case that re-targets one mounted form.
   *
   * Deliberately WITHOUT a React key, which is the documented keyless path: the pane
   * supplies one and this parameter is how a case reaches the composer's own second
   * defence against a caller that does not.
   */
  readonly run?: RunProjection;
}): React.JSX.Element {
  // Pinned for the harness's whole life: the surface keys its holders on the
  // bridge, so a stub rebuilt on every render would be a new transport each pass.
  const [bridge] = useState(() => stubBridge(props.calls, props.answer));
  const surface = useRunControlSurface(bridge);
  return (
    <RunInterventionComposer
      bridge={bridge}
      run={props.run ?? runAt("paused")}
      control={props.control}
      surface={surface}
      onDismiss={props.onDismiss}
    />
  );
}

export function renderComposer(
  control: ComposedControl,
  answer: ScriptedAnswer = APPLIED_ROLLBACK,
): {
  container: HTMLElement;
  calls: RecordedDaemonCall[];
  dismissCount: () => number;
} {
  const calls: RecordedDaemonCall[] = [];
  let dismissals = 0;
  const { container } = render(
    <ComposerHarness
      control={control}
      calls={calls}
      answer={answer}
      onDismiss={() => {
        dismissals += 1;
      }}
    />,
  );
  return { container, calls, dismissCount: () => dismissals };
}

export function bodyValue(container: HTMLElement): string {
  const body = container.querySelector(".meridian-run-composer__body");
  if (!(body instanceof HTMLTextAreaElement)) {
    throw new Error("the composer drew no body field");
  }
  return body.value;
}

export function typeInto(element: Element | null, value: string): void {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    throw new Error("the composer drew no field to type into");
  }
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Awaited, because a confirm that reaches the wire settles asynchronously: the
// state update carrying the outcome lands after the click returns, and an
// unawaited act() would leave it outside the boundary React asserts on.
export async function submit(container: HTMLElement): Promise<void> {
  const confirm = container.querySelector(".meridian-run-composer__confirm");
  if (!(confirm instanceof HTMLButtonElement)) {
    throw new Error("the composer drew no confirm");
  }
  await act(async () => {
    confirm.click();
  });
}
