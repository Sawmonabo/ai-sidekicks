// A registered run-control row dispatches through the render that is on screen.
//
// Rows read the run list, comparand source and dispatcher through a ref, so where the ref is
// written is the safety property: a pass React discards must not write it, or the row on screen
// would dispatch through a dispatch state nobody is looking at. Driven through a suspending
// transition and asserted while the pass is still abandoned, since a recovering render writes
// the committed value back.

import { render } from "@testing-library/react";
import { useMemo, useState } from "react";
import { describe, expect, it } from "vitest";

import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { SuspendsWhenAsked, abandonOneRenderPass } from "@test/helpers/abandoned-pass.js";
import { capabilityReadout } from "../driver-capability-readout.test-support.js";
import {
  RUN_ID as TARGET_RUN,
  commandRun,
  recordingRunControlDispatch,
  type RecordedRunControlCall,
} from "../run-control-commands.test-support.js";
import { type RunControlCommandInput } from "../contributions/run-control-commands.js";
import { useRunControlCommands } from "./useRunControlCommands.js";
import { type RunControlDispatchState } from "./useRunControlDispatch.js";

const PAUSE_COMMAND_ID = `runs.pause.${TARGET_RUN}`;

const CAPABLE = capabilityReadout([["claude", []]], [[TARGET_RUN, "claude"]]);

/**
 * The hook under a tree that can re-address and suspend in one transition. The two dispatch
 * states are props, since one minted inside the tree would be a fresh identity every pass.
 */
function ReaddressableRunCommandContributor(props: {
  readonly committedDispatchState: RunControlDispatchState;
  readonly abandonedDispatchState: RunControlDispatchState;
  readonly readdress: { current: (() => void) | undefined };
}): React.JSX.Element {
  const [addressedToAbandoned, setAddressedToAbandoned] = useState(false);
  const [suspend, setSuspend] = useState(false);
  const input = useMemo<RunControlCommandInput>(
    () => ({
      runs: [commandRun(TARGET_RUN)],
      driverCapabilities: CAPABLE,
      dispatchState: addressedToAbandoned
        ? props.abandonedDispatchState
        : props.committedDispatchState,
      onRequestSteer: () => undefined,
    }),
    [addressedToAbandoned, props.abandonedDispatchState, props.committedDispatchState],
  );
  useRunControlCommands(input);
  props.readdress.current = () => {
    setAddressedToAbandoned(true);
    setSuspend(true);
  };
  return <SuspendsWhenAsked suspend={suspend} />;
}

describe("the run-control palette rows dispatch through the committed render", () => {
  it("dispatches through the on-screen render's dispatch state after a discarded re-address", async () => {
    const committed = recordingRunControlDispatch();
    const abandoned = recordingRunControlDispatch();
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <ReaddressableRunCommandContributor
        committedDispatchState={committed.dispatchState}
        abandonedDispatchState={abandoned.dispatchState}
        readdress={readdress}
      />,
    );

    await abandonOneRenderPass(() => {
      readdress.current?.();
    });
    commandRegistry.get(PAUSE_COMMAND_ID)?.run();

    // The rows say the same thing in both passes, so the command never changed, only which
    // dispatch state it would reach.
    expect(abandoned.calls).toStrictEqual([]);
    expect(committed.calls).toStrictEqual<readonly RecordedRunControlCall[]>([
      { verb: "pause", runId: TARGET_RUN, expectedRunVersion: 7 },
    ]);
  });

  it("negative control: a committed re-address DOES move the row onto the new dispatch state", async () => {
    // Without this the case above would pass over a hook that ignored its input.
    const committed = recordingRunControlDispatch();
    const later = recordingRunControlDispatch();
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    const { rerender } = render(
      <ReaddressableRunCommandContributor
        committedDispatchState={committed.dispatchState}
        abandonedDispatchState={later.dispatchState}
        readdress={readdress}
      />,
    );

    // The same re-address, committed rather than abandoned: no suspension, so React keeps the
    // pass.
    rerender(
      <ReaddressableRunCommandContributor
        committedDispatchState={later.dispatchState}
        abandonedDispatchState={later.dispatchState}
        readdress={readdress}
      />,
    );
    commandRegistry.get(PAUSE_COMMAND_ID)?.run();

    expect(committed.calls).toStrictEqual([]);
    expect(later.calls.map((call) => call.verb)).toStrictEqual(["pause"]);
  });
});
