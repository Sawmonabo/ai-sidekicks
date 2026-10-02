// What a press on the popover does: a provider row runs nothing and a console row runs. Driven
// through the whole composer, because that is where an open popover exists.

import { describe, expect, it } from "vitest";
import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import {
  type MountedComposer,
  NOT_RUNNABLE_FRAGMENT,
  TEST_COMMAND_ID,
  activeRow,
  composerLeadAgentId,
  mountComposer,
  optionNames,
  pressOnList,
  registeredIds,
  stepIntoList,
  typeIntoLine,
} from "../command-list.test-support.js";
import { agentPane } from "../../composer.test-support.js";
import type { RecordedDaemonCall } from "@test/helpers/fixture-bridge.js";
import { recordingBridge } from "../provider-command-enumeration.test-support.js";

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
