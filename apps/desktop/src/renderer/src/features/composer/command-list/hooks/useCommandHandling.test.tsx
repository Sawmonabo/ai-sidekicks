// The executor outlives every re-render while its handlers close over the addressed session, so a
// composer re-addressed from no session to a session must run the handler against that session.
// The workflow root is registered here because the hook does not register it and the executor
// refuses unlisted names first.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { DEFAULT_ROUTE } from "@renderer/routing/routes.js";
import type { ComposerTarget } from "../../composer-target.js";
import type { CommandExecutor } from "../../types.js";
import { useCommandHandling } from "./useCommandHandling.js";
import { ProviderCommandEnumeration } from "../provider-command-enumeration.js";
import type { WorkflowStartOperations } from "../workflow-command/start-workflow-from-line.js";
import { useWorkflowStartHandlers } from "../workflow-command/hooks/useWorkflowStartHandlers.js";
import {
  WORKFLOW_COMMAND_ROOT,
  WORKFLOW_START_COMMAND_PREFILL,
} from "../workflow-command/workflow-command-grammar.js";
import {
  fixtureWorkflowStartOperations,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
  type WorkflowCalls,
} from "../workflow-command/workflow-command.test-support.js";

const SESSION_TARGET: ComposerTarget = {
  path: "session-message",
  sessionId: WORKFLOW_TEST_SESSION_ID,
};

/** Stub calls recording which session each definition read named; enumeration starts empty. */
function operationsRecording(calls: WorkflowCalls): WorkflowStartOperations {
  return fixtureWorkflowStartOperations({ calls });
}

function readSessionIds(calls: WorkflowCalls): (string | undefined)[] {
  return calls.listed.map((request) => request.sessionId);
}

function ComposerCommandZoneHost(props: {
  readonly sessionId: string | undefined;
  readonly operations: WorkflowStartOperations;
  readonly commandEnumeration: ProviderCommandEnumeration;
  readonly executor: { current: CommandExecutor | undefined };
}): React.JSX.Element {
  const zone = useCommandHandling({
    route: DEFAULT_ROUTE,
    commandEnumeration: props.commandEnumeration,
    target: SESSION_TARGET,
    commandLineHandlers: useWorkflowStartHandlers({
      operations: props.operations,
      sessionId: props.sessionId,
    }),
  });
  props.executor.current = zone.commandExecutor;
  return <span />;
}

const START_LINE = {
  commandName: WORKFLOW_COMMAND_ROOT,
  text: `${WORKFLOW_START_COMMAND_PREFILL}nightly-review`,
} as const;

describe("the composer command zone reads the committed render's handlers", () => {
  afterEach(() => {
    commandRegistry.unregister(WORKFLOW_COMMAND_ROOT);
  });

  function registerWorkflowRoot(): void {
    commandRegistry.register({
      id: WORKFLOW_COMMAND_ROOT,
      title: "Start a workflow",
      group: "Workflows",
      run: () => {},
    });
  }

  it("runs the accelerator against the session the composer is addressed at now", async () => {
    registerWorkflowRoot();
    const calls = recordedWorkflowCalls();
    const operations = operationsRecording(calls);
    const commandEnumeration = new ProviderCommandEnumeration();
    const executor: { current: CommandExecutor | undefined } = { current: undefined };
    const { rerender } = render(
      <ComposerCommandZoneHost
        sessionId={undefined}
        operations={operations}
        commandEnumeration={commandEnumeration}
        executor={executor}
      />,
    );
    // Re-addressed after the executor was built; the memoized executor does not change, only what
    // its handlers close over.
    const builtInFirstRender = executor.current;
    rerender(
      <ComposerCommandZoneHost
        sessionId={WORKFLOW_TEST_SESSION_ID}
        operations={operations}
        commandEnumeration={commandEnumeration}
        executor={executor}
      />,
    );
    expect(executor.current).toBe(builtInFirstRender);

    await executor.current?.(START_LINE);

    expect(readSessionIds(calls)).toStrictEqual([WORKFLOW_TEST_SESSION_ID]);
  });
});
