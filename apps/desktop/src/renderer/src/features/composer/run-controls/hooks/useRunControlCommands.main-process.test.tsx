// The run-control palette rows are never closed: no row carries an `unavailable`
// sentence, and running one dispatches. The hook takes no view of the runtime's
// connection, so an outage cannot close a row.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { capabilityReadout } from "../driver-capability-readout.test-support.js";
import { useRunControlCommands } from "./useRunControlCommands.js";
import {
  RUN_ID,
  commandRun,
  recordingRunControlDispatch,
  type RecordedRunControlCall,
} from "../run-control-commands.test-support.js";
import { type RunControlDispatchState } from "./useRunControlDispatch.js";

const PAUSE_COMMAND_ID = `runs.pause.${RUN_ID}`;

const CAPABLE = capabilityReadout([["claude", ["steer"]]], [[RUN_ID, "claude"]]);

const CONTRIBUTED_COMMAND_IDS = ["pause", "interrupt", "steer"].map(
  (control) => `runs.${control}.${RUN_ID}`,
);

function RunningRunCommandContributor(props: {
  readonly dispatchState: RunControlDispatchState;
}): React.JSX.Element {
  useRunControlCommands({
    runs: [commandRun(RUN_ID)],
    driverCapabilities: CAPABLE,
    dispatchState: props.dispatchState,
    onRequestSteer: () => undefined,
  });
  return <div />;
}

describe("the run-control palette rows are always open", () => {
  it("lists every contributed row carrying no unavailable sentence", () => {
    render(
      <RunningRunCommandContributor dispatchState={recordingRunControlDispatch().dispatchState} />,
    );

    for (const commandId of CONTRIBUTED_COMMAND_IDS) {
      expect(commandRegistry.has(commandId)).toBe(true);
      expect(commandRegistry.get(commandId)?.unavailable).toBeUndefined();
    }
  });

  it("runs the row, which dispatches through the caller's dispatch state", () => {
    const { dispatchState, calls } = recordingRunControlDispatch();
    render(<RunningRunCommandContributor dispatchState={dispatchState} />);

    const outcome = commandRegistry.invoke(PAUSE_COMMAND_ID, { sessionActive: true });

    expect(outcome.status).toBe("ran");
    expect(calls).toStrictEqual<readonly RecordedRunControlCall[]>([
      { verb: "pause", runId: RUN_ID, expectedRunVersion: 7 },
    ]);
  });
});
