// What the controller does with a line, driven through the real hook over the real `DraftStore`:
// the line clears only once the command applied, a refused command keeps it, a line its command
// does not act on goes to the provider exactly as typed, and a sent message carries the held
// draft's extras and clears the draft the daemon holds.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDraft } from "@ai-sidekicks/contracts/session/draft";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { inertBridge } from "#renderer/features/composer/Composer.test-support.js";
import { refuse } from "#renderer/lib/refusal/contract.js";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
import { DEFAULT_ROUTE } from "#renderer/routing/routes.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "#renderer/store/persistence/caps.js";
import { DraftStore } from "#renderer/store/drafts.js";
import type { RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import type { ComposerSessionTarget } from "#renderer/features/composer/target.js";
import { LINE_READING_COMMAND_IDS } from "#renderer/features/composer/command-list/line-handlers.js";
import { readComposerCommands } from "#renderer/features/composer/command-list/registry-view.js";
import { createConsoleCommandExecutor } from "#renderer/features/composer/command-list/console/executor.js";
import { startWorkflowFromLine } from "#renderer/features/composer/command-list/workflow/start-from-line.js";
import {
  fixtureWorkflowStartOperations,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "#renderer/features/composer/command-list/workflow/start-from-line.test-support.js";
import { WORKFLOW_COMMAND_ROOT } from "#renderer/features/composer/command-list/workflow/grammar.js";
import type { CommandExecutor } from "#renderer/features/composer/types.js";
import { composerDraftKey } from "../../draft-key.js";
import type { ComposerSendCalls } from "../dispatch.js";
import type { SendController } from "../controller-contract.js";
import { useSendController } from "./useSendController.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { COMPOSER_DRAFT_SAVE_PAUSE_MILLISECONDS } from "#renderer/features/composer/bounds.js";
import {
  ComposerHeldDraft,
  type DraftSaving,
} from "#renderer/features/composer/held-draft/holder.js";
import { QUEUE_CREATED, SESSION_ID, sendCallsAnswering } from "../router.test-support.js";

const SESSION_TARGET: ComposerSessionTarget = {
  kind: "session",
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
  readonly heldDraft: ComposerHeldDraft;
  readonly calls: ComposerSendCalls;
  readonly commandExecutor: CommandExecutor | undefined;
  readonly onController: (controller: SendController) => void;
}): null {
  const controller = useSendController({
    bridge: BRIDGE,
    calls: props.calls,
    target: SESSION_TARGET,
    draftStore: props.draftStore,
    heldDraft: props.heldDraft,
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
  readonly heldDraft: ComposerHeldDraft;
  latest(): SendController;
}

function driveController(
  commandExecutor: CommandExecutor | undefined,
  calls: ComposerSendCalls = UNREACHABLE_CALLS,
  saving?: DraftSaving,
): DrivenController {
  const draftStore = new DraftStore({
    maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT,
  });
  const draftKey = composerDraftKey(SESSION_TARGET.sessionId);
  const heldDraft = new ComposerHeldDraft({
    draftStore,
    draftKey,
    ...(saving === undefined ? {} : { saving }),
  });
  let latest: SendController | undefined;
  render(
    <ControllerProbe
      draftStore={draftStore}
      heldDraft={heldDraft}
      calls={calls}
      commandExecutor={commandExecutor}
      onController={(controller) => {
        latest = controller;
      }}
    />,
  );
  return {
    draftStore,
    draftKey,
    heldDraft,
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
      title: "Run a workflow",
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
        method: "agent.queueItem.create",
        params: { sessionId: SESSION_ID, clientIdempotencyKey: expect.any(String), content: typed },
      },
    ]);
    expect(workflowCalls.started).toHaveLength(0);
    expect(driven.latest().refusal).toBeUndefined();
  });
});

describe("useSendController — a sent message and the held draft", () => {
  it("queues the message with the held draft's extras and saves the cleared draft", async () => {
    // Mutation: dropping `heldDraft.clearSent()` after a send leaves the pick on the daemon's draft
    // (no save, or one still naming it); dropping the extras from the send loses the pick.
    const pick = { name: "codemod", folderPath: "/repo/.ai-sidekicks/skills/codemod" };
    const saved: { readonly draft: SessionDraft; readonly expectedRevision: number }[] = [];
    const wireCalls: RecordedDaemonCall[] = [];
    const clock = new ManualClock();
    const driven = driveController(
      undefined,
      sendCallsAnswering(async (call) => {
        wireCalls.push(call);
        return QUEUE_CREATED;
      }),
      {
        clock,
        save: async (draft, expectedRevision) => {
          saved.push({ draft, expectedRevision });
          return {
            status: "served",
            value: {
              sessionId: SESSION_ID as SessionId,
              revision: expectedRevision + 1,
              updatedAt: "2026-11-09T10:00:00.000Z",
            },
          };
        },
      },
    );
    // Typed, then the pause saves it, so the daemon holds the words and the pick before the send.
    driven.heldDraft.addSkillPick(pick, "/codemod");
    driven.draftStore.write(driven.draftKey, "/codemod Run it");
    await act(async () => {
      clock.advance(COMPOSER_DRAFT_SAVE_PAUSE_MILLISECONDS);
      await crossMacrotaskBoundary();
    });

    await act(async () => {
      await driven.latest().send();
    });

    expect(wireCalls).toStrictEqual([
      {
        method: "agent.queueItem.create",
        params: {
          sessionId: SESSION_ID,
          clientIdempotencyKey: expect.any(String),
          content: "/codemod Run it",
          skills: [pick],
        },
      },
    ]);
    expect(saved).toStrictEqual([
      { draft: { text: "/codemod Run it", extras: { skills: [pick] } }, expectedRevision: 0 },
      { draft: { text: "", extras: {} }, expectedRevision: 1 },
    ]);
  });
});
