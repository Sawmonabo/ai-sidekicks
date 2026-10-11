// What the run-control suites are handed: a run to contribute for, and one recording dispatch
// state, so every suite driving the palette hook answers "what did it dispatch" the same way.

import type {
  InterventionRequestResponse,
  RunControlAck,
} from "@ai-sidekicks/contracts/run/control";
import type { RunState } from "@ai-sidekicks/contracts/run/state";

import { type RunChild, type RunControlCommandRun } from "./contributions/commands.js";
import {
  type RunControl,
  type RunControlDispatcher,
  type RunControlOutcome,
} from "./services/dispatch.js";
import { type RunControlDispatchState } from "./hooks/useRunControlDispatch.js";

/** A run identifier the wire's own reader accepts, shared by the suites in this folder. */
export const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";

/** A second run, for the cases about two runs at once. */
export const SECOND_RUN_ID = "c4a1b2d3-5e6f-4071-9b82-ad3e4f506172";

/** A third run, for the case whose claim is that a latch is per run. */
export const OTHER_RUN_ID = "c4e1b2d3-5f60-4071-9b82-0d3e4f506172";

/** The acknowledgment every stub call answers with. */
export const STUB_ACK = {
  runId: RUN_ID,
  newState: "paused",
  runVersion: 7,
} as RunControlAck;

/** One dispatch a row made, as the stub dispatcher saw it. */
export interface RecordedRunControlCall {
  readonly verb: RunControl;
  readonly runId: string;
  readonly expectedRunVersion: number;
}

/** An applied interrupt at the given run version, as a stub call answers it. */
export function appliedInterrupt(runVersion: number): InterventionRequestResponse {
  return {
    interventionId: "c4e1b2d3-5f60-4071-9b82-0d3e4f506172",
    interventionType: "interrupt",
    state: "applied",
    runVersion,
  } as InterventionRequestResponse;
}

/**
 * A run at version 7, which is the comparand a contributed row is expected to carry, with the
 * children a case gives it.
 */
export function commandRun(
  runId: string,
  state: RunState = "running",
  children: readonly RunChild[] = [],
): RunControlCommandRun {
  return { runId, runVersion: 7, state, children };
}

/** A dispatch state whose dispatcher records the verb and target it was asked for. */
export function recordingRunControlDispatch(): {
  readonly dispatchState: RunControlDispatchState;
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
    // The comparand is the dispatcher's own reconciliation; the stub returns the reading it
    // was handed so an assertion can see which version traveled.
    comparandFor: (_runId: string, streamReading: number) => streamReading,
    pause: record("pause"),
    resume: record("resume"),
    interrupt: record("interrupt"),
  } as unknown as RunControlDispatcher;
  const dispatchState: RunControlDispatchState = {
    dispatcher,
    records: [],
    inFlightKeys: new Set<string>(),
    dispatch: (_subject, _control, perform) => {
      void perform(dispatcher);
      return { admitted: true, dispatchToken: "token", settled: Promise.resolve() };
    },
  };
  return { dispatchState, calls };
}
