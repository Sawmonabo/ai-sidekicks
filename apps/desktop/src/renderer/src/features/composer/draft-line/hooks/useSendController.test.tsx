// What the controller does with a line the router intercepted. That arm reaches no wire, so
// these drive the real hook over the real `DraftStore`: the line clears only once the command
// applied, and a refused command keeps it.

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { bridgeAnswering } from "@test/helpers/fixture-bridge.js";
import { refuse } from "@renderer/lib/refusal.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import type { ComposerSessionTarget } from "../../composer-target.js";
import { WORKFLOW_COMMAND_ROOT } from "../../command-list/workflow-command/workflow-command-grammar.js";
import type { CommandExecutor } from "../../types.js";
import { composerDraftKey } from "../draft-key.js";
import type { SendController } from "../send-controller-contract.js";
import { useSendController } from "./useSendController.js";
import { SESSION_ID, sendCallsAnswering } from "../send-router.test-support.js";

const SESSION_TARGET: ComposerSessionTarget = {
  path: "session-message",
  sessionId: SESSION_ID,
};

/**
 * Calls that fail the case if a command reaches the wire. Module scope, so their identity is
 * stable and the router is not rebuilt on every probe render.
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
    target: SESSION_TARGET,
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
    draftKey: composerDraftKey(SESSION_TARGET),
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
      driven.latest().changeText("/clear the history");
    });
    await act(async () => {
      await driven.latest().send();
    });

    expect(runCommand).toHaveBeenCalledWith({ commandName: "clear", text: "/clear the history" });
    expect(driven.draftStore.read(driven.draftKey)).toBeUndefined();
    expect(driven.latest().refusal).toBeUndefined();
  });

  it("keeps the line and renders the refusal when the executor refuses", async () => {
    const refusal = refuse("commands", "not-here", "That command needs an open repo.");
    const driven = driveController(async () => ({ status: "refused", refusal }));

    act(() => {
      driven.latest().changeText("/clear the history");
    });
    await act(async () => {
      await driven.latest().send();
    });

    expect(driven.draftStore.read(driven.draftKey)?.text).toBe("/clear the history");
    expect(driven.latest().refusal).toStrictEqual(refusal);
  });
});
