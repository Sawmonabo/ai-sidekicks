// Shared scaffolding for the command list suites: one real composer over the real store, fed
// the composer scenario's beats through the registered run projectors, and the real fixture
// bridge with `answer` in front of `daemon.call`. One mount helper keeps "the composer" one
// answer across suites that drive the same composition.

import type { ProviderCommandBindingGroup, RunId } from "@ai-sidekicks/contracts";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach } from "vitest";
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { readRunId } from "@renderer/services/daemon/wire-identifiers.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { bridgeAnswering, type RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { WAITING_FOR_INPUT_SCENARIO } from "../../../../../../fixtures/scenarios/waiting-for-input.js";
import { scenarioLeadAgentId } from "../../../../../../fixtures/data/opening-entries.js";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { RUN_LIFECYCLE_PROJECTORS } from "@renderer/store/session-events/run-lifecycle-projector.js";
import { MAXIMUM_LIVE_DRAFT_COUNT } from "@renderer/store/persistence-caps.js";
import { DraftStore } from "@renderer/store/draft-store.js";
import { WindowStore } from "@renderer/store/window/window-store.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import { MessageComposer } from "../Composer.js";
import { composerDraftKey } from "../draft-line/draft-key.js";
import { settleEnumeration } from "./provider-command-read.js";
// One copy of the enumeration method string, shared with the holder suite.
import { ENUMERATION_METHOD } from "./provider-command-enumeration.test-support.js";

/** The id of the console command the suites register so the list has an act to offer. */
export const TEST_COMMAND_ID = "composer-discovery-test.act";
/** A prefix no console command and no enumerated provider entry begins with. */
export const UNMATCHED_PREFIX = "/zzz-nothing-begins-with-this";
/** The sentence the popover renders when no entry matches what was typed. */
export const EMPTY_STATE_SENTENCE = "No command matches what you have typed";
/** The opening of the sentence the popover renders when no group names this run. */
export const UNADDRESSED_BINDING_SENTENCE = "This run's binding published nothing here";
/** A fragment of the sentence a press on a non-executable row is answered with. */
export const NOT_RUNNABLE_FRAGMENT = "there is nothing here to run";
/** An entry name the scenario's own enumeration does not carry. */
export const UNADDRESSED_ENTRY_NAME = "status";
/**
 * The run identifier the wire admits, or a loud failure. A literal asserted into the brand
 * would let a group carry a value the wire would refuse; the bridge's own reader answers it.
 */
function fixtureRunId(value: string): RunId {
  const runId = readRunId(value);
  if (runId === undefined) {
    throw new Error(`this fixture names a run id the wire would refuse: ${value}`);
  }
  return runId;
}

/**
 * A live binding on the other provider, attributed to a run this composer never addresses:
 * the second group the agent-scoped reply can carry. Typed rather than parsed, so a member
 * the wire does not carry fails `typecheck` here.
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
/** Command ids a case registered; removed from the registry after each test. */
export const registeredIds: string[] = [];

/** A mounted composer and the handles a case drives it through. */
export interface MountedComposer {
  readonly container: HTMLElement;
  readonly line: HTMLTextAreaElement;
  readonly rerenderAt: (pane: PaneAddress) => Promise<void>;
  /** Write the session-addressed draft through the store, as a view elsewhere would. */
  readonly writeDraft: (text: string) => Promise<void>;
  /** Take the composer down, for the cases about what its teardown releases. */
  readonly unmount: () => void;
}

/**
 * The real fixture bridge with `answer` in front of `daemon.call`, deciding only whether a
 * call is forwarded to the fixture's own replies and clock or held. Not a spread of the
 * bridge: a view reaches the daemon only through `callDaemon`.
 */
export function composerBridgeAnswering(
  answer: (call: RecordedDaemonCall, forward: () => Promise<unknown>) => Promise<unknown>,
): PlatformBridge {
  return bridgeAnswering(answer, WAITING_FOR_INPUT_SCENARIO).bridge;
}

/** The fixture scenario, with the enumeration refused by the daemon's own code. */
export function refusingEnumerationBridge(): PlatformBridge {
  return createFixtureBridge({
    scenario: {
      ...WAITING_FOR_INPUT_SCENARIO,
      id: "composer-discovery-refusing",
      replies: [
        ...WAITING_FOR_INPUT_SCENARIO.replies.filter((reply) => reply.call !== ENUMERATION_METHOD),
        {
          call: ENUMERATION_METHOD,
          refusal: {
            code: "driver.unavailable",
            message: "This agent holds no live binding, so there is nothing to enumerate.",
          },
        },
      ],
    },
  }).bridge;
}

/** The fixture, with the enumeration held open so the read stays in flight. */
export function bridgeHoldingTheEnumeration(): PlatformBridge {
  return composerBridgeAnswering((call, forward) =>
    call.method === ENUMERATION_METHOD ? new Promise<unknown>(() => undefined) : forward(),
  );
}

/**
 * The scenario's own enumerated groups, read through the command list's own read path so a
 * fixture that drifted from the wire shape reaches these cases as a refusal, which this
 * throws on. Asynchronous because a registered reply is reached by calling for it.
 */
