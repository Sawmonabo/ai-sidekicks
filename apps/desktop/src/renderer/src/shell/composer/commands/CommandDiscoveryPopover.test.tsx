// The popover itself: which entries reach the list, which row is active, and what a
// press on a row that cannot run is answered with.
//
// Split from the surface's own suite along the same seam the modules were: the
// surface decides WHETHER a popover is open and what a selection sends, and these
// cases are about what an open one renders and how it is moved through. Still driven
// through the whole composer, because that is where an open popover exists.

import {
  ProviderCommandListResultSchema,
  type ProviderCommandBindingGroup,
} from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";
import { consoleCommands } from "../../../console/frame/command-surface.js";
import {
  type MountedComposer,
  NOT_RUNNABLE_FRAGMENT,
  type RecordedCall,
  TEST_COMMAND_ID,
  UNADDRESSED_BINDING_SENTENCE,
  UNADDRESSED_CODEX_GROUP,
  UNADDRESSED_ENTRY_NAME,
  activeRow,
  addressedRunIdOfFirstAgent,
  agentPane,
  bridgeEnumerating,
  composerAgentIds,
  mountComposer,
  optionNames,
  pressOnList,
  recordingBridge,
  registeredIds,
  scenarioBindingGroups,
  stepIntoList,
  typeIntoLine,
} from "./provider-command-discovery.test-support.js";

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
