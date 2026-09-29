// The intervention composer's shared scaffolding.
//
// The suites mount the same form against the same run and the same stub calls,
// because the claims are about one composition: a form that composes against a run
// reads that run's own comparand and dispatches through the surface it is given.

import { useState } from "react";
import { act, render } from "@testing-library/react";
import type { InterventionRequestResponse, RunState } from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import { RunInterventionComposer } from "./SteerBox.js";
import type { RunControlCommandRun } from "@renderer/console/runs/pane/controls/run-control-commands.js";
import type { RunControlCalls } from "../../run-controls/services/run-control-dispatch.js";
import { RUN_ID } from "../../run-controls/run-control-commands.test-support.js";
import { useRunControlSurface } from "@renderer/console/runs/pane/controls/run-control-surface.js";
import { bridgeAnswering, type RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";

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
 * The calls the surface is given, recording each intervention into the array the CASE
 * holds.
 *
 * The harness below receives the array as a prop and builds these inside itself, so
 * the record a case can read has to be a value it already held before the mount.
 * Only `intervene` answers: no case here presses pause or resume.
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

/** The subject the surface keys its holders on; no case calls through it. */
export function inertBridge(): ConsoleBridge {
  return bridgeAnswering(async () => undefined).bridge;
}

/** A run in the given state, at the version and identity a case names. */
export function runAt(
  state: RunState,
  runVersion = 8,
  runId: string = RUN_ID,
): RunControlCommandRun {
  return { runId, runVersion, state };
}

/** The steer form mounted over a surface fed by the stub calls. */
export function ComposerHarness(props: {
  readonly calls: RecordedDaemonCall[];
  readonly answer: ScriptedAnswer;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  // Pinned for the harness's whole life: the surface keys its holders on the
  // bridge, so a stub rebuilt on every render would be a new transport each pass.
  const [bridge] = useState(inertBridge);
  const [runControlCalls] = useState(() => interventionCalls(props.calls, props.answer));
  const surface = useRunControlSurface(bridge, runControlCalls);
  return (
    <RunInterventionComposer
      bridge={bridge}
      run={runAt("paused")}
      surface={surface}
      onDismiss={props.onDismiss}
    />
  );
}

/** Render the harness with the case's answer, returning what it recorded and dismissed. */
export function renderComposer(answer: ScriptedAnswer = APPLIED_STEER): {
  container: HTMLElement;
  calls: RecordedDaemonCall[];
  dismissCount: () => number;
} {
  const calls: RecordedDaemonCall[] = [];
  let dismissals = 0;
  const { container } = render(
    <ComposerHarness
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
