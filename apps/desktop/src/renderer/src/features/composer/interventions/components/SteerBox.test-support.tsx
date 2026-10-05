// Shared scaffolding for the steer form suites: one form mounted against one run and
// stub calls.

import { useState } from "react";
import { act, render } from "@testing-library/react";
import type { InterventionRequestResponse } from "@ai-sidekicks/contracts/run/control";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import { type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import { SteerBox } from "./SteerBox.js";
import { inertBridge } from "../../composer.test-support.js";
import type { RunControlCommandRun } from "../../run-controls/contributions/run-control-commands.js";
import type { RunControlCalls } from "../../run-controls/services/run-control-dispatch.js";
import { RUN_ID } from "../../run-controls/run-control-commands.test-support.js";
import { useRunControlDispatch } from "../../run-controls/hooks/useRunControlDispatch.js";

/** What the stub answers one intervention with. */
export type ScriptedAnswer = () => unknown;

/** The applied settlement every case that is not about settlement rides on. */
export const APPLIED_STEER: ScriptedAnswer = () => ({
  interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
  interventionType: "steer",
  state: "applied",
  runVersion: 9,
});

/**
 * The calls the run control dispatch is given, recording each intervention into the case's
 * own array. Only `intervene` answers; no case here presses pause or resume.
 */
export function interventionCalls(
  calls: RecordedDaemonCall[],
  answer: ScriptedAnswer,
): RunControlCalls {
  const unused = (): Promise<never> =>
    Promise.reject(new Error("the intervention composer calls only intervene"));
  return {
    pause: unused,
    resume: unused,
    intervene: async (request) => {
      calls.push({ method: "run.intervene", params: request });
      return answer() as InterventionRequestResponse;
    },
  };
}

/** A run in the given state, at the version and identity a case names. */
export function runAt(
  state: RunState,
  runVersion = 8,
  runId: string = RUN_ID,
): RunControlCommandRun {
  return { runId, runVersion, state };
}

/** The steer form mounted over a run control dispatch fed by the stub calls. */
export function SteerBoxHarness(props: {
  readonly calls: RecordedDaemonCall[];
  readonly answer: ScriptedAnswer;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  // Pinned: the dispatch state keys its holders on the bridge, so a rebuilt stub would be a
  // new transport every render.
  const [bridge] = useState(inertBridge);
  const [runControlCalls] = useState(() => interventionCalls(props.calls, props.answer));
  const dispatchState = useRunControlDispatch(bridge, runControlCalls);
  return (
    <SteerBox
      bridge={bridge}
      run={runAt("paused")}
      dispatchState={dispatchState}
      onDismiss={props.onDismiss}
    />
  );
}

/** Render the harness with the case's answer, returning what it recorded and dismissed. */
export function renderSteerBox(answer: ScriptedAnswer = APPLIED_STEER): {
  container: HTMLElement;
  calls: RecordedDaemonCall[];
  dismissCount: () => number;
} {
  const calls: RecordedDaemonCall[] = [];
  let dismissals = 0;
  const { container } = render(
    <SteerBoxHarness
      calls={calls}
      answer={answer}
      onDismiss={() => {
        dismissals += 1;
      }}
    />,
  );
  return { container, calls, dismissCount: () => dismissals };
}

/** The steer form's body text; throws if the form drew no body field. */
export function bodyValue(container: HTMLElement): string {
  const body = container.querySelector(".meridian-run-composer__body");
  if (!(body instanceof HTMLTextAreaElement)) {
    throw new Error("the composer drew no body field");
  }
  return body.value;
}

/** Types into a field through the native setter so React sees the input event. */
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

/**
 * Presses confirm. Awaited because a confirm that reaches the wire settles after the click
 * returns; an unawaited act() would leave that update outside React's boundary.
 */
export async function submit(container: HTMLElement): Promise<void> {
  const confirm = container.querySelector(".meridian-run-composer__confirm");
  if (!(confirm instanceof HTMLButtonElement)) {
    throw new Error("the composer drew no confirm");
  }
  await act(async () => {
    confirm.click();
  });
}
