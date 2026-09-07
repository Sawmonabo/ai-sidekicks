// What a run-control contribution suite is handed: a run to contribute for, and a
// surface that records what a pressed row dispatched.
//
// Hoisted out of `run-control-commands.test.ts` on its second use — the abandoned-pass
// suite beside it drives the same hook and needs the same two collaborators, and a test
// file may not import another test file, which would make one suite's cases a
// dependency of another's. A second copy of the recording surface would be two answers
// to "what did the palette dispatch", and the two would drift the first time the
// surface's own shape grew a member.

import { type RunProjection } from "../run-state-projection.js";
import {
  carriedRunControlRefusal,
  type RunControl,
  type RunControlDispatcher,
  type RunControlOutcome,
} from "./run-control-dispatch.js";
import { type RunControlSurface } from "./run-control-surface.js";

/** One dispatch a row made, as the stub dispatcher saw it. */
export interface RecordedRunControlCall {
  readonly verb: RunControl;
  readonly runId: string;
  readonly expectedRunVersion: number;
}

/** A projection at rest, carrying the two members the contribution actually reads. */
export function runProjection(
  runId: string,
  state: RunProjection["state"] = "running",
): RunProjection {
  return {
    runId,
    runVersion: 7,
    state,
    trigger: undefined,
    intendedClose: false,
    failureCategory: undefined,
    providerFailureDetail: undefined,
    rewoundToPosition: undefined,
    executionPosture: undefined,
    firstSeenAtIso: "2026-09-02T09:00:00.000Z",
    updatedAtIso: "2026-09-02T09:00:00.000Z",
    statusRows: [],
  };
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
    cancel: record("cancel"),
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
