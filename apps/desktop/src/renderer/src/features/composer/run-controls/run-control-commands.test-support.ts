// What the run-control suites are handed: a run to contribute for, and a surface that
// records what a pressed row dispatched.
//
// One recording surface, so every suite that drives the palette hook answers "what did
// the palette dispatch" the same way; a test file may not import another test file.

import type { InterventionRequestResponse, RunControlAck, RunState } from "@ai-sidekicks/contracts";

import { type RunControlCommandRun } from "@renderer/console/runs/pane/controls/run-control-commands.js";
import {
  type RunControl,
  type RunControlDispatcher,
  type RunControlOutcome,
} from "./services/run-control-dispatch.js";
import { type RunControlSurface } from "@renderer/console/runs/pane/controls/run-control-surface.js";

/** A run identifier the wire's own reader accepts, shared by the suites in this folder. */
export const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";

/** A second run, for the cases about two runs at once. */
export const SECOND_RUN_ID = "c4a1b2d3-5e6f-4071-9b82-ad3e4f506172";

/** A third run, for the case whose claim is that a latch is per run. */
export const OTHER_RUN_ID = "c4e1b2d3-5f60-4071-9b82-0d3e4f506172";

/** The acknowledgment every stub call answers with. */
export const STUB_ACK = {
  runId: RUN_ID,
  currentState: "paused",
  runVersion: 7,
} as RunControlAck;

/** One dispatch a row made, as the stub dispatcher saw it. */
export interface RecordedRunControlCall {
  readonly verb: RunControl;
  readonly runId: string;
  readonly expectedRunVersion: number;
}

/** An applied non-rollback intervention at the given run version, as a stub call answers it. */
export function appliedIntervention(
  interventionType: "steer" | "interrupt",
  runVersion: number,
): InterventionRequestResponse {
  return {
    interventionId: "c4e1b2d3-5f60-4071-9b82-0d3e4f506172",
    interventionType,
    state: "applied",
    runVersion,
  } as InterventionRequestResponse;
}

/** A run at version 7, which is the comparand a contributed row is expected to carry. */
export function commandRun(runId: string, state: RunState = "running"): RunControlCommandRun {
  return { runId, runVersion: 7, state };
}

/** A surface whose dispatcher records the verb and target it was asked for. */
export function recordingRunControlSurface(): {
  readonly surface: RunControlSurface;
  readonly calls: RecordedRunControlCall[];
} {
  const calls: RecordedRunControlCall[] = [];
  const record =
    (verb: RunControl) =>
    (target: { runId: string; expectedRunVersion: number }): Promise<RunControlOutcome> => {
      calls.push({ verb, runId: target.runId, expectedRunVersion: target.expectedRunVersion });
      return Promise.resolve({ kind: "acknowledged", control: verb, ack: STUB_ACK });
    };
  const dispatcher = {
    // The comparand is the dispatcher's own reconciliation; the stub answers with
    // the reading it was handed so an assertion can see WHICH version travelled.
    comparandFor: (_runId: string, streamReading: number) => streamReading,
    pause: record("pause"),
    resume: record("resume"),
    interrupt: record("interrupt"),
  } as unknown as RunControlDispatcher;
  const surface: RunControlSurface = {
    dispatcher,
    records: [],
    inFlightKeys: new Set<string>(),
    dispatch: (_runId, _control, perform) => {
      void perform(dispatcher);
      return { admitted: true, dispatchToken: "token", settled: Promise.resolve() };
    },
  };
  return { surface, calls };
}
