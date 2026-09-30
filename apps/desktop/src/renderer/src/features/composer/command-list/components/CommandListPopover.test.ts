// The popover itself: which entries reach the list, which row is active, and what a press on a
// row that cannot run is answered with. Driven through the whole composer, because that is where
// an open popover exists.

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import {
  type MountedComposer,
  NOT_RUNNABLE_FRAGMENT,
  TEST_COMMAND_ID,
  UNADDRESSED_BINDING_SENTENCE,
  UNADDRESSED_CODEX_GROUP,
  UNADDRESSED_ENTRY_NAME,
  activeRow,
  addressedRunIdOfFirstAgent,
  agentPane,
  bridgeEnumerating,
  composerLeadAgentId,
  mountComposer,
  optionNames,
  pressOnList,
  registeredIds,
  scenarioBindingGroups,
  stepIntoList,
  typeIntoLine,
} from "../command-list.test-support.js";
import type { RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import { recordingBridge } from "../provider-command-enumeration.test-support.js";

describe("CommandList — one binding's entries reach the list", () => {
  it("lists the addressed run's group and none of the other binding's entries", async () => {
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([...(await scenarioBindingGroups()), UNADDRESSED_CODEX_GROUP]),
      focusedPane: agentPane(composerLeadAgentId()),
    });

    await typeIntoLine(mounted.line, "/");

    expect(optionNames(mounted.container)).toEqual(expect.arrayContaining(["compact", "review"]));
    expect(optionNames(mounted.container)).not.toContain(UNADDRESSED_ENTRY_NAME);
  });

  it("says this run's binding published nothing when no group can be attributed to it", async () => {
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([UNADDRESSED_CODEX_GROUP]),
      focusedPane: agentPane(composerLeadAgentId()),
    });

    await typeIntoLine(mounted.line, "/");

    const state = mounted.container.querySelector(
      ".meridian-command-discovery__state .meridian-nothing--empty",
    );
    expect(state?.textContent).toContain(UNADDRESSED_BINDING_SENTENCE);
    expect(optionNames(mounted.container)).not.toContain(UNADDRESSED_ENTRY_NAME);
  });

  it("negative control: that same group IS listed for the run it names", async () => {
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([
        { ...UNADDRESSED_CODEX_GROUP, runId: await addressedRunIdOfFirstAgent() },
      ]),
      focusedPane: agentPane(composerLeadAgentId()),
    });

    await typeIntoLine(mounted.line, "/");

    expect(optionNames(mounted.container)).toContain(UNADDRESSED_ENTRY_NAME);
  });
});

