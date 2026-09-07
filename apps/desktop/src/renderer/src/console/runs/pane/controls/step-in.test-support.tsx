// The step-in control mounted the way the pane mounts it: over a real surface.
//
// The control dispatches through `RunControlSurface`, which is a hook, so no suite can
// render it against a prop it builds by hand — and a hand-built surface would be the
// one thing these claims must not stub, since what they are about is the latch that
// surface owns. One harness rather than one per file: two suites drive this control
// and a test file may not import another test file, so the mount lives here once.

import { useRunControlSurface, type RunControlSurface } from "./run-control-surface.js";
import { StepIn } from "./StepIn.js";
import { type ConsoleBridge } from "../../../bridge/index.js";
import type { ConsoleScenario, ScenarioReply } from "../../../bridge/scenario-runtime/scenario.js";

/** A real UUID, because the registered run identifier is a branded UUID. */
export const TARGET_RUN_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
export const EXPECTED_RUN_VERSION = 7;
export const AGENT_LABEL = "Codex";

/** The pause reply every case that is not about refusal rides on. */
export const ACKNOWLEDGED_PAUSE: ScenarioReply = {
  call: "run.pause",
  result: { runId: TARGET_RUN_ID, currentState: "paused", runVersion: 8 },
};

/**
 * A scenario carrying at most one canned reply and no beats.
 *
 * Deliberately not one of the registered console scenarios: those belong to the
 * fixture picker, and a unit that needed a picker entry to run would couple these
 * claims to a list six other lanes are also editing.
 */
export function scenarioReplying(replies: ConsoleScenario["replies"]): ConsoleScenario {
  return {
    id: "step-in-unit",
    label: "Step in unit",
    purpose: "One canned pause reply, so the control's settlement is observable.",
    sessionId: "session-step-in",
    participantIdsInJoinOrder: ["participant-you"],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    beats: [],
    replies,
  };
}

/**
 * The control over the pane's own surface.
 *
 * The surface is published back through a holder rather than a callback prop because
 * one suite has to dispatch the palette's row against the very same instance — which
 * is the whole claim there — and a surface handed out any other way would be a second
 * one.
 */
export function StepInHost(props: {
  readonly bridge: ConsoleBridge;
  readonly onTakeTheFloor: () => void;
  readonly surfaceSeen?: { current: RunControlSurface | undefined };
}): React.JSX.Element {
  const surface = useRunControlSurface(props.bridge);
  if (props.surfaceSeen !== undefined) {
    props.surfaceSeen.current = surface;
  }
  return (
    <StepIn
      bridge={props.bridge}
      surface={surface}
      targetRunId={TARGET_RUN_ID}
      expectedRunVersion={EXPECTED_RUN_VERSION}
      agentLabel={AGENT_LABEL}
      onTakeTheFloor={props.onTakeTheFloor}
    />
  );
}

/** The control's one button, or a failure naming what was rendered instead. */
export function stepInTrigger(container: HTMLElement): HTMLButtonElement {
  const trigger = container.querySelector(".meridian-step-in__action");
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error("step in rendered no action");
  }
  return trigger;
}
