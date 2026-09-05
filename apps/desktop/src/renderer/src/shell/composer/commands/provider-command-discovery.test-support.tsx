// The discovery surface's shared scaffolding: one composer, mounted for real.
//
// Lives here because four suites drive the SAME composition — the surface watches a
// line it does not own, opens on what a person types into it, and writes nothing
// back — and a second mount helper written beside one of them would be a second
// answer to what "the composer" means in these cases.
//
// THE STORE IS THE REAL ONE, fed the composer scenario's own beats through the
// registered run projectors, so the address these cases resolve is the address the
// shipped surface resolves. The bridge is the real fixture with `answer` in front of
// `daemon.call`, so every reply, refusal, and clock reading is the fixture's own.

import type { ProviderCommandBindingGroup, RunId } from "@ai-sidekicks/contracts";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach } from "vitest";
import {
  createFixtureBridge,
  readRunId,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";
import {
  bridgeAnswering,
  type RecordedDaemonCall,
} from "../../../console/bridge/fixture-bridge.test-support.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import { consoleCommands } from "../../../console/frame/command-surface.js";
import { RUN_LIFECYCLE_PROJECTORS } from "../../../console/frame/run-lifecycle-projector.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { MessageComposer } from "../../MessageComposer.js";
import { settleEnumeration } from "./provider-command-read.js";
// The enumeration method string and the recording bridge are the holder suite's, and
// there is one of each: two copies would let the two suites disagree about which call
// they are watching for.
import { ENUMERATION_METHOD } from "./provider-command-holder.test-support.js";

export const TEST_COMMAND_ID = "composer-discovery-test.act";
/** A prefix no console command and no enumerated provider entry begins with. */
export const UNMATCHED_PREFIX = "/zzz-nothing-begins-with-this";
export const EMPTY_STATE_SENTENCE = "No command matches what you have typed";
/** The opening of the sentence the popover renders when no group names this run. */
export const UNADDRESSED_BINDING_SENTENCE = "This run's binding published nothing here";
/** A fragment of the sentence a press on a non-executable row is answered with. */
export const NOT_RUNNABLE_FRAGMENT = "there is nothing here to run";
/** An entry name the scenario's own enumeration does not carry. */
export const UNADDRESSED_ENTRY_NAME = "status";
/**
 * The run identifier the wire admits, or a loud failure.
 *
 * `runId` is a branded id, and a literal asserted into that brand would let a group
 * these cases treat as wire-shaped carry a value the wire would refuse. The bridge
 * family's own reader answers the brand; a fixture whose id the wire would not take
 * fails here rather than reaching a case as if it had been enumerated.
 */
function fixtureRunId(value: string): RunId {
  const runId = readRunId(value);
  if (runId === undefined) {
    throw new Error(`this fixture names a run id the wire would refuse: ${value}`);
  }
  return runId;
}

/**
 * A live binding on the OTHER provider, attributed to a run this composer never
 * addresses — the second group the agent-scoped reply can carry.
 *
 * A typed literal over the registered shape rather than a parse of an untyped one:
 * a surface's suite reads the reply the bridge family parsed and holds no parser of
 * its own, and the annotation is the stronger claim — a member the wire does not
 * carry fails `typecheck` here rather than at the moment a case runs.
 */
export const UNADDRESSED_CODEX_GROUP: ProviderCommandBindingGroup = {
  runId: fixtureRunId("019b7a11-1100-740e-8120-d1a4c1150312"),
  binding: { driverName: "codex", providerAccountId: null },
  entries: [
    {
      name: UNADDRESSED_ENTRY_NAME,
      kind: "command",
      description: "Report the other binding's state.",
      binding: { driverName: "codex", providerAccountId: null },
    },
  ],
  complete: true,
} satisfies ProviderCommandBindingGroup;
/**
 * The registered `run.queueCreate` reply, for the cases that need a send to LAND.
 *
 * The router parses this response before reporting a send, so an unregistered shape
 * settles as a refusal and records nothing in the history these cases walk.
 */
export const QUEUE_CREATED: Readonly<Record<string, unknown>> = {
  queueItemId: "5e6f7a8b-9c0d-4e1f-8a2b-7c8d9e0f1a2b",
  state: "queued",
  createdAt: "2026-09-02T09:00:00.000Z",
};
export const registeredIds: string[] = [];

/**
 * The real fixture bridge with `answer` in front of `daemon.call`.
 *
 * The bridge family's own helper rather than a spread of this suite's: the replies,
 * the refusals, and the scenario clock are all the fixture's own, and `answer`
 * decides only whether a call is forwarded to them or held. The call door's
 * chokepoint gate is why it is not spread here — a test outside `bridge/` stands in
 * for a surface, and a surface goes through the door.
 */
export function composerBridgeAnswering(
  answer: (call: RecordedDaemonCall, forward: () => Promise<unknown>) => Promise<unknown>,
): ConsoleBridge {
  return bridgeAnswering(answer, COMPOSER_SCENARIO).bridge;
}

/** The fixture, with a note of what was asked. */
/** The fixture scenario, with the enumeration refused by the daemon's own code. */
export function refusingEnumerationBridge(): ConsoleBridge {
  return createFixtureBridge({
    scenario: {
      ...COMPOSER_SCENARIO,
      id: "composer-discovery-refusing",
      replies: [
        ...COMPOSER_SCENARIO.replies.filter((reply) => reply.call !== ENUMERATION_METHOD),
        {
          call: ENUMERATION_METHOD,
          refusal: {
            code: "driver.unavailable",
            message: "This agent holds no live binding, so there is nothing to enumerate.",
          },
        },
      ],
    },
  });
}

/** The fixture, with the enumeration held open so the read stays in flight. */
export function bridgeHoldingTheEnumeration(): ConsoleBridge {
  return composerBridgeAnswering((call, forward) =>
    call.method === ENUMERATION_METHOD ? new Promise<unknown>(() => undefined) : forward(),
  );
}

/**
 * The scenario's own enumerated groups, read through the registered method.
 *
 * The surface's own read path rather than a parser beside it: `settleEnumeration`
 * puts the scripted reply through `callDaemon`, which parses it against the shape
 * the registry binds to `driver.listProviderCommands`. So a fixture that has
 * drifted from the wire shape reaches these cases as a refusal — which this throws
 * on — rather than as an enumeration, and no suite outside `bridge/` holds a
 * schema. Asynchronous because a registered reply is reached by calling for it.
 */
export async function scenarioBindingGroups(): Promise<readonly ProviderCommandBindingGroup[]> {
  const bridge = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const [agentId] = composerAgentIds();
  if (agentId === undefined) {
    throw new Error("the composer scenario attaches no agent");
  }
  const state = await settleEnumeration(bridge, COMPOSER_SCENARIO.sessionId, agentId);
  if (state.phase !== "served") {
    throw new Error(`the composer scenario scripts no enumeration reply: ${state.phase}`);
  }
  return state.groups;
}

/** The run the scenario attributes its own Claude group to — the addressed one. */
export async function addressedRunIdOfFirstAgent(): Promise<
  NonNullable<ProviderCommandBindingGroup["runId"]>
> {
  const runId = (await scenarioBindingGroups())[0]?.runId;
  if (runId === null || runId === undefined) {
    throw new Error("the scenario's enumerated group names no run");
  }
  return runId;
}

/** The fixture scenario, answering the enumeration with exactly these groups. */
export function bridgeEnumerating(groups: readonly ProviderCommandBindingGroup[]): ConsoleBridge {
  return createFixtureBridge({
    scenario: {
      ...COMPOSER_SCENARIO,
      id: "composer-discovery-bindings",
      replies: [
        ...COMPOSER_SCENARIO.replies.filter((reply) => reply.call !== ENUMERATION_METHOD),
        { call: ENUMERATION_METHOD, result: { bindings: groups } },
      ],
    },
  });
}

/** The scenario's agents, read out of the log rather than restated. */
export function composerAgentIds(): readonly string[] {
  return COMPOSER_SCENARIO.beats
    .filter((beat) => beat.event.kind === "agent.attached")
    .map((beat) => beat.event.payload?.["agentId"])
    .filter((agentId): agentId is string => typeof agentId === "string");
}

export function composerSessionStore(): SessionStore {
  const store = new SessionStore({
    sessionId: COMPOSER_SCENARIO.sessionId,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  store.applyBatch(COMPOSER_SCENARIO.beats.map((beat) => beat.event as ConsoleSessionEvent));
  return store;
}

export function agentPane(agentId: string): ConsolePaneAddress {
  return { kind: "agent-console", entity: { kind: "agent", id: agentId } };
}

export interface MountedComposer {
  readonly container: HTMLElement;
  readonly line: HTMLTextAreaElement;
  readonly rerenderAt: (pane: ConsolePaneAddress) => Promise<void>;
}

export async function mountComposer(options: {
  readonly bridge: ConsoleBridge;
  readonly focusedPane: ConsolePaneAddress | undefined;
}): Promise<MountedComposer> {
  const sessionStore = composerSessionStore();
  const draftStore = new DraftStore();
  const route = { kind: "workspace", sessionId: COMPOSER_SCENARIO.sessionId } as const;
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      <MessageComposer
        sessionStore={sessionStore}
        bridge={options.bridge}
        draftStore={draftStore}
        route={route}
        focusedPane={options.focusedPane}
      />,
    );
    await Promise.resolve();
  });
  if (rendered === undefined) {
    throw new Error("the composer did not mount");
  }
  const mounted = rendered;
  const line = mounted.container.querySelector("textarea");
  if (!(line instanceof HTMLTextAreaElement)) {
    throw new Error("the composer rendered no message line to watch");
  }
  return {
    container: mounted.container,
    line,
    rerenderAt: async (pane) => {
      await act(async () => {
        mounted.rerender(
          <MessageComposer
            sessionStore={sessionStore}
            bridge={options.bridge}
            draftStore={draftStore}
            route={route}
            focusedPane={pane}
          />,
        );
        await Promise.resolve();
      });
    },
  };
}

export async function typeIntoLine(line: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.input(line, { target: { value: text } });
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function optionNames(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll('[role="option"] .meridian-command-discovery__name')].map(
    (element) => element.textContent ?? "",
  );
}

/**
 * Step focus into the open list, the way the line's own ArrowDown does.
 *
 * The list is where the activation keys are handled, so a case that fired them at the
 * textarea would be testing the line's key handling and not the listbox's.
 */
export async function stepIntoList(mounted: MountedComposer): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.keyDown(mounted.line, { key: "ArrowDown" });
    await Promise.resolve();
  });
  const list = mounted.container.querySelector('[role="listbox"]');
  if (!(list instanceof HTMLElement)) {
    throw new Error("the surface rendered no listbox");
  }
  return list;
}

/** Press one key on the focused list and let the act settle. */
export async function pressOnList(list: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(list, { key });
    await Promise.resolve();
  });
}

/** The row `aria-activedescendant` names, resolved through the document. */
export function activeRow(container: HTMLElement, list: HTMLElement): HTMLElement | null {
  const activeId = list.getAttribute("aria-activedescendant");
  return activeId === null ? null : container.querySelector(`#${CSS.escape(activeId)}`);
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    consoleCommands.unregister(commandId);
  }
});
