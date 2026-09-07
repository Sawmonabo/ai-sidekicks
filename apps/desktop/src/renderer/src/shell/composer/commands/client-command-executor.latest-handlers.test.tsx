// The zone's executor runs the handlers of the render that is ON SCREEN.
//
// The executor is memoised on the surface thunk, so one object outlives every
// re-render of the composer — while the handlers it reaches close over what the
// composer is addressed at, which moves. The seam between those two lifetimes is a
// latest-ref, and this is the case that says the ref is actually refreshed: a
// composer re-addressed from "no session" to a session must run the accelerator
// against THAT session, not against the one the executor was built in.
//
// Asserted through the growth port rather than through the outcome text, because what
// the defect looks like is a call that never happens — an executor holding the first
// render's handlers refuses locally and asks the daemon nothing at all.
//
// THE ROOT IS REGISTERED HERE BECAUSE THE ZONE DOES NOT REGISTER IT. The console
// command that carries this id is registered by `useWorkflowStartPrefill`, which the
// discovery seat mounts and this zone does not — and the executor refuses a name the
// surface does not list before any handler is reached. Registering it is therefore
// scaffolding for the claim rather than part of it, and it is the same registration
// the sibling `client-command-executor.test.ts` performs for its own zone cases.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { GrowthPort } from "../../../console/bridge/index.js";
import { consoleCommands } from "../../../console/palette/index.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import type { CommandExecutor } from "../router/command-executor.js";
import { useComposerCommandZone } from "./client-command-executor.js";
import { ProviderCommandEnumeration } from "./provider-command-holder.js";
import {
  WORKFLOW_COMMAND_ROOT,
  WORKFLOW_START_DIRECTIVE_PREFILL,
} from "./workflow-start/grammar.js";
import {
  fixtureGrowthPort,
  recordedWorkflowCalls,
  WORKFLOW_TEST_SESSION_ID,
  type WorkflowPortCalls,
} from "./workflow-start/workflow-start.test-support.js";

/** A composer addressed at a channel, which is the zone's ordinary shape. */
const CHANNEL_TARGET: ComposerTarget = {
  path: "channel-message",
  sessionId: WORKFLOW_TEST_SESSION_ID,
  channelId: undefined,
  workspaceId: undefined,
  channelLabel: undefined,
};

/**
 * The accelerator suite's own port, recording which session each read named.
 *
 * Its default enumeration is empty, so a start settles as a local refusal about the
 * typed name and nothing is started — which is what this case wants, because the
 * question here is which session id reached the wire at all rather than what came
 * back. Built through the fixture rather than cast into the port's shape, so an
 * operation this path did not mean to call refuses loudly instead of being undefined.
 */
function portRecording(calls: WorkflowPortCalls): GrowthPort {
  return fixtureGrowthPort({ calls });
}

/** Which session each definition read named, in call order. */
function readSessionIds(calls: WorkflowPortCalls): (string | undefined)[] {
  return calls.listed.map((request) => request.sessionId);
}

/** The zone under a composer whose addressed session can change between renders. */
function ComposerCommandZoneHost(props: {
  readonly sessionId: string | undefined;
  readonly growth: GrowthPort;
  readonly commandEnumeration: ProviderCommandEnumeration;
  readonly executor: { current: CommandExecutor | undefined };
}): React.JSX.Element {
  const zone = useComposerCommandZone({
    route: DEFAULT_ROUTE,
    commandEnumeration: props.commandEnumeration,
    target: CHANNEL_TARGET,
    growth: props.growth,
    sessionId: props.sessionId,
  });
  props.executor.current = zone.commandExecutor;
  return <span />;
}

/** The line a person types to start a workflow by name. */
const START_LINE = {
  commandName: WORKFLOW_COMMAND_ROOT,
  text: `${WORKFLOW_START_DIRECTIVE_PREFILL}nightly-review`,
} as const;

describe("the composer command zone reads the committed render's handlers", () => {
  afterEach(() => {
    consoleCommands.unregister(WORKFLOW_COMMAND_ROOT);
  });

  /** Put the root on the surface the recogniser reads, as the prefill seat does. */
  function registerWorkflowRoot(): void {
    consoleCommands.register({
      id: WORKFLOW_COMMAND_ROOT,
      title: "Start a workflow",
      group: "Workflows",
      run: () => {},
    });
  }

  it("runs the accelerator against the session the composer is addressed at now", async () => {
    registerWorkflowRoot();
    const calls = recordedWorkflowCalls();
    const growth = portRecording(calls);
    const commandEnumeration = new ProviderCommandEnumeration();
    const executor: { current: CommandExecutor | undefined } = { current: undefined };
    const { rerender } = render(
      <ComposerCommandZoneHost
        sessionId={undefined}
        growth={growth}
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
        growth={growth}
        commandEnumeration={commandEnumeration}
        executor={executor}
      />,
    );
    expect(executor.current).toBe(builtInFirstRender);

    await executor.current?.(START_LINE);

    expect(readSessionIds(calls)).toStrictEqual([WORKFLOW_TEST_SESSION_ID]);
  });

  it("negative control: the first render's handlers reach no wire at all", async () => {
    // Without this the case above would pass over a ref that is never refreshed only
    // by luck of ordering. A stale handler carries `sessionId: undefined`, which the
    // accelerator refuses locally — so the port records nothing and the failure is a
    // silent absence rather than a wrong id.
    registerWorkflowRoot();
    const calls = recordedWorkflowCalls();
    const executor: { current: CommandExecutor | undefined } = { current: undefined };
    render(
      <ComposerCommandZoneHost
        sessionId={undefined}
        growth={portRecording(calls)}
        commandEnumeration={new ProviderCommandEnumeration()}
        executor={executor}
      />,
    );

    const outcome = await executor.current?.(START_LINE);

    expect(outcome?.status).toBe("refused");
    expect(readSessionIds(calls)).toStrictEqual([]);
  });
});
