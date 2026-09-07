// A registered run-control row dispatches through the render that is ON SCREEN.
//
// The six rows are memoised on what they SAY, so the run list, the comparand source
// and the pane's own dispatcher are all read through a ref when a person presses
// Enter. That makes WHERE the ref is written the safety property: a pass React
// discards has already run this hook, and a pass discarded while the pane was being
// re-addressed to another session or another bridge carries that surface — latch,
// idempotency keys and all. If the discarded pass could write the ref, the row still
// on screen would dispatch through a surface nobody is looking at.
//
// Driven through a real transition that suspends, and asserted while the pass is still
// abandoned: a case that let the tree recover first would pass over the defect,
// because the recovering render writes the committed value back.

import { render } from "@testing-library/react";
import { useMemo, useState } from "react";
import { describe, expect, it } from "vitest";

import { consoleCommands } from "../../../palette/index.js";
import {
  SuspendsWhenAsked,
  abandonOneRenderPass,
} from "../../../primitives/abandoned-pass.test-support.js";
import { capabilityReadout } from "./driver-capability-readout.test-support.js";
import {
  recordingRunControlSurface,
  runProjection,
  type RecordedRunControlCall,
} from "./run-control-commands.test-support.js";
import { useRunControlCommands, type RunControlCommandInput } from "./run-control-commands.js";
import { type RunControlSurface } from "./run-control-surface.js";

const TARGET_RUN = "b3f0a1c2-4d5e-4f60-8a71-9c2d3e4f5061";
const PAUSE_COMMAND_ID = `runs.pause.${TARGET_RUN}`;

const CAPABLE = capabilityReadout([["claude", []]], [[TARGET_RUN, "claude"]]);

/**
 * The hook under a tree that can re-address and suspend in one transition.
 *
 * The two surfaces are the case's, handed in as props: what the assertion needs is
 * which of them the registered row dispatched through, and one minted inside the tree
 * would be a fresh identity on every pass rather than two distinguishable ones.
 */
function RunControlCommandsHost(props: {
  readonly committedSurface: RunControlSurface;
  readonly abandonedSurface: RunControlSurface;
  readonly readdress: { current: (() => void) | undefined };
}): React.JSX.Element {
  const [addressedToAbandoned, setAddressedToAbandoned] = useState(false);
  const [suspend, setSuspend] = useState(false);
  const input = useMemo<RunControlCommandInput>(
    () => ({
      runs: [runProjection(TARGET_RUN)],
      driverCapabilities: CAPABLE,
      surface: addressedToAbandoned ? props.abandonedSurface : props.committedSurface,
      onRequestSteer: () => undefined,
      onRequestRewind: () => undefined,
      // A pane with a described run seats a row, so the empty state's act is not
      // offered here — the claim under test is about the six controls' own ref.
      startOffer: { seatedRunCount: 1, hasRead: true, openRefusal: undefined },
      onRequestComposerFocus: () => undefined,
    }),
    [addressedToAbandoned, props.abandonedSurface, props.committedSurface],
  );
  useRunControlCommands(input);
  props.readdress.current = () => {
    setAddressedToAbandoned(true);
    setSuspend(true);
  };
  return <SuspendsWhenAsked suspend={suspend} />;
}

describe("the run-control palette rows dispatch through the committed render", () => {
  it("dispatches through the on-screen render's surface after a discarded re-address", async () => {
    const committed = recordingRunControlSurface();
    const abandoned = recordingRunControlSurface();
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    render(
      <RunControlCommandsHost
        committedSurface={committed.surface}
        abandonedSurface={abandoned.surface}
        readdress={readdress}
      />,
    );

    await abandonOneRenderPass(() => {
      readdress.current?.();
    });
    consoleCommands.get(PAUSE_COMMAND_ID)?.run();

    // The rows say the same thing in both passes, so the command object never
    // changed — only which surface it would reach. Dispatching through the abandoned
    // one would mint an idempotency key on a latch no live render holds.
    expect(abandoned.calls).toStrictEqual([]);
    expect(committed.calls).toStrictEqual<readonly RecordedRunControlCall[]>([
      { verb: "pause", runId: TARGET_RUN, expectedRunVersion: 7 },
    ]);
  });

  it("negative control: a committed re-address DOES move the row onto the new surface", async () => {
    // Without this the case above would pass over a hook that ignored its input
    // entirely, or over a driver whose transition never re-ran this component at all.
    const committed = recordingRunControlSurface();
    const later = recordingRunControlSurface();
    const readdress: { current: (() => void) | undefined } = { current: undefined };
    const { rerender } = render(
      <RunControlCommandsHost
        committedSurface={committed.surface}
        abandonedSurface={later.surface}
        readdress={readdress}
      />,
    );

    // The same re-address, committed rather than abandoned: no transition and no
    // suspension, so React keeps the pass.
    rerender(
      <RunControlCommandsHost
        committedSurface={later.surface}
        abandonedSurface={later.surface}
        readdress={readdress}
      />,
    );
    consoleCommands.get(PAUSE_COMMAND_ID)?.run();

    expect(committed.calls).toStrictEqual([]);
    expect(later.calls.map((call) => call.verb)).toStrictEqual(["pause"]);
  });
});
