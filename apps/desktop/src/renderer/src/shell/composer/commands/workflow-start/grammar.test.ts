// The documented line parses, and the dotted one it replaced is nobody's command.
//
// `Spec-017 §Chat-start surface (SA-38)` fixes the surface: one command root,
// `workflow`, one V1 verb, `start`, and the line `/workflow start <name>`. The
// end-to-end case below is what makes that a claim about the SHIPPED path rather than
// about this module — the same recogniser the send bar hands the router, the real
// router, and the real executor over the real console registry — and its negative
// control is the defect it was written for: with the dotted id registered instead, the
// documented line reaches the router as an unregistered name.

import { afterEach, describe, expect, it } from "vitest";

import { consoleCommands } from "../../../../console/palette/index.js";
import { DEFAULT_ROUTE } from "../../../../console/routing/index.js";
import type { ComposerTarget } from "../../chips/chip-models.js";
import { ComposerSendRouter } from "../../router/send-router.js";
import { createClientCommandExecutor } from "../client-command-executor.js";
import { recognizeClientCommand } from "../client-command-recognizer.js";
import { composerCommandSurface } from "../console-command-surface.js";
import type { DirectiveLineHandlers } from "../directive-line-handlers.js";
import {
  fixtureGrowthPort,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
} from "./workflow-start.test-support.js";
import { WORKFLOW_COMMAND_ROOT, readWorkflowCommandLine } from "./grammar.js";
import { startWorkflowFromLine } from "./start-dispatch.js";

/** The id this surface carried before the root registration, kept only as a foil. */
const SUPERSEDED_DOTTED_ID = "workflow.start";

const CHANNEL_TARGET: ComposerTarget = {
  path: "channel-message",
  sessionId: WORKFLOW_TEST_SESSION_ID,
  channelId: undefined,
  workspaceId: undefined,
  channelLabel: undefined,
};

const registeredIds: string[] = [];

/** Register one id into the real console registry, with an act that does nothing. */
function registerRoot(commandId: string): void {
  consoleCommands.register({
    id: commandId,
    title: "Start a workflow",
    group: "Workflow",
    run: () => undefined,
  });
  registeredIds.push(commandId);
}

/** The router the send bar builds, over whichever ids the registry holds. */
function routerOverRegistry(): ComposerSendRouter {
  return new ComposerSendRouter({
    bridge: {} as never,
    recognizeClientCommand: (commandName) =>
      recognizeClientCommand(commandName, {
        registeredCommandIds: composerCommandSurface(DEFAULT_ROUTE).registeredCommandIds,
      }).status === "recognized",
  });
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    consoleCommands.unregister(commandId);
  }
});

describe("the `/workflow` line", () => {
  it.each([
    ["a plain name", "/workflow start nightly-review", "nightly-review"],
    ["a name with spaces in it", "/workflow start nightly review", "nightly review"],
    ["surrounding whitespace", "/workflow   start   nightly  ", "nightly"],
  ])("reads %s", (_case, text, expected) => {
    expect(readWorkflowCommandLine(text)).toStrictEqual({
      status: "start",
      definitionName: expected,
    });
  });

  it("reads a verb with nothing after it as a start that named no definition", () => {
    expect(readWorkflowCommandLine("/workflow start")).toStrictEqual({
      status: "start",
      definitionName: undefined,
    });
  });

  it("reads a line that named only the root as a missing verb", () => {
    expect(readWorkflowCommandLine("/workflow")).toStrictEqual({ status: "verb-missing" });
    expect(readWorkflowCommandLine("/workflow   ")).toStrictEqual({ status: "verb-missing" });
  });

  it("names an unrecognised verb rather than reading it as a definition", () => {
    expect(readWorkflowCommandLine("/workflow stop nightly")).toStrictEqual({
      status: "verb-unknown",
      verb: "stop",
    });
  });

  it("reads nothing off a line that is not this command's", () => {
    expect(readWorkflowCommandLine("/frame.goToSettings")).toBeUndefined();
    expect(readWorkflowCommandLine("ship the parser fix")).toBeUndefined();
    // The escape is deliberately not a command, so it names no root either.
    expect(readWorkflowCommandLine("//workflow start nightly")).toBeUndefined();
  });
});

describe("the documented line, end to end through the recogniser and the router", () => {
  it("intercepts `/workflow start <name>` and starts the named definition", async () => {
    registerRoot(WORKFLOW_COMMAND_ROOT);
    const calls = recordedWorkflowCalls();
    const resolution = routerOverRegistry().resolve("/workflow start nightly", CHANNEL_TARGET);

    expect(resolution).toStrictEqual({
      outcome: "client-command",
      commandName: WORKFLOW_COMMAND_ROOT,
    });
    if (resolution.outcome !== "client-command") {
      throw new Error("the documented line must be intercepted as a client command");
    }
    const handlers: DirectiveLineHandlers = new Map([
      [
        WORKFLOW_COMMAND_ROOT,
        async (line) =>
          await startWorkflowFromLine(line, {
            growth: fixtureGrowthPort({ definitions: [{ name: "nightly" }], calls }),
            sessionId: WORKFLOW_TEST_SESSION_ID,
            channelId: undefined,
          }),
      ],
    ]);
    const executor = createClientCommandExecutor({
      readSurface: () => composerCommandSurface(DEFAULT_ROUTE),
      readDirectiveHandlers: () => handlers,
    });

    const outcome = await executor({
      commandName: resolution.commandName,
      text: "/workflow start nightly",
    });

    expect(outcome).toStrictEqual({ status: "applied" });
    expect(calls.started.map((request) => request.workflowVersionId)).toStrictEqual([
      "version-nightly",
    ]);
  });

  it("negative control: under the superseded dotted id the documented line is unknown", () => {
    // The defect this registration replaced. `directive-syntax.ts` hands the recogniser
    // the FIRST WORD, so with `workflow.start` registered the spec's own line names
    // `workflow` — an id the console does not hold — and refuses loudly.
    registerRoot(SUPERSEDED_DOTTED_ID);

    const resolution = routerOverRegistry().resolve("/workflow start nightly", CHANNEL_TARGET);

    expect(resolution.outcome).toBe("refused");
    expect(resolution.outcome === "refused" ? resolution.refusal.code : undefined).toBe(
      "unknown-command",
    );
  });
});
