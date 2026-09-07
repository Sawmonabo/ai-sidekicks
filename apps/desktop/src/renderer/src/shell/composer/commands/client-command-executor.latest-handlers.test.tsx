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

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MAXIMUM_LIVE_DRAFT_COUNT } from "../../../console/core/index.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { DEFAULT_ROUTE } from "../../../console/routing/index.js";
import type { GrowthPort } from "../../../console/bridge/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import type { CommandExecutor } from "../router/command-executor.js";
import { useComposerCommandZone } from "./client-command-executor.js";
import { ProviderCommandEnumeration } from "./provider-command-holder.js";
import {
  WORKFLOW_START_COMMAND_ID,
  WORKFLOW_START_DIRECTIVE_PREFILL,
} from "./workflow-start-accelerator.js";

const SECOND_SESSION_ID = "d1e2f304-5061-4172-8394-a5b6c7d8e9f0";

/** A composer addressed at a channel, which is the zone's ordinary shape. */
const CHANNEL_TARGET: ComposerTarget = {
  path: "channel-message",
  sessionId: SECOND_SESSION_ID,
  channelId: undefined,
  workspaceId: undefined,
  channelLabel: undefined,
};

/** A store at the console's own live-draft ceiling; no case here writes a draft. */
function draftStoreAtCeiling(): DraftStore {
  return new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
}

/**
 * A port that records which session each definition read named.
 *
 * Recording only, and deliberately not the accelerator suite's `portServing`: that
 * one serves definitions and refusals so dispatch claims can be asserted, while the
 * question here is which session id reached the wire at all. It answers with an empty
 * definition list, so the command settles as a local refusal about the typed name and
 * nothing is started.
 */
function recordingGrowthPort(readSessionIds: string[]): GrowthPort {
  return {
    workflowDefinitionList: async (request: { readonly sessionId: string }) => {
      readSessionIds.push(request.sessionId);
      return { status: "served", value: { definitions: [] } };
    },
  } as unknown as GrowthPort;
}

/** The zone under a composer whose addressed session can change between renders. */
function ComposerCommandZoneHost(props: {
  readonly sessionId: string | undefined;
  readonly growth: GrowthPort;
  readonly draftStore: DraftStore;
  readonly commandEnumeration: ProviderCommandEnumeration;
  readonly executor: { current: CommandExecutor | undefined };
}): React.JSX.Element {
  const zone = useComposerCommandZone({
    route: DEFAULT_ROUTE,
    commandEnumeration: props.commandEnumeration,
    target: CHANNEL_TARGET,
    growth: props.growth,
    sessionId: props.sessionId,
    draftStore: props.draftStore,
    draftKey: "composer-latest-handlers",
  });
  props.executor.current = zone.commandExecutor;
  return <span />;
}

describe("the composer command zone reads the committed render's handlers", () => {
  it("runs the accelerator against the session the composer is addressed at now", async () => {
    const readSessionIds: string[] = [];
    const growth = recordingGrowthPort(readSessionIds);
    const commandEnumeration = new ProviderCommandEnumeration();
    const draftStore = draftStoreAtCeiling();
    const executor: { current: CommandExecutor | undefined } = { current: undefined };
    const { rerender } = render(
      <ComposerCommandZoneHost
        sessionId={undefined}
        growth={growth}
        draftStore={draftStore}
        commandEnumeration={commandEnumeration}
        executor={executor}
      />,
    );
    // Re-addressed after the executor was built. The executor object is memoised on
    // the surface thunk and so does not change; only what its handlers close over does.
    const builtInFirstRender = executor.current;
    rerender(
      <ComposerCommandZoneHost
        sessionId={SECOND_SESSION_ID}
        growth={growth}
        draftStore={draftStore}
        commandEnumeration={commandEnumeration}
        executor={executor}
      />,
    );
    expect(executor.current).toBe(builtInFirstRender);

    await executor.current?.({
      commandName: WORKFLOW_START_COMMAND_ID,
      text: `${WORKFLOW_START_DIRECTIVE_PREFILL}nightly-review`,
    });

    expect(readSessionIds).toStrictEqual([SECOND_SESSION_ID]);
  });

  it("negative control: the first render's handlers reach no wire at all", async () => {
    // Without this the case above would pass over a ref that is never refreshed only
    // by luck of ordering. A stale handler carries `sessionId: undefined`, which the
    // accelerator refuses locally — so the port records nothing and the failure is a
    // silent absence rather than a wrong id.
    const readSessionIds: string[] = [];
    const growth = recordingGrowthPort(readSessionIds);
    const executor: { current: CommandExecutor | undefined } = { current: undefined };
    render(
      <ComposerCommandZoneHost
        sessionId={undefined}
        growth={growth}
        draftStore={draftStoreAtCeiling()}
        commandEnumeration={new ProviderCommandEnumeration()}
        executor={executor}
      />,
    );

    const outcome = await executor.current?.({
      commandName: WORKFLOW_START_COMMAND_ID,
      text: `${WORKFLOW_START_DIRECTIVE_PREFILL}nightly-review`,
    });

    expect(outcome?.status).toBe("refused");
    expect(readSessionIds).toStrictEqual([]);
  });
});
