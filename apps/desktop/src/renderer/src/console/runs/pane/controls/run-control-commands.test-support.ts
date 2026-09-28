// What the run-control suites are handed: a run to contribute for, and a surface that
// records what a pressed row dispatched.
//
// One recording surface, so every suite that drives the palette hook answers "what did
// the palette dispatch" the same way; a test file may not import another test file.

import { type RunState } from "@ai-sidekicks/contracts";

import { type RunControlCommandRun } from "./run-control-commands.js";
import {
  carriedRunControlRefusal,
  type RunControl,
  type RunControlDispatcher,
  type RunControlOutcome,
} from "./run-control-dispatch.js";
import { type RunControlSurface } from "./run-control-surface.js";

/** A run identifier the wire's own reader accepts, shared by the suites in this folder. */
export const RUN_ID = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";

/** One dispatch a row made, as the stub dispatcher saw it. */
export interface RecordedRunControlCall {
  readonly verb: RunControl;
  readonly runId: string;
  readonly expectedRunVersion: number;
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
      // A settled outcome the stub does not have to fabricate: nothing under test
      // reads it, and building one through the real reader keeps the stub honest.
      return Promise.resolve(carriedRunControlRefusal(verb, new Error("stub")));
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
      return { admitted: true, dispatchToken: "token" };
    },
  };
  return { surface, calls };
}
