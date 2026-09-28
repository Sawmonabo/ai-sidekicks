// The intervention composer's shared scaffolding.
//
// The suites mount the same form against the same run and the same fixture bridge,
// because the claims are about one composition: a form that composes against a run
// reads that run's own comparand and dispatches through the surface it is given.

import { useState } from "react";
import { act, render } from "@testing-library/react";
import type { RunState } from "@ai-sidekicks/contracts";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { RunInterventionComposer } from "./RunInterventionComposer.js";
import type { RunControlCommandRun } from "../controls/run-control-commands.js";
import { useRunControlSurface } from "../controls/run-control-surface.js";
import {
  createFixture,
  withDaemonCall,
  type RecordedDaemonCall,
} from "../../../bridge/fixture/call-plane/bridge.test-support.js";

export const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
export const SECOND_RUN_ID = "c4a1b2d3-5e6f-4071-9b82-ad3e4f506172";

/** What the stub daemon answers one call with. Throwing is the refusal arm. */
export type ScriptedAnswer = () => unknown;

/** The applied settlement every case that is not about settlement rides on. */
export const APPLIED_STEER: ScriptedAnswer = () => ({
  interventionId: "d5f2c3e4-6071-4182-ac93-1e4f50617283",
  interventionType: "steer",
  state: "applied",
  runVersion: 9,
});

/**
 * The shipped fixture with a call arm this suite answers, recording into the array
 * the CASE holds.
 *
 * `withDaemonCall` keeps a record of its own, and this one takes the caller's array
 * beside it deliberately: the harness below receives the array as a prop and mounts
 * the bridge inside itself, so the record a case can read has to be a value it
 * already held before the mount.
 *
 * NAMED FOR WHAT IT ANSWERS, on the queue reading's rule: both were `stubBridge`, and
 * one name for two shapes in one family is a wrong import waiting for either return
 * type to widen.
 */
export function interventionDispatchBridge(
  calls: RecordedDaemonCall[],
  answer: ScriptedAnswer,
): ConsoleBridge {
  return withDaemonCall(createFixture().bridge, async (call) => {
    calls.push(call);
    return answer();
  }).bridge;
}

export function runAt(
  state: RunState,
  runVersion = 8,
  runId: string = RUN_ID,
): RunControlCommandRun {
  return { runId, runVersion, state };
}

export function ComposerHarness(props: {
  readonly calls: RecordedDaemonCall[];
  readonly answer: ScriptedAnswer;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  // Pinned for the harness's whole life: the surface keys its holders on the
  // bridge, so a stub rebuilt on every render would be a new transport each pass.
  const [bridge] = useState(() => interventionDispatchBridge(props.calls, props.answer));
  const surface = useRunControlSurface(bridge);
  return (
    <RunInterventionComposer
      bridge={bridge}
      run={runAt("paused")}
      surface={surface}
      onDismiss={props.onDismiss}
    />
  );
}

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
