// The discovery surface, driven through the whole composer.
//
// Mounted as `MessageComposer` rather than as the popover alone, because the claim
// is about a composition: the surface watches a line it does not own, opens on what
// a person types into it, and writes nothing back. A test that rendered the popover
// over a textarea of its own would prove the popover works against a textarea and
// nothing about the composer.
//
// The store is the real one fed the composer scenario's own beats through the
// registered run projectors, so the address these cases resolve is the address the
// shipped surface resolves.

import {
  ProviderCommandListResultSchema,
  type ProviderCommandBindingGroup,
} from "@ai-sidekicks/contracts";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import {
  bridgeAnswering,
  type RecordedDaemonCall,
} from "../../../console/bridge/fixture-bridge.test-support.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import { consoleCommands } from "../../../console/frame/command-surface.js";
// Deep-imported for the reason `test/console/composer-surfaces.tsx` records: it is
// the registry the window's own composition root registers, and a second projector
// built here would project the run partition a second way.
import { RUN_LIFECYCLE_PROJECTORS } from "../../../console/frame/run-lifecycle-projector.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { MessageComposer } from "../../MessageComposer.js";

const TEST_COMMAND_ID = "composer-discovery-test.act";
const ENUMERATION_METHOD = "driver.listProviderCommands";
/** A prefix no console command and no enumerated provider entry begins with. */
const UNMATCHED_PREFIX = "/zzz-nothing-begins-with-this";
const EMPTY_STATE_SENTENCE = "No command matches what you have typed";
/** The opening of the sentence the popover renders when no group names this run. */
const UNADDRESSED_BINDING_SENTENCE = "This run's binding published nothing here";
/** A fragment of the sentence a press on a non-executable row is answered with. */
const NOT_RUNNABLE_FRAGMENT = "there is nothing here to run";
/** An entry name the scenario's own enumeration does not carry. */
const UNADDRESSED_ENTRY_NAME = "status";
/**
 * A live binding on the OTHER provider, attributed to a run this composer never
 * addresses — the second group the agent-scoped reply can carry.
 *
 * Built through the registered schema for the reason `scenarioBindingGroups` records
 * below: `runId` is a branded id, and a literal asserted into that brand would let a
 * group these cases treat as wire-shaped carry a value the wire would refuse.
 */
const UNADDRESSED_CODEX_GROUP: ProviderCommandBindingGroup = ProviderCommandListResultSchema.parse({
  bindings: [
    {
      runId: "019b7a11-1100-740e-8120-d1a4c1150312",
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
    },
  ],
}).bindings[0]!;
/**
 * The registered `run.queueCreate` reply, for the cases that need a send to LAND.
 *
 * The router parses this response before reporting a send, so an unregistered shape
 * settles as a refusal and records nothing in the history these cases walk.
 */
const QUEUE_CREATED: Readonly<Record<string, unknown>> = {
  queueItemId: "5e6f7a8b-9c0d-4e1f-8a2b-7c8d9e0f1a2b",
  state: "queued",
  createdAt: "2026-09-02T09:00:00.000Z",
};
const registeredIds: string[] = [];

/** One recorded daemon call, so a re-read is distinguishable from a re-filter. */
interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/**
 * The real fixture bridge with `answer` in front of `daemon.call`.
 *
 * The bridge family's own helper rather than a spread of this suite's: the replies,
 * the refusals, and the scenario clock are all the fixture's own, and `answer`
 * decides only whether a call is forwarded to them or held. The call door's
 * chokepoint gate is why it is not spread here — a test outside `bridge/` stands in
 * for a surface, and a surface goes through the door.
 */
function composerBridgeAnswering(
  answer: (call: RecordedDaemonCall, forward: () => Promise<unknown>) => Promise<unknown>,
): ConsoleBridge {
  return bridgeAnswering(answer, COMPOSER_SCENARIO).bridge;
}

