// What the controller does with a line the router intercepted.
//
// The interception arm is the one send path that reaches no wire, so nothing about
// it is observable from the call stub the send bar's own cases use. These drive
// the real hook over the real `DraftStore` and assert the settlements a recognised
// command can have: it ran, it was refused, nothing here could run it, or it reads
// its arguments off the line and had no handler.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bridgeAnswering } from "@renderer/console/bridge/fixture/call-plane/bridge.test-support.js";
import { refuse } from "@renderer/lib/refusal.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { consoleCommands } from "@renderer/console/palette/index.js";
import { DEFAULT_ROUTE } from "@renderer/routing/routes.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import type { ComposerChannelTarget } from "@renderer/shell/composer/chips/chip-models.js";
import { createClientCommandExecutor } from "@renderer/shell/composer/commands/client-command-executor.js";
import {
  LINE_READING_COMMAND_IDS,
  noDirectiveLineHandlers,
} from "../../command-list/composer-command-line-handlers.js";
import { composerCommandSurface } from "../../command-list/composer-commands.js";
import { WORKFLOW_COMMAND_ROOT } from "../../command-list/workflow-command/workflow-command-grammar.js";
import type { CommandExecutor } from "../../types.js";
import { composerDraftKey } from "../draft-key.js";
import type { SendController } from "../send-controller-contract.js";
import { useSendController } from "./useSendController.js";
import { SESSION_ID, sendCallsAnswering } from "../send-router.test-support.js";

const CHANNEL_TARGET: ComposerChannelTarget = {
  path: "channel-message",
  sessionId: SESSION_ID,
};

/**
 * Calls that fail the case loudly if a command ever reaches the wire.
 *
 * Module scope, so their identity is stable across the probe's renders: calls rebuilt
 * in the render body would rebuild the router on every pass and hide a dependency
 * mistake behind a fresh object.
 */
const UNREACHABLE_CALLS = sendCallsAnswering(async () => {
  throw new Error("an intercepted command must reach no wire call");
});

/** The transport the controller's held state belongs to; nothing calls through it. */
const BRIDGE = bridgeAnswering(async () => undefined).bridge;

/** Reports the controller out of the tree, so a case drives the real hook. */
function ControllerProbe(props: {
  readonly draftStore: DraftStore;
  readonly commandExecutor: CommandExecutor | undefined;
  readonly onController: (controller: SendController) => void;
}): null {
  const controller = useSendController({
    bridge: BRIDGE,
    calls: UNREACHABLE_CALLS,
    target: CHANNEL_TARGET,
    draftStore: props.draftStore,
    recognizeClientCommand: (commandName) =>
      commandName === "clear" || commandName === WORKFLOW_COMMAND_ROOT,
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
  const draftStore = new DraftStore({
    maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
  });
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
});

describe("useSendController — a command that reads its line and has no handler", () => {
  afterEach(() => {
    consoleCommands.unregister(WORKFLOW_COMMAND_ROOT);
  });

  it("leaves the line as typed, draws nothing, and records no history", async () => {
    const paletteAct = vi.fn();
    consoleCommands.register({
      id: WORKFLOW_COMMAND_ROOT,
      title: "Start a workflow",
      group: "Workflow",
      run: paletteAct,
    });
    const driven = driveController(
      createClientCommandExecutor({
        readSurface: () => composerCommandSurface(DEFAULT_ROUTE),
        readDirectiveHandlers: noDirectiveLineHandlers,
        lineReadingCommandIds: LINE_READING_COMMAND_IDS,
      }),
    );

    act(() => {
      driven.latest().changeText("/workflow start nightly");
    });
    await act(async () => {
      await driven.latest().send();
    });

    expect(driven.draftStore.read(driven.draftKey)?.text).toBe("/workflow start nightly");
    expect(driven.latest().refusal).toBeUndefined();
    expect(paletteAct).not.toHaveBeenCalled();
    act(() => {
      driven.latest().changeText("");
    });
    expect(driven.latest().recallOlder({ selectionStart: 0, selectionEnd: 0, textLength: 0 })).toBe(
      false,
    );
  });
});
