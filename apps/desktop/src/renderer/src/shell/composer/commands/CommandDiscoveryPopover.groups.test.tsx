// The discovery list is two labelled groups, and the cursor still walks one sequence.
//
// Its own suite rather than more cases in the popover's: those are about WHICH entries
// reach the list and what a press answers with, and these are about the sectioning
// drawn over them — which has its own failure, a group that renumbers the rows and
// leaves the announced row and the activated row disagreeing.

import { describe, expect, it } from "vitest";

import { consoleCommands } from "../../../console/palette/index.js";
import {
  activeRow,
  agentPane,
  bridgeEnumerating,
  composerAgentIds,
  mountComposer,
  optionNames,
  pressOnList,
  registeredIds,
  scenarioBindingGroups,
  stepIntoList,
  typeIntoLine,
} from "./provider-command-discovery.test-support.js";

/** The console act these cases list beside the provider's own entries. */
const GROUPED_COMMAND_ID = "composer-discovery-groups.act";

/** Register one console command, so both groups have something in them. */
function registerConsoleCommand(): void {
  consoleCommands.register({
    id: GROUPED_COMMAND_ID,
    title: "A console act",
    group: "Test",
    run: () => undefined,
  });
  registeredIds.push(GROUPED_COMMAND_ID);
}

/** Every group in the open list, with the label it is announced under. */
function groupLabels(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll('[role="listbox"] [role="group"]')].map((group) => {
    const labelId = group.getAttribute("aria-labelledby");
    const label = labelId === null ? null : container.querySelector(`#${CSS.escape(labelId)}`);
    return label?.textContent ?? "";
  });
}

/** The names under one group, in the order the group renders them. */
function namesUnderGroup(container: HTMLElement, labelText: string): readonly string[] {
  const group = [...container.querySelectorAll('[role="listbox"] [role="group"]')].find(
    (candidate) => {
      const labelId = candidate.getAttribute("aria-labelledby");
      const label = labelId === null ? null : container.querySelector(`#${CSS.escape(labelId)}`);
      return label?.textContent === labelText;
    },
  );
  if (group === null || group === undefined) {
    return [];
  }
  return [...group.querySelectorAll('[role="option"] .meridian-command-discovery__name')].map(
    (element) => element.textContent ?? "",
  );
}

const PROVIDER_GROUP_LABEL = "Discovery, not runnable";
const CONSOLE_GROUP_LABEL = "This console's commands — these run here";

describe("CommandDiscoveryPopover — the list is two labelled groups", () => {
  it("names the provider half 'discovery, not runnable' and the console half its own", async () => {
    registerConsoleCommand();
    const mounted = await mountComposer({
      bridge: bridgeEnumerating(await scenarioBindingGroups()),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    // The defect this closes: one flat run left the difference between an act this
    // window performs and a name it will not send to be inferred from which rows
    // happen to carry a button — a reading only available after a press.
    expect(groupLabels(mounted.container)).toEqual([CONSOLE_GROUP_LABEL, PROVIDER_GROUP_LABEL]);
  });

  it("puts each entry under the group its source names, and never under both", async () => {
    registerConsoleCommand();
    const mounted = await mountComposer({
      bridge: bridgeEnumerating(await scenarioBindingGroups()),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");

    const consoleNames = namesUnderGroup(mounted.container, CONSOLE_GROUP_LABEL);
    const providerNames = namesUnderGroup(mounted.container, PROVIDER_GROUP_LABEL);
    expect(consoleNames).toContain(GROUPED_COMMAND_ID);
    expect(providerNames).toEqual(expect.arrayContaining(["compact", "review"]));
    expect(providerNames).not.toContain(GROUPED_COMMAND_ID);
    // Grouping partitions and never filters: every option on screen is in exactly one
    // of the two, so the two halves add back up to the whole list.
    expect([...consoleNames, ...providerNames].sort()).toEqual(
      [...optionNames(mounted.container)].sort(),
    );
  });

  it("draws no group over an empty half", async () => {
    // No console command is registered here, so the console half has nothing in it —
    // and a labelled section with no rows would assert a category the filtered
    // catalog does not have.
    const mounted = await mountComposer({
      bridge: bridgeEnumerating(await scenarioBindingGroups()),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/zzz-nothing-begins-with-this");

    expect(groupLabels(mounted.container)).toEqual([]);
  });

  it("keeps one cursor across both groups, so the named row is the activated one", async () => {
    registerConsoleCommand();
    const mounted = await mountComposer({
      bridge: bridgeEnumerating(await scenarioBindingGroups()),
      focusedPane: agentPane(composerAgentIds()[0]!),
    });

    await typeIntoLine(mounted.line, "/");
    const list = await stepIntoList(mounted);
    const names = optionNames(mounted.container);

    // Walking to the last row crosses the group boundary. A group counting from zero
    // would light a row in its own half while `aria-activedescendant` named another.
    for (let step = 1; step < names.length; step += 1) {
      await pressOnList(list, "ArrowDown");
    }

    const active = activeRow(mounted.container, list);
    expect(active?.getAttribute("role")).toBe("option");
    expect(active?.querySelector(".meridian-command-discovery__name")?.textContent).toBe(
      names[names.length - 1],
    );
    expect(active?.closest('[role="group"]')).not.toBeNull();
  });
});