/** The fixture, with a note of what was asked. */
function recordingBridge(recorded: RecordedCall[]): ConsoleBridge {
  return composerBridgeAnswering((call, forward) => {
    recorded.push({ method: call.method, params: call.params });
    return forward();
  });
}

/** The fixture scenario, with the enumeration refused by the daemon's own code. */
function refusingEnumerationBridge(): ConsoleBridge {
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
function bridgeHoldingTheEnumeration(): ConsoleBridge {
  return composerBridgeAnswering((call, forward) =>
    call.method === ENUMERATION_METHOD ? new Promise<unknown>(() => undefined) : forward(),
  );
}

/**
 * The scenario's own enumerated groups, read back through the registered schema.
 *
 * Parsed rather than cast: the scenario's reply is typed `unknown`, and a cast would
 * let a fixture that has drifted from the wire shape reach these cases as if it had
 * not.
 */
function scenarioBindingGroups(): readonly ProviderCommandBindingGroup[] {
  const reply = COMPOSER_SCENARIO.replies.find(
    (candidate) => candidate.call === ENUMERATION_METHOD,
  );
  if (reply === undefined || reply.result === undefined) {
    throw new Error("the composer scenario scripts no enumeration reply");
  }
  return ProviderCommandListResultSchema.parse(reply.result).bindings;
}

/** The run the scenario attributes its own Claude group to — the addressed one. */
function addressedRunIdOfFirstAgent(): NonNullable<ProviderCommandBindingGroup["runId"]> {
  const runId = scenarioBindingGroups()[0]?.runId;
  if (runId === null || runId === undefined) {
    throw new Error("the scenario's enumerated group names no run");
  }
  return runId;
}

/** The fixture scenario, answering the enumeration with exactly these groups. */
function bridgeEnumerating(groups: readonly ProviderCommandBindingGroup[]): ConsoleBridge {
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
function composerAgentIds(): readonly string[] {
  return COMPOSER_SCENARIO.beats
    .filter((beat) => beat.event.kind === "agent.attached")
    .map((beat) => beat.event.payload?.["agentId"])
    .filter((agentId): agentId is string => typeof agentId === "string");
}

function composerSessionStore(): SessionStore {
  const store = new SessionStore({
    sessionId: COMPOSER_SCENARIO.sessionId,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  store.applyBatch(COMPOSER_SCENARIO.beats.map((beat) => beat.event as ConsoleSessionEvent));
  return store;
}

function agentPane(agentId: string): ConsolePaneAddress {
  return { kind: "agent-console", entity: { kind: "agent", id: agentId } };
}

interface MountedComposer {
  readonly container: HTMLElement;
  readonly line: HTMLTextAreaElement;
  readonly rerenderAt: (pane: ConsolePaneAddress) => Promise<void>;
}

async function mountComposer(options: {
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

async function typeIntoLine(line: HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.input(line, { target: { value: text } });
    await Promise.resolve();
    await Promise.resolve();
  });
}

function optionNames(container: HTMLElement): readonly string[] {
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
async function stepIntoList(mounted: MountedComposer): Promise<HTMLElement> {
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
async function pressOnList(list: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(list, { key });
    await Promise.resolve();
  });
}

/** The row `aria-activedescendant` names, resolved through the document. */
function activeRow(container: HTMLElement, list: HTMLElement): HTMLElement | null {
  const activeId = list.getAttribute("aria-activedescendant");
  return activeId === null ? null : container.querySelector(`#${CSS.escape(activeId)}`);
}

afterEach(() => {
  for (const commandId of registeredIds.splice(0)) {
    consoleCommands.unregister(commandId);
  }
});

describe("ProviderCommandAutocomplete", () => {
  it("stays closed until a leading slash is typed", async () => {
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    expect(mounted.container.querySelector('[role="listbox"]')).toBeNull();

    await typeIntoLine(mounted.line, "/");

    expect(mounted.container.querySelector('[role="listbox"]')).not.toBeNull();
  });

  it("lists the addressed agent's enumerated commands and skills", async () => {
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    expect(optionNames(mounted.container)).toEqual(expect.arrayContaining(["compact", "review"]));
  });

  it("filters by the typed prefix", async () => {
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/rev");

    expect(optionNames(mounted.container)).toEqual(["review"]);
  });

  it("closes when the composer is re-addressed, because the line it watched is another draft", async () => {
    const recorded: RecordedCall[] = [];
    const mounted = await mountComposer({
      bridge: recordingBridge(recorded),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, "/");
    expect(optionNames(mounted.container)).toEqual(expect.arrayContaining(["compact"]));

    await mounted.rerenderAt({ kind: "timeline", entity: undefined });

    // The draft store is keyed by the composer's ADDRESS, so re-addressing does not
    // carry text under a target the person did not write it for — the line the
    // popover watches is empty again, and a discovery surface that outlived the
    // slash that opened it would be offering entries against a line that has none.
    // That the enumeration itself is discarded rather than filtered is
    // `provider-command-read.test.tsx`'s claim, where the read is driven directly.
    expect(mounted.line.value).toBe("");
    expect(mounted.container.querySelector(".meridian-command-discovery")).toBeNull();
  });

  it("says nobody was asked when the composer addresses no agent", async () => {
    const recorded: RecordedCall[] = [];
    const mounted = await mountComposer({
      bridge: recordingBridge(recorded),
      focusedPane: undefined,
    });

    await typeIntoLine(mounted.line, "/");

    expect(
      mounted.container.querySelector(
        ".meridian-command-discovery__state .meridian-nothing--not-checked",
      ),
    ).not.toBeNull();
    expect(recorded.filter((entry) => entry.method === "driver.listProviderCommands")).toHaveLength(
      0,
    );
  });

  it("renders a refused enumeration under the daemon's own code", async () => {
    const mounted = await mountComposer({
      bridge: refusingEnumerationBridge(),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    const refusal = mounted.container.querySelector(
      ".meridian-command-discovery__state .meridian-refusal",
    );
    expect(refusal?.textContent).toContain("driver.unavailable");
    expect(refusal?.textContent).toContain("no live binding");
  });

  it("waits for the enumeration before saying nothing matches", async () => {
    // The negative control is the assertion itself: the superseded branch rendered
    // the empty sentence the moment the filter came back empty, so it asserted a
    // finished search beside a line saying the provider half was still being read.
    const mounted = await mountComposer({
      bridge: bridgeHoldingTheEnumeration(),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);

    expect(
      mounted.container.querySelector(
        ".meridian-command-discovery__state .meridian-nothing--not-loaded",
      ),
    ).not.toBeNull();
    expect(mounted.container.textContent).not.toContain(EMPTY_STATE_SENTENCE);
  });

  it("says nothing matches once the enumeration has been served and matched nothing", async () => {
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);

    const empties = mounted.container.querySelectorAll(".meridian-nothing--empty");
    expect(empties).toHaveLength(1);
    expect(empties[0]?.textContent).toContain(EMPTY_STATE_SENTENCE);
  });

  it("renders a refused enumeration's own code instead of an empty result", async () => {
    const mounted = await mountComposer({
      bridge: refusingEnumerationBridge(),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);

    const refusal = mounted.container.querySelector(
      ".meridian-command-discovery__state .meridian-refusal",
    );
    expect(refusal?.textContent).toContain("driver.unavailable");
    expect(mounted.container.textContent).not.toContain(EMPTY_STATE_SENTENCE);
  });

  it("renders the console half beside the note that the provider half is still being read", async () => {
    consoleCommands.register({
      id: TEST_COMMAND_ID,
      title: "A console act",
      group: "Test",
      run: () => undefined,
    });
    registeredIds.push(TEST_COMMAND_ID);
    const mounted = await mountComposer({
      bridge: bridgeHoldingTheEnumeration(),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, `/${TEST_COMMAND_ID}`);

    expect(optionNames(mounted.container)).toEqual([TEST_COMMAND_ID]);
    expect(
      mounted.container.querySelector(
        ".meridian-command-discovery__state .meridian-nothing--not-loaded",
      ),
    ).not.toBeNull();
  });

  it("negative control: a provider entry offers no act, and nothing is dispatched", async () => {
    const recorded: RecordedCall[] = [];
    const mounted = await mountComposer({
      bridge: recordingBridge(recorded),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/compact");

    const rows = [...mounted.container.querySelectorAll('[role="option"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".meridian-command-discovery__run")).toBeNull();
    expect(recorded.map((entry) => entry.method)).not.toContain("run.queueCreate");
    expect(recorded.map((entry) => entry.method)).not.toContain("run.intervene");
  });

  it("offers the console's own act, and running it performs it", async () => {
    let ranCount = 0;
    consoleCommands.register({
      id: TEST_COMMAND_ID,
      title: "A console act",
      group: "Test",
      run: () => {
        ranCount += 1;
      },
    });
    registeredIds.push(TEST_COMMAND_ID);
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, `/${TEST_COMMAND_ID}`);
    const runButton = mounted.container.querySelector(".meridian-command-discovery__run");
    if (!(runButton instanceof HTMLButtonElement)) {
      throw new Error("a registered console command offered no act");
    }
    await act(async () => {
      fireEvent.click(runButton);
      await Promise.resolve();
    });

    expect(ranCount).toBe(1);
  });

  it("reads the command registry when the surface opens, not when the composer mounted", async () => {
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    // Registered AFTER the mount, exactly as the frame registers this window's own
    // commands: from an effect that runs once the tree is up.
    consoleCommands.register({
      id: TEST_COMMAND_ID,
      title: "A late console act",
      group: "Test",
      run: () => undefined,
    });
    registeredIds.push(TEST_COMMAND_ID);
    await typeIntoLine(mounted.line, `/${TEST_COMMAND_ID}`);

    expect(optionNames(mounted.container)).toEqual([TEST_COMMAND_ID]);
  });

  it("steps into the list on ArrowDown and moves the active option with the arrows", async () => {
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, "/");
    const list = mounted.container.querySelector('[role="listbox"]');
    if (!(list instanceof HTMLElement)) {
      throw new Error("the surface rendered no listbox");
    }
    const firstActive = list.getAttribute("aria-activedescendant");

    await act(async () => {
      fireEvent.keyDown(mounted.line, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(list);

    await act(async () => {
      fireEvent.keyDown(list, { key: "ArrowDown" });
      await Promise.resolve();
    });

    expect(list.getAttribute("aria-activedescendant")).not.toBe(firstActive);
    expect(list.querySelector('[role="option"][aria-selected="true"]')).not.toBeNull();
  });

  it("negative control: the literal-slash escape opens nothing", async () => {
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "//not a command");

    expect(mounted.container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("returns focus to the line when the list is dismissed from inside it", async () => {
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, "/");
    const list = mounted.container.querySelector('[role="listbox"]');
    if (!(list instanceof HTMLElement)) {
      throw new Error("the surface rendered no listbox");
    }
    await act(async () => {
      fireEvent.keyDown(mounted.line, { key: "ArrowDown" });
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.keyDown(list, { key: "Escape" });
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(mounted.line);
  });

  it("closes on Escape without touching what was typed", async () => {
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, "/rev");

    await act(async () => {
      fireEvent.keyDown(mounted.line, { key: "Escape" });
      await Promise.resolve();
    });

    expect(mounted.container.querySelector('[role="listbox"]')).toBeNull();
    expect(mounted.line.value).toBe("/rev");
  });
});

describe("ProviderCommandAutocomplete — one binding's entries reach the list", () => {
  it("lists the addressed run's group and none of the other binding's entries", async () => {
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([...scenarioBindingGroups(), UNADDRESSED_CODEX_GROUP]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    // The finding: the popover composed the catalog over EVERY group in the reply,
    // so a second live binding's commands appeared under this run's name — offering
    // a Codex entry through a Claude-bound agent, which is exactly the routing the
    // enumeration's own provenance pair exists to prevent.
    expect(optionNames(mounted.container)).toEqual(expect.arrayContaining(["compact", "review"]));
    expect(optionNames(mounted.container)).not.toContain(UNADDRESSED_ENTRY_NAME);
  });

  it("says this run's binding published nothing when no group can be attributed to it", async () => {
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([UNADDRESSED_CODEX_GROUP]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    const state = mounted.container.querySelector(
      ".meridian-command-discovery__state .meridian-nothing--empty",
    );
    expect(state?.textContent).toContain(UNADDRESSED_BINDING_SENTENCE);
    expect(optionNames(mounted.container)).not.toContain(UNADDRESSED_ENTRY_NAME);
  });

  it("negative control: that same group IS listed for the run it names", async () => {
    // Without this the two cases above would hold over a popover that had simply
    // stopped rendering provider entries. The group is unchanged; only the composer's
    // address moves, and the entries follow it.
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([
        { ...UNADDRESSED_CODEX_GROUP, runId: addressedRunIdOfFirstAgent() },
      ]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    expect(optionNames(mounted.container)).toContain(UNADDRESSED_ENTRY_NAME);
  });
});

describe("ProviderCommandAutocomplete — a cut enumeration is said, not treated as all of it", () => {
  /** The scenario's own addressed group, with the reply's cap flag as the case wants it. */
  function addressedGroupWith(
    overrides: Partial<ProviderCommandBindingGroup>,
  ): ProviderCommandBindingGroup {
    const group = scenarioBindingGroups()[0];
    if (group === undefined) {
      throw new Error("the composer scenario enumerates no addressed group");
    }
    return { ...group, ...overrides };
  }

  /**
   * The cut notice's text, or `undefined` where the surface rendered none.
   *
   * The console's one partial-read notice rather than a line this family draws: the
   * `cut` reading is what a producer that stopped short renders as, everywhere.
   */
  function truncationLine(container: HTMLElement): string | undefined {
    return container.querySelector(".meridian-partial-read__copy")?.textContent ?? undefined;
  }

  it("withholds the empty claim when the prefix matched nothing over a cut list", async () => {
    // The finding: `complete: false` means the provider published more entries than
    // the cap admits and this group's tail was dropped, so a prefix matching only a
    // dropped entry was answered "No command matches what you have typed" — a claim
    // about a search that never reached the entries it would have matched.
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([addressedGroupWith({ complete: false })]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);

    expect(mounted.container.textContent).not.toContain(EMPTY_STATE_SENTENCE);
    expect(truncationLine(mounted.container)).toContain(
      "read before this run's command list was cut",
    );
    // The count is the group's own served entries — the wire carries no figure for
    // what was dropped, and this surface invents none.
    expect(truncationLine(mounted.container)).toContain("2 ");
  });

  it("says the list was cut beside the entries it did carry", async () => {
    // A nonempty list off a cut enumeration looks exhaustive, which is the other
    // half of the same defect: the line renders whether the filter matched or not.
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([addressedGroupWith({ complete: false })]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    expect(optionNames(mounted.container)).toEqual(expect.arrayContaining(["compact", "review"]));
    expect(truncationLine(mounted.container)).toContain("may still exist");
  });

  it("negative control: a complete group says none of it and still answers the search", async () => {
    // Without this the cases above would hold over a popover that had stopped making
    // the empty claim at all, or that announced a truncation on every served read.
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([addressedGroupWith({ complete: true })]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);

    expect(mounted.container.textContent).toContain(EMPTY_STATE_SENTENCE);
    expect(truncationLine(mounted.container)).toBeUndefined();
  });
});

describe("ProviderCommandAutocomplete — the list activates its active row", () => {
  /** Registers the console act these cases activate, and counts what it ran. */
  function registerCountedConsoleCommand(): { runCount: () => number } {
    let ranCount = 0;
    consoleCommands.register({
      id: TEST_COMMAND_ID,
      title: "A console act",
      group: "Test",
      run: () => {
        ranCount += 1;
      },
    });
    registeredIds.push(TEST_COMMAND_ID);
    return { runCount: () => ranCount };
  }

  it("runs the active console row on Enter, exactly once", async () => {
    // The finding: the arrows moved `aria-activedescendant` and neither Enter nor
    // Space did anything, so a keyboard-only person could reach the console's own
    // act and never perform it.
    const counted = registerCountedConsoleCommand();
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, `/${TEST_COMMAND_ID}`);
    const list = await stepIntoList(mounted);

    await pressOnList(list, "Enter");

    expect(counted.runCount()).toBe(1);
  });

  it("runs it on Space too, through the same path", async () => {
    const counted = registerCountedConsoleCommand();
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, `/${TEST_COMMAND_ID}`);
    const list = await stepIntoList(mounted);

    await pressOnList(list, " ");

    expect(counted.runCount()).toBe(1);
  });

  it("answers a press on a provider row instead of running anything", async () => {
    const counted = registerCountedConsoleCommand();
    const recorded: RecordedCall[] = [];
    const mounted = await mountComposer({
      bridge: recordingBridge(recorded),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, "/");
    const list = await stepIntoList(mounted);
    // Console entries lead the catalog, so one step down lands on the first
    // provider row — and the assertion below reads which row that is off the
    // attribute rather than trusting the arithmetic.
    await pressOnList(list, "ArrowDown");
    expect(
      activeRow(mounted.container, list)?.querySelector(".meridian-command-discovery__run"),
    ).toBeNull();

    await pressOnList(list, "Enter");

    expect(counted.runCount()).toBe(0);
    expect(recorded.map((entry) => entry.method)).not.toContain("run.queueCreate");
    expect(
      mounted.container.querySelector(".meridian-command-discovery__notice")?.textContent,
    ).toContain(NOT_RUNNABLE_FRAGMENT);
  });

  it("negative control: the same key on the same list runs the console row beside it", async () => {
    // Without this the case above would hold over a listbox that had gone inert
    // again — the press must be a no-op BECAUSE of which row is active, not because
    // the key reaches nothing.
    const counted = registerCountedConsoleCommand();
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, "/");
    const list = await stepIntoList(mounted);
    await pressOnList(list, "ArrowDown");
    await pressOnList(list, "ArrowUp");

    await pressOnList(list, "Enter");

    expect(counted.runCount()).toBe(1);
    expect(mounted.container.querySelector(".meridian-command-discovery__notice")).toBeNull();
  });
});

describe("ProviderCommandAutocomplete — a declared disabled entry renders disabled", () => {
  /** The scenario entry whose `enabled: true` these cases flip. */
  const FLIPPED_ENTRY_NAME = "review";
  /** A fragment of the state the row says in its own words. */
  const UNAVAILABLE_FRAGMENT = "the provider published this entry as disabled";
  /** A fragment of the sentence a press on a disabled row is answered with. */
  const DISABLED_PRESS_FRAGMENT = "unavailable there as well as here";

  /**
   * The scenario's addressed group with one entry's `enabled` set as the case wants.
   *
   * Through the registered schema rather than by assembling a literal: the flag is a
   * wire member, and a group these cases treat as enumerated must be one the wire
   * would have produced.
   */
  function addressedGroupWithFlag(enabled: boolean): ProviderCommandBindingGroup {
    const group = scenarioBindingGroups()[0];
    if (group === undefined) {
      throw new Error("the composer scenario enumerates no addressed group");
    }
    return ProviderCommandListResultSchema.parse({
      bindings: [
        {
          ...group,
          entries: group.entries.map((entry) =>
            entry.name === FLIPPED_ENTRY_NAME ? { ...entry, enabled } : entry,
          ),
        },
      ],
    }).bindings[0]!;
  }

  /** The composer over that group, filtered to the one entry by its exact name. */
  async function mountFilteredToFlippedEntry(enabled: boolean): Promise<MountedComposer> {
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([addressedGroupWithFlag(enabled)]),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, `/${FLIPPED_ENTRY_NAME}`);
    return mounted;
  }

  /** The one row that prefix leaves in the list. */
  function soleRow(mounted: MountedComposer): HTMLElement {
    const row = mounted.container.querySelector('[role="option"]');
    if (!(row instanceof HTMLElement)) {
      throw new Error("the surface rendered no row for the enumerated entry");
    }
    return row;
  }

  /** What the surface answered the last press with. */
  function pressNotice(mounted: MountedComposer): string | undefined {
    return (
      mounted.container.querySelector(".meridian-command-discovery__notice")?.textContent ??
      undefined
    );
  }

  it("marks the row the provider declared unavailable", async () => {
    // The finding: `enabled: false` is returned precisely so a client can tell a
    // disabled command from one that does not exist, and the row rendered it exactly
    // like an available or unqualified entry — so the surface told a person the entry
    // was among what the provider offers with no unavailable state anywhere on it.
    const row = soleRow(await mountFilteredToFlippedEntry(false));

    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.classList.contains("meridian-command-discovery__row--unavailable")).toBe(true);
    expect(
      row.querySelector(".meridian-command-discovery__unavailable")?.textContent?.toLowerCase(),
    ).toContain(UNAVAILABLE_FRAGMENT);
  });

  it("negative control: the same entry declared available carries none of it", async () => {
    // Without this the case above would hold over a row that marked every provider
    // entry — and an absent flag means the provider draws no such distinction, which
    // is not a disabled state either.
    const row = soleRow(await mountFilteredToFlippedEntry(true));

    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(row.classList.contains("meridian-command-discovery__row--unavailable")).toBe(false);
    expect(row.querySelector(".meridian-command-discovery__unavailable")).toBeNull();
  });

  it("answers a press on it with the declared state rather than the standing rule", async () => {
    // Not selectable for a send in either case — no provider entry is — but a person
    // who reached this one is owed the reading the reply carried: it is disabled
    // where it lives, which stays true wherever they try it next.
    const mounted = await mountFilteredToFlippedEntry(false);
    const list = await stepIntoList(mounted);

    await pressOnList(list, "Enter");

    expect(pressNotice(mounted)).toContain(DISABLED_PRESS_FRAGMENT);
  });

  it("negative control: the available entry answers the standing rule instead", async () => {
    // Without this the case above would hold over a surface that had replaced the
    // one sentence with the other for every provider row.
    const mounted = await mountFilteredToFlippedEntry(true);
    const list = await stepIntoList(mounted);

    await pressOnList(list, "Enter");

    expect(pressNotice(mounted)).toContain(NOT_RUNNABLE_FRAGMENT);
    expect(pressNotice(mounted)).not.toContain(DISABLED_PRESS_FRAGMENT);
  });
});

describe("ProviderCommandAutocomplete — the surface follows every write to the draft", () => {
  /** Whether the discovery popover is on screen at all. */
  function isPopoverOpen(container: HTMLElement): boolean {
    return container.querySelector(".meridian-command-discovery") !== null;
  }

  /** Send whatever is in the line, the way the keyboard does. */
  async function pressEnter(line: HTMLTextAreaElement): Promise<void> {
    await act(async () => {
      fireEvent.keyDown(line, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /** Walk the history one step, from the caret edge that arm recalls at. */
  async function pressRecall(
    line: HTMLTextAreaElement,
    key: "ArrowUp" | "ArrowDown",
  ): Promise<void> {
    const edge = key === "ArrowUp" ? 0 : line.value.length;
    line.setSelectionRange(edge, edge);
    await act(async () => {
      fireEvent.keyDown(line, { key });
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /**
   * A channel-addressed composer, so an ordinary send settles into the history.
   *
   * The scenario scripts no `run.queueCreate`, and an unscripted call is a fixture
   * rejection — which refuses the send and records nothing, leaving the walk below
   * with no history to walk. So this one answers that call and forwards the rest.
   * The answer is the REGISTERED response: the router parses the reply before
   * reporting a send, so a bare `{}` refuses as unreadable and records no history
   * either.
   */
  async function mountWithHistory(): Promise<MountedComposer> {
    const mounted = await mountComposer({
      bridge: composerBridgeAnswering(async (call, forward) =>
        call.method === "run.queueCreate" ? QUEUE_CREATED : await forward(),
      ),
      focusedPane: undefined,
    });
    fireEvent.input(mounted.line, { target: { value: "ship the parser fix" } });
    await pressEnter(mounted.line);
    return mounted;
  }

  it("closes when a history recall replaces the line with ordinary text", async () => {
    // The finding: this surface subscribed to the line's native `input` event, which
    // fires for typing and for nothing else. A recall writes through the draft store,
    // so the popover stood open over a line that had stopped being a command.
    const mounted = await mountWithHistory();
    await typeIntoLine(mounted.line, `/${UNMATCHED_PREFIX.slice(1)}`);
    expect(isPopoverOpen(mounted.container)).toBe(true);

    await pressRecall(mounted.line, "ArrowUp");

    expect(mounted.line.value).toBe("ship the parser fix");
    expect(isPopoverOpen(mounted.container)).toBe(false);
  });

  it("opens again when the recall walks back to the slash line it stashed", async () => {
    // The other direction of the same defect: the walk hands the command line back
    // and the list has to come with it, or the person is typing into a filter
    // nothing is showing them.
    const mounted = await mountWithHistory();
    await typeIntoLine(mounted.line, `/${UNMATCHED_PREFIX.slice(1)}`);
    await pressRecall(mounted.line, "ArrowUp");
    expect(isPopoverOpen(mounted.container)).toBe(false);

    await pressRecall(mounted.line, "ArrowDown");

    expect(mounted.line.value).toBe(UNMATCHED_PREFIX);
    expect(isPopoverOpen(mounted.container)).toBe(true);
  });

  it("closes when a registered command is sent by clicking Send", async () => {
    // The third path: the router intercepts the line, the executor runs it, and the
    // controller clears the draft — all without a keystroke in the textarea, so the
    // popover used to stand over an empty line offering the command that had just
    // run.
    let ranCount = 0;
    consoleCommands.register({
      id: TEST_COMMAND_ID,
      title: "A console act",
      group: "Test",
      run: () => {
        ranCount += 1;
      },
    });
    registeredIds.push(TEST_COMMAND_ID);
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: undefined,
    });
    await typeIntoLine(mounted.line, `/${TEST_COMMAND_ID}`);
    expect(isPopoverOpen(mounted.container)).toBe(true);

    const send = mounted.container.querySelector(".meridian-composer__primary");
    if (!(send instanceof HTMLButtonElement)) {
      throw new Error("the composer rendered no send control");
    }
    await act(async () => {
      fireEvent.click(send);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ranCount).toBe(1);
    expect(mounted.line.value).toBe("");
    expect(isPopoverOpen(mounted.container)).toBe(false);
  });

  it("negative control: typing still opens and closes it", async () => {
    // Without this the three cases above would hold over a hook that had stopped
    // reading the line altogether, which closes the popover for good.
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: undefined,
    });

    await typeIntoLine(mounted.line, "/");
    expect(isPopoverOpen(mounted.container)).toBe(true);

    await typeIntoLine(mounted.line, "ordinary prose");
    expect(isPopoverOpen(mounted.container)).toBe(false);
  });
});
