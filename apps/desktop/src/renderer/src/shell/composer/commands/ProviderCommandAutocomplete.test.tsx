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

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createFixtureBridge, type ConsoleBridge } from "../../../console/bridge/index.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import { consoleCommands } from "../../../console/frame/command-surface.js";
// Deep-imported for the reason `test/console/composer-surfaces.tsx` records: it is
// the registry the window's own composition root registers, and a second projector
// built here would project the run partition a second way.
import { RUN_LIFECYCLE_PROJECTORS } from "../../../console/frame/run-lifecycle-projector.js";
import { DraftStore } from "../../../console/persistence/index.js";
import { SessionStore, type ConsoleSessionEvent } from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/workspace/index.js";
import { MessageComposer } from "../../MessageComposer.js";

const TEST_COMMAND_ID = "composer-discovery-test.act";
const registeredIds: string[] = [];

/** One recorded daemon call, so a re-read is distinguishable from a re-filter. */
interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/**
 * The real fixture bridge with a recorder in front of `daemon.call`.
 *
 * A wrapper rather than a stand-in bridge: the replies, the refusals, and the
 * scenario clock are all the fixture's own, and the only thing added is a note of
 * what was asked.
 */
function recordingBridge(recorded: RecordedCall[]): ConsoleBridge {
  const base = createFixtureBridge({ scenario: COMPOSER_SCENARIO });
  const call = base.sidekicks.daemon.call as (method: string, params: unknown) => Promise<unknown>;
  return {
    ...base,
    sidekicks: {
      ...base.sidekicks,
      daemon: {
        ...base.sidekicks.daemon,
        call: ((method: string, params: unknown) => {
          recorded.push({ method, params });
          return call(method, params);
        }) as typeof base.sidekicks.daemon.call,
      },
    },
  };
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

  it("discards the enumeration when the composer is re-addressed away from the agent", async () => {
    const recorded: RecordedCall[] = [];
    const mounted = await mountComposer({
      bridge: recordingBridge(recorded),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });
    await typeIntoLine(mounted.line, "/");
    expect(optionNames(mounted.container)).toEqual(expect.arrayContaining(["compact"]));

    await mounted.rerenderAt({ kind: "timeline", entity: undefined });

    // Discarded, not filtered: the previous binding's entries are gone and the
    // surface says nobody was asked rather than showing a list nothing addresses.
    expect(optionNames(mounted.container)).not.toContain("compact");
    expect(
      mounted.container.querySelector(
        ".meridian-command-discovery__state .meridian-nothing--not-checked",
      ),
    ).not.toBeNull();
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
    const refusingBridge = createFixtureBridge({
      scenario: {
        ...COMPOSER_SCENARIO,
        id: "composer-discovery-refusing",
        replies: [
          ...COMPOSER_SCENARIO.replies.filter(
            (reply) => reply.call !== "driver.listProviderCommands",
          ),
          {
            call: "driver.listProviderCommands",
            refusal: {
              code: "driver.unavailable",
              message: "This agent holds no live binding, so there is nothing to enumerate.",
            },
          },
        ],
      },
    });
    const mounted = await mountComposer({
      bridge: refusingBridge,
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    const refusal = mounted.container.querySelector(
      ".meridian-command-discovery__state .meridian-refusal",
    );
    expect(refusal?.textContent).toContain("driver.unavailable");
    expect(refusal?.textContent).toContain("no live binding");
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
