// What the controller does with a line the router intercepted.
//
// The interception arm is the one send path that reaches no wire, so nothing about
// it is observable from the daemon stub the send bar's own cases use. These drive
// the real hook over the real `DraftStore` and assert the three settlements a
// recognised command can have: it ran, it was refused, or nothing here could run it.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { refuse } from "../../../console/core/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import type { ComposerChannelTarget } from "../chips/chip-models.js";
import type { CommandExecutor } from "./command-executor.js";
import { composerDraftKey } from "./draft-key.js";
import type { SendController } from "./send-controller-contract.js";
import { useSendController } from "./send-controller.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";

const CHANNEL_TARGET: ComposerChannelTarget = {
  path: "channel-message",
  sessionId: SESSION_ID,
  channelId: undefined,
  workspaceId: undefined,
  channelLabel: undefined,
};

/**
 * A bridge that fails the case loudly if a command ever reaches the wire.
 *
 * Module scope, so its identity is stable across the probe's renders: a bridge
 * rebuilt in the render body would rebuild the router on every pass and hide a
 * dependency mistake behind a fresh object.
 */
const UNREACHABLE_BRIDGE = {
  sidekicks: {
    daemon: {
      call: async () => {
        throw new Error("an intercepted command must reach no wire call");
      },
      subscribe: () => () => undefined,
    },
  },
  growth: {},
  growthServedOperations: new Set(),
  source: "fixture",
  scenarioEngine: undefined,
} as unknown as ConsoleBridge;

/** Reports the controller out of the tree, so a case drives the real hook. */
function ControllerProbe(props: {
  readonly draftStore: DraftStore;
  readonly commandExecutor: CommandExecutor | undefined;
  readonly onController: (controller: SendController) => void;
}): null {
  const controller = useSendController({
    bridge: UNREACHABLE_BRIDGE,
    target: CHANNEL_TARGET,
    draftStore: props.draftStore,
    recognizeClientCommand: (commandName) => commandName === "clear",
    commandExecutor: props.commandExecutor,
  });
  props.onController(controller);
  return null;
}

interface DrivenController {
  readonly draftStore: DraftStore;
  readonly draftKey: string;
  latest(): SendController;
}

function driveController(commandExecutor: CommandExecutor | undefined): DrivenController {
  const draftStore = new DraftStore({ restartNoticePending: false });
  let latest: SendController | undefined;
  render(
    <ControllerProbe
      draftStore={draftStore}
      commandExecutor={commandExecutor}
      onController={(controller) => {
        latest = controller;
      }}
    />,
  );
  return {
    draftStore,
    draftKey: composerDraftKey(CHANNEL_TARGET),
    latest: () => {
      if (latest === undefined) {
        throw new Error("the probe reported no controller");
      }
      return latest;
    },
  };
}

describe("useSendController — an intercepted command awaits its executor", () => {
  it("clears the line only once the executor says the command applied", async () => {
    const runCommand = vi.fn<CommandExecutor>(async () => ({ status: "applied" }));
    const driven = driveController(runCommand);

    act(() => {
      driven.latest().changeText("/clear the deck");
    });
    await act(async () => {
      await driven.latest().send();
    });

    expect(runCommand).toHaveBeenCalledWith({ commandName: "clear", text: "/clear the deck" });
    expect(driven.draftStore.read(driven.draftKey)).toBeUndefined();
    expect(driven.latest().refusal).toBeUndefined();
  });

  it("keeps the line and renders the refusal when the executor refuses", async () => {
    const refusal = refuse("commands", "not-here", "That command needs an open repo.");
    const driven = driveController(async () => ({ status: "refused", refusal }));

    act(() => {
      driven.latest().changeText("/clear the deck");
    });
    await act(async () => {
      await driven.latest().send();
    });

    expect(driven.draftStore.read(driven.draftKey)?.text).toBe("/clear the deck");
    expect(driven.latest().refusal).toStrictEqual(refusal);
  });

  it("refuses under a named code when nothing is wired to run the command", async () => {
    // The negative control for both cases above, and the defect this closes: before
    // the executor existed the controller cleared the line here and reported
    // nothing, so a recognised command looked like it had succeeded.
    const driven = driveController(undefined);

    act(() => {
      driven.latest().changeText("/clear the deck");
    });
    await act(async () => {
      await driven.latest().send();
    });

    expect(driven.draftStore.read(driven.draftKey)?.text).toBe("/clear the deck");
    expect(driven.latest().refusal?.code).toBe("command-unexecutable");
  });

  it("leaves an unrecognised name to the router's own refusal", async () => {
    const runCommand = vi.fn<CommandExecutor>(async () => ({ status: "applied" }));
    const driven = driveController(runCommand);

    act(() => {
      driven.latest().changeText("/nosuchcommand");
    });
    await act(async () => {
      await driven.latest().send();
    });

    expect(runCommand).not.toHaveBeenCalled();
    expect(driven.latest().refusal?.code).toBe("unknown-command");
    expect(driven.draftStore.read(driven.draftKey)?.text).toBe("/nosuchcommand");
  });
});