describe("CommandList — the list activates its active row", () => {
  function registerCountedConsoleCommand(): { runCount: () => number } {
    let ranCount = 0;
    commandRegistry.register({
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
    const counted = registerCountedConsoleCommand();
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerLeadAgentId()),
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
      focusedPane: agentPane(composerLeadAgentId()),
    });
    await typeIntoLine(mounted.line, `/${TEST_COMMAND_ID}`);
    const list = await stepIntoList(mounted);

    await pressOnList(list, " ");

    expect(counted.runCount()).toBe(1);
  });

  it("answers a press on a provider row instead of running anything", async () => {
    const counted = registerCountedConsoleCommand();
    const recorded: RecordedDaemonCall[] = [];
    const mounted = await mountComposer({
      bridge: recordingBridge(recorded),
      focusedPane: agentPane(composerLeadAgentId()),
    });
    await typeIntoLine(mounted.line, "/");
    const list = await stepIntoList(mounted);
    // Console entries lead the catalog and their number grows with the palette, so step until the
    // active row lacks the run affordance rather than counting.
    await stepToFirstUnrunnableRow(mounted, list);
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
    const counted = registerCountedConsoleCommand();
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerLeadAgentId()),
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

describe("CommandList — a declared disabled entry renders disabled", () => {
  /** The scenario entry whose `enabled: true` these cases flip. */
  const FLIPPED_ENTRY_NAME = "review";
  const UNAVAILABLE_FRAGMENT = "the provider published this entry as disabled";
  const DISABLED_PRESS_FRAGMENT = "unavailable there as well as here";

  /**
   * The scenario's addressed group with one entry's `enabled` set. Not re-parsed: the flag is a
   * wire member on a shape `callDaemon` already checked.
   */
  async function addressedGroupWithFlag(enabled: boolean): Promise<ProviderCommandBindingGroup> {
    const group = (await scenarioBindingGroups())[0];
    if (group === undefined) {
      throw new Error("the composer scenario enumerates no addressed group");
    }
    return {
      ...group,
      entries: group.entries.map((entry) =>
        entry.name === FLIPPED_ENTRY_NAME ? { ...entry, enabled } : entry,
      ),
    } satisfies ProviderCommandBindingGroup;
  }

  async function mountFilteredToFlippedEntry(enabled: boolean): Promise<MountedComposer> {
    const mounted = await mountComposer({
      bridge: bridgeEnumerating([await addressedGroupWithFlag(enabled)]),
      focusedPane: agentPane(composerLeadAgentId()),
    });
    await typeIntoLine(mounted.line, `/${FLIPPED_ENTRY_NAME}`);
    return mounted;
  }

  function soleRow(mounted: MountedComposer): HTMLElement {
    const row = mounted.container.querySelector('[role="option"]');
    if (!(row instanceof HTMLElement)) {
      throw new Error("the popover rendered no row for the enumerated entry");
    }
    return row;
  }

  function pressNotice(mounted: MountedComposer): string | undefined {
    return (
      mounted.container.querySelector(".meridian-command-discovery__notice")?.textContent ??
      undefined
    );
  }

  it("marks the row the provider declared unavailable", async () => {
    const row = soleRow(await mountFilteredToFlippedEntry(false));

    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.classList.contains("meridian-command-discovery__row--unavailable")).toBe(true);
    expect(
      row.querySelector(".meridian-command-discovery__unavailable")?.textContent?.toLowerCase(),
    ).toContain(UNAVAILABLE_FRAGMENT);
  });

  it("negative control: the same entry declared available carries none of it", async () => {
    const row = soleRow(await mountFilteredToFlippedEntry(true));

    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(row.classList.contains("meridian-command-discovery__row--unavailable")).toBe(false);
    expect(row.querySelector(".meridian-command-discovery__unavailable")).toBeNull();
  });

  it("answers a press on it with the declared state rather than the standing rule", async () => {
    const mounted = await mountFilteredToFlippedEntry(false);
    const list = await stepIntoList(mounted);

    await pressOnList(list, "Enter");

    expect(pressNotice(mounted)).toContain(DISABLED_PRESS_FRAGMENT);
  });

  it("negative control: the available entry answers the standing rule instead", async () => {
    const mounted = await mountFilteredToFlippedEntry(true);
    const list = await stepIntoList(mounted);

    await pressOnList(list, "Enter");

    expect(pressNotice(mounted)).toContain(NOT_RUNNABLE_FRAGMENT);
    expect(pressNotice(mounted)).not.toContain(DISABLED_PRESS_FRAGMENT);
  });
});

/**
 * Steps the active row to the first entry without the run affordance, which identifies a provider
 * row. Bounded by the option count so a list of only runnable rows fails instead of looping.
 */
async function stepToFirstUnrunnableRow(
  mounted: MountedComposer,
  list: HTMLElement,
): Promise<void> {
  const optionCount = optionNames(mounted.container).length;
  for (let step = 0; step < optionCount; step += 1) {
    const row = activeRow(mounted.container, list);
    if (row !== null && row.querySelector(".meridian-command-discovery__run") === null) {
      return;
    }
    await pressOnList(list, "ArrowDown");
  }
  throw new Error("every row in this list can run, so no provider row was reached");
}
