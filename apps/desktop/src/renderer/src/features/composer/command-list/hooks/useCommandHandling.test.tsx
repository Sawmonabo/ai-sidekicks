// The zone's executor runs the handlers of the render that is ON SCREEN.
//
// The executor outlives every re-render while its handlers close over the session the
// composer is addressed at. A composer re-addressed from "no session" to a session must
// run the accelerator against THAT session, not the one the executor was built in.
//
// Asserted through the recorded calls rather than the outcome text, because the defect
// is a call that never happens: an executor holding the first render's handlers
// refuses locally and starts nothing.
//
// THE ROOT IS REGISTERED HERE BECAUSE THE ZONE DOES NOT REGISTER IT. The console
// command that carries this id is registered by `useWorkflowStartPrefill`, which the
// discovery seat mounts and this zone does not — and the executor refuses a name the
// surface does not list before any handler is reached. Registering it is therefore
// scaffolding for the claim rather than part of it.

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

/** The target the zone reads a binding's published names for. */
const SESSION_TARGET: ComposerTarget = {
  path: "session-message",
  sessionId: WORKFLOW_TEST_SESSION_ID,
};

/**
 * Stub calls recording which session each definition read named.
 *
 * Its default enumeration is empty, so a start settles as a local refusal about the
 * typed name and nothing is started; the question here is which session id reached the
 * call at all rather than what came back.
 */
function operationsRecording(calls: WorkflowCalls): WorkflowStartOperations {
  return fixtureWorkflowStartOperations({ calls });
}

/** Which session each definition read named, in call order. */
function readSessionIds(calls: WorkflowCalls): (string | undefined)[] {
  return calls.listed.map((request) => request.sessionId);
}

/** The zone under a composer whose addressed session can change between renders. */
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

/** The line a person types to start a workflow by name. */
const START_LINE = {
  commandName: WORKFLOW_COMMAND_ROOT,
  text: `${WORKFLOW_START_COMMAND_PREFILL}nightly-review`,
} as const;

describe("the composer command zone reads the committed render's handlers", () => {
  afterEach(() => {
    commandRegistry.unregister(WORKFLOW_COMMAND_ROOT);
  });

  /** Put the root on the surface the recogniser reads, as the prefill seat does. */
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
    // Re-addressed after the executor was built. The executor object is memoised on
    // the surface thunk and so does not change; only what its handlers close over does.
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

  it("negative control: the first render's handlers reach no call at all", async () => {
    // Without this the case above would pass over a ref that is never refreshed only
    // by luck of ordering. A stale handler carries `sessionId: undefined`, which the
    // accelerator refuses locally — so nothing is recorded and the failure is a
    // silent absence rather than a wrong id.
    registerWorkflowRoot();
    const calls = recordedWorkflowCalls();
    const executor: { current: CommandExecutor | undefined } = { current: undefined };
    render(
      <ComposerCommandZoneHost
        sessionId={undefined}
        operations={operationsRecording(calls)}
        commandEnumeration={new ProviderCommandEnumeration()}
        executor={executor}
      />,
    );

    const outcome = await executor.current?.(START_LINE);

    expect(outcome?.status).toBe("refused");
    expect(readSessionIds(calls)).toStrictEqual([]);
  });
});