export async function scenarioBindingGroups(): Promise<readonly ProviderCommandBindingGroup[]> {
  const { bridge } = createFixtureBridge({ scenario: WAITING_FOR_INPUT_SCENARIO });
  const agentId = scenarioLeadAgentId(WAITING_FOR_INPUT_SCENARIO);
  // A bare controller nothing aborts: the helper awaits the read to completion and has no
  // owner who could leave.
  const liveLine = new AbortController();
  const state = await settleEnumeration(
    bridge,
    WAITING_FOR_INPUT_SCENARIO.sessionId,
    agentId,
    liveLine.signal,
  );
  if (state.phase !== "served") {
    throw new Error(`the composer scenario scripts no enumeration reply: ${state.phase}`);
  }
  return state.groups;
}

/** The run the scenario attributes its own Claude group to, which is the addressed one. */
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
export function bridgeEnumerating(groups: readonly ProviderCommandBindingGroup[]): PlatformBridge {
  return createFixtureBridge({
    scenario: {
      ...WAITING_FOR_INPUT_SCENARIO,
      id: "composer-discovery-bindings",
      replies: [
        ...WAITING_FOR_INPUT_SCENARIO.replies.filter((reply) => reply.call !== ENUMERATION_METHOD),
        { call: ENUMERATION_METHOD, result: { bindings: groups } },
      ],
    },
  }).bridge;
}

/** The scenario's lead, read out of the log rather than restated. */
export function composerLeadAgentId(): string {
  return scenarioLeadAgentId(WAITING_FOR_INPUT_SCENARIO);
}

/** A session store initialized with the composer scenario's beats. */
export function composerSessionStore(): SessionStore {
  const store = new SessionStore({
    sessionId: WAITING_FOR_INPUT_SCENARIO.sessionId,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialize({ cursor: 0, entities: [] });
  store.applyBatch(
    WAITING_FOR_INPUT_SCENARIO.beats.map((beat) => beat.event as ProjectedSessionEvent),
  );
  return store;
}

/** The pane address of one agent. */
export function agentPane(agentId: string): PaneAddress {
  return { kind: "agents", entity: { kind: "agent", id: agentId } };
}

/** Mount the real composer over the given bridge and return the handles a case needs. */
export async function mountComposer(options: {
  readonly bridge: PlatformBridge;
  readonly focusedPane: PaneAddress | undefined;
}): Promise<MountedComposer> {
  const sessionStore = composerSessionStore();
  const draftStore = new DraftStore({ maximumDraftCount: MAXIMUM_LIVE_DRAFT_COUNT });
  const frameStore = new WindowStore();
  const route = { kind: "session", sessionId: WAITING_FOR_INPUT_SCENARIO.sessionId } as const;
  let rendered: ReturnType<typeof render> | undefined;
  await act(async () => {
    rendered = render(
      <MessageComposer
        sessionStore={sessionStore}
        bridge={options.bridge}
        draftStore={draftStore}
        frameStore={frameStore}
        route={route}
        focusedPane={options.focusedPane}
      />,
    );
    await crossMacrotaskBoundary();
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
    unmount: (): void => {
      mounted.unmount();
    },
    writeDraft: async (text) => {
      await act(async () => {
        draftStore.write(
          composerDraftKey({ path: "session-message", sessionId: route.sessionId }),
          text,
        );
        await crossMacrotaskBoundary();
      });
    },
    rerenderAt: async (pane) => {
      await act(async () => {
        mounted.rerender(
          <MessageComposer
            sessionStore={sessionStore}
            bridge={options.bridge}
            draftStore={draftStore}
            frameStore={frameStore}
            route={route}
            focusedPane={pane}
          />,
        );
        await crossMacrotaskBoundary();
      });
    },
  };
}

/** Type text into the message line and let the input settle. */
export async function typeIntoLine(line: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.input(line, { target: { value: text } });
    await crossMacrotaskBoundary();
  });
}

/** The names of the rows the open list renders. */
export function optionNames(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll('[role="option"] .meridian-command-discovery__name')].map(
    (element) => element.textContent ?? "",
  );
}

/**
 * Step focus into the open list, the way the line's own ArrowDown does. Activation keys are
 * handled by the list, so firing them at the textarea would test the wrong handler.
 */
export async function stepIntoList(mounted: MountedComposer): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.keyDown(mounted.line, { key: "ArrowDown" });
    await crossMacrotaskBoundary();
  });
  const list = mounted.container.querySelector('[role="listbox"]');
  if (!(list instanceof HTMLElement)) {
    throw new Error("the command list rendered no listbox");
  }
  return list;
}

/** Press one key on the focused list and let the act settle. */
export async function pressOnList(list: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(list, { key });
    await crossMacrotaskBoundary();
  });
}

/** The row `aria-activedescendant` names, resolved through the document. */
export function activeRow(container: HTMLElement, list: HTMLElement): HTMLElement | null {
  const activeId = list.getAttribute("aria-activedescendant");
  return activeId === null ? null : container.querySelector(`#${CSS.escape(activeId)}`);
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    commandRegistry.unregister(commandId);
  }
});
