// What a stopped supervisor does to the run controls' PALETTE rows.
//
// The strip's buttons close and say why (`RunControls.shell.test.tsx`); these are the
// same acts reached by the other input, and until this suite they closed nowhere. A row
// that dispatched into the call door's refusal is a control that says nothing until
// after the press, which is the very lateness the door was built to stop — so the row
// carries the block's own sentence, and running it is refused with that same sentence
// rather than with one the palette composed.
//
// LISTED AND CLOSED, NEVER WITHDRAWN. A row that vanished during an outage would answer
// "where did Pause go" with silence, and the `when` clause is already this palette's
// affordance for an act that does not exist in the open scope — a different fact from
// an act that exists and cannot be sent.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { consoleCommands } from "../../../palette/index.js";
import { currentShellMutationBlock, type FrameStore } from "../../../store/index.js";
import { quietShell, stoppedShell } from "../../../store/shell-condition.test-support.js";
import { capabilityReadout } from "./driver-capability-readout.test-support.js";
import { useRunControlCommands } from "./run-control-commands.js";
import {
  recordingRunControlSurface,
  runProjection,
  type RecordedRunControlCall,
} from "./run-control-commands.test-support.js";
import { type RunControlSurface } from "./run-control-surface.js";

const TARGET_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const PAUSE_COMMAND_ID = `runs.pause.${TARGET_RUN}`;

/** Both gated controls declared, so every control this run offers is contributed. */
const CAPABLE = capabilityReadout([["claude", ["steer", "rollback"]]], [[TARGET_RUN, "claude"]]);

/** The ids of every row a running run contributes, in the order the strip offers them. */
const CONTRIBUTED_COMMAND_IDS = ["pause", "interrupt", "steer", "cancel", "rollback"].map(
  (control) => `runs.${control}.${TARGET_RUN}`,
);

/** The sentence the block itself carries, read off the store rather than retyped. */
function blockSentence(frameStore: FrameStore): string {
  const block = currentShellMutationBlock(frameStore);
  if (block === undefined) {
    throw new Error("the stopped shell produced no block to read a sentence off");
  }
  return block.detail;
}

/** The hook under a tree that contributes for one running run and nothing else. */
function RunControlCommandsHost(props: {
  readonly frameStore: FrameStore;
  readonly surface: RunControlSurface;
}): React.JSX.Element {
  useRunControlCommands({
    runs: [runProjection(TARGET_RUN)],
    driverCapabilities: CAPABLE,
    frameStore: props.frameStore,
    surface: props.surface,
    onRequestSteer: () => undefined,
    onRequestRewind: () => undefined,
    // A pane with a described run seats a row, so the empty state's act is not
    // offered here — the claim under test is about the controls of a run.
    startOffer: { seatedRunCount: 1, hasRead: true, openRefusal: undefined },
    onRequestComposerFocus: () => undefined,
  });
  return <div />;
}

describe("the run-control palette rows under a stopped supervisor", () => {
  it("carries the block's own sentence on every contributed row", () => {
    const frameStore = stoppedShell();
    render(
      <RunControlCommandsHost
        frameStore={frameStore}
        surface={recordingRunControlSurface().surface}
      />,
    );

    for (const commandId of CONTRIBUTED_COMMAND_IDS) {
      expect(consoleCommands.get(commandId)?.unavailable).toBe(blockSentence(frameStore));
    }
  });

  it("still lists every row, because a control that vanished explains nothing", () => {
    render(
      <RunControlCommandsHost
        frameStore={stoppedShell()}
        surface={recordingRunControlSurface().surface}
      />,
    );

    for (const commandId of CONTRIBUTED_COMMAND_IDS) {
      expect(consoleCommands.has(commandId)).toBe(true);
    }
  });

  it("sends nothing when one is run, and refuses with that same sentence", () => {
    const frameStore = stoppedShell();
    const { surface, calls } = recordingRunControlSurface();
    render(<RunControlCommandsHost frameStore={frameStore} surface={surface} />);

    const outcome = consoleCommands.invoke(PAUSE_COMMAND_ID, { sessionActive: true });

    expect(calls).toStrictEqual([]);
    expect(outcome).toStrictEqual({
      status: "unavailable",
      commandId: PAUSE_COMMAND_ID,
      reason: blockSentence(frameStore),
    });
  });
});

describe("negative control: a supervisor that has reported nothing closes no row", () => {
  it("leaves every contributed row carrying no reason", () => {
    render(
      <RunControlCommandsHost
        frameStore={quietShell()}
        surface={recordingRunControlSurface().surface}
      />,
    );

    for (const commandId of CONTRIBUTED_COMMAND_IDS) {
      expect(consoleCommands.get(commandId)?.unavailable).toBeUndefined();
    }
  });

  it("runs the row, which dispatches through the pane's own surface", () => {
    const { surface, calls } = recordingRunControlSurface();
    render(<RunControlCommandsHost frameStore={quietShell()} surface={surface} />);

    const outcome = consoleCommands.invoke(PAUSE_COMMAND_ID, { sessionActive: true });

    expect(outcome.status).toBe("ran");
    expect(calls).toStrictEqual<readonly RecordedRunControlCall[]>([
      { verb: "pause", runId: TARGET_RUN, expectedRunVersion: 7 },
    ]);
  });
});
