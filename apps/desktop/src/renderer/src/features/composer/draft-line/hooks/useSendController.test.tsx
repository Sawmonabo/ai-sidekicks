// What the controller does with a line the router intercepted, driven through the real hook over
// the real `DraftStore`: the line clears only once the command applied, a refused command keeps
// it, and a line its command does not act on goes to the provider exactly as typed.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inertBridge } from "../../composer.test-support.js";
import { refuse } from "@renderer/lib/refusal.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { DEFAULT_ROUTE } from "@renderer/routing/routes.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import type { RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import type { ComposerSessionTarget } from "../../composer-target.js";
import { LINE_READING_COMMAND_IDS } from "../../command-list/composer-command-line-handlers.js";
import { readComposerCommands } from "../../command-list/composer-commands.js";
import { createConsoleCommandExecutor } from "../../command-list/console-command-executor.js";
import { startWorkflowFromLine } from "../../command-list/workflow-command/start-workflow-from-line.js";
import {
  fixtureWorkflowStartOperations,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "../../command-list/workflow-command/workflow-command.test-support.js";
import { WORKFLOW_COMMAND_ROOT } from "../../command-list/workflow-command/workflow-command-grammar.js";
import type { CommandExecutor } from "../../types.js";
import { composerDraftKey } from "../draft-key.js";
import type { ComposerSendCalls } from "../send-dispatch.js";
import type { SendController } from "../send-controller-contract.js";
import { useSendController } from "./useSendController.js";
import { QUEUE_CREATED, SESSION_ID, sendCallsAnswering } from "../send-router.test-support.js";

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
const BRIDGE = inertBridge();

/** Reports the controller out of the tree, so a case drives the real hook. */
function ControllerProbe(props: {
  readonly draftStore: DraftStore;
  readonly calls: ComposerSendCalls;
  readonly commandExecutor: CommandExecutor | undefined;
  readonly onController: (controller: SendController) => void;
}): null {
  const controller = useSendController({
    bridge: BRIDGE,
    calls: props.calls,
    target: SESSION_TARGET,
    draftStore: props.draftStore,
    recognizeConsoleCommand: (commandName) =>
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

function driveController(
  commandExecutor: CommandExecutor | undefined,
  calls: ComposerSendCalls = UNREACHABLE_CALLS,
): DrivenController {
  const draftStore = new DraftStore({
    maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
  });
  let latest: SendController | undefined;
  render(
    <ControllerProbe
      draftStore={draftStore}
      calls={calls}
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

    driven.draftStore.write(driven.draftKey, "/clear the history");
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

    driven.draftStore.write(driven.draftKey, "/clear the history");
    await act(async () => {
      await driven.latest().send();
    });

    expect(driven.draftStore.read(driven.draftKey)?.text).toBe("/clear the history");
    expect(driven.latest().refusal).toStrictEqual(refusal);
  });
});

describe("useSendController — a line its command does not act on", () => {
  afterEach(() => {
    commandRegistry.unregister(WORKFLOW_COMMAND_ROOT);
  });

  it("sends the line to the provider exactly as typed", async () => {
    commandRegistry.register({
      id: WORKFLOW_COMMAND_ROOT,
      title: "Start a workflow",
      group: "Workflow",
      run: () => undefined,
    });
    const workflowCalls = recordedWorkflowCalls();
    const executor = createConsoleCommandExecutor({
      readCommands: () => readComposerCommands(DEFAULT_ROUTE),
      readCommandLineHandlers: () =>
        new Map([
          [
            WORKFLOW_COMMAND_ROOT,
            async (line) =>
              await startWorkflowFromLine(line, {
                operations: fixtureWorkflowStartOperations({
                  definitions: [{ name: "nightly" }],
                  calls: workflowCalls,
                }),
                sessionId: WORKFLOW_TEST_SESSION_ID,
              }),
          ],
        ]),
      lineReadingCommandIds: LINE_READING_COMMAND_IDS,
    });
    const wireCalls: RecordedDaemonCall[] = [];
    const driven = driveController(
      executor,
      sendCallsAnswering(async (call) => {
        wireCalls.push(call);
        return QUEUE_CREATED;
      }),
    );
    // The trailing whitespace is kept: the executor reads a trimmed line, the wire gets the bytes.
    const typed = "/workflow stop nightly  \n";

    driven.draftStore.write(driven.draftKey, typed);
    await act(async () => {
      await driven.latest().send();
    });

    expect(wireCalls).toStrictEqual([
      {
        method: "run.queueCreate",
        params: { sessionId: SESSION_ID, clientIdempotencyKey: expect.any(String), content: typed },
      },
    ]);
    expect(workflowCalls.started).toHaveLength(0);
    expect(driven.latest().refusal).toBeUndefined();
  });
});
