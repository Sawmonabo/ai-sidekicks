// What the popover draws and what a press on it does: a closed console command is not drawn, a
// provider row runs nothing, a console row runs, and a row the provider declared disabled takes
// neither the cursor nor a press. Driven through the whole composer, because that is where an
// open popover exists.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { commandRegistry } from "#renderer/registries/commands/registry.js";
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
} from "./CommandListPopover.test-support.js";
import { agentPane } from "../../Composer.test-support.js";
import { bridgeAnswering, type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { WAITING_FOR_INPUT_SCENARIO } from "#fixtures/scenarios/waiting-for-input.js";
import { recordingBridge } from "../provider/enumeration.test-support.js";

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
    // active row is a provider's rather than counting.
    await stepToFirstProviderRow(mounted, list);

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

describe("CommandList — a row that cannot act", () => {
  it("is stepped over by the keys and ignores a press, while the row before it takes both", async () => {
    // The scenario's provider rows are `compact` then `review`; `review` comes back disabled.
    const { bridge } = bridgeAnswering(async (call, passThrough) => {
      const reply = await passThrough();
      return call.method === "driver.listProviderCommands" ? withReviewDisabled(reply) : reply;
    }, WAITING_FOR_INPUT_SCENARIO);
    const mounted = await mountComposer({
      bridge,
      focusedPane: agentPane(composerLeadAgentId()),
    });
    await typeIntoLine(mounted.line, "/");
    const list = await stepIntoList(mounted);
    await stepToFirstProviderRow(mounted, list);
    const rowNamed = (name: string): HTMLElement => {
      const row = [...mounted.container.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.querySelector(".meridian-command-discovery__name")?.textContent === name,
      );
      if (row === undefined) {
        throw new Error(`the list drew no ${name} row`);
      }
      return row;
    };
    expect(activeRow(mounted.container, list)).toBe(rowNamed("compact"));
    expect(rowNamed("review").getAttribute("aria-disabled")).toBe("true");

    await pressOnList(list, "ArrowDown");
    expect(activeRow(mounted.container, list)).toBe(rowNamed("compact"));
    await pressOnList(list, "End");
    expect(activeRow(mounted.container, list)).toBe(rowNamed("compact"));

    await act(async () => {
      fireEvent.mouseDown(rowNamed("review"));
      fireEvent.click(rowNamed("review"));
      await crossMacrotaskBoundary();
    });
    expect(activeRow(mounted.container, list)).toBe(rowNamed("compact"));
    expect(mounted.container.querySelector(".meridian-command-discovery__notice")).toBeNull();

    await act(async () => {
      fireEvent.click(rowNamed("compact"));
      await crossMacrotaskBoundary();
    });
    expect(
      mounted.container.querySelector(".meridian-command-discovery__notice")?.textContent,
    ).toContain(NOT_RUNNABLE_FRAGMENT);
  });
});

describe("CommandList — only what runs here is drawn", () => {
  it("leaves a closed command out of the list and keeps an open one", async () => {
    const closedCommandId = `${TEST_COMMAND_ID}.closed`;
    for (const [commandId, unavailable] of [
      [TEST_COMMAND_ID, undefined],
      [closedCommandId, "Closed while the test runs"],
    ] as const) {
      commandRegistry.register({
        id: commandId,
        title: "A console act",
        group: "Test",
        run: () => undefined,
        ...(unavailable === undefined ? {} : { unavailable }),
      });
      registeredIds.push(commandId);
    }
    const mounted = await mountComposer({
      bridge: recordingBridge([]),
      focusedPane: agentPane(composerLeadAgentId()),
    });

    await typeIntoLine(mounted.line, "/");

    expect(optionNames(mounted.container)).toContain(TEST_COMMAND_ID);
    expect(optionNames(mounted.container)).not.toContain(closedCommandId);
  });
});

/** The scenario's enumeration reply with its `review` entry declared disabled. */
function withReviewDisabled(reply: unknown): unknown {
  const served = reply as {
    readonly bindings: readonly { readonly entries: readonly { readonly name: string }[] }[];
  };
  return {
    ...served,
    bindings: served.bindings.map((binding) => ({
      ...binding,
      entries: binding.entries.map((entry) =>
        entry.name === "review" ? { ...entry, enabled: false } : entry,
      ),
    })),
  };
}

/**
 * Steps the active row to the first provider entry, the one kind of row that names its provider
 * binding. Bounded by the option count so a list of only console rows fails instead of looping.
 */
async function stepToFirstProviderRow(mounted: MountedComposer, list: HTMLElement): Promise<void> {
  const optionCount = optionNames(mounted.container).length;
  for (let step = 0; step < optionCount; step += 1) {
    const row = activeRow(mounted.container, list);
    if (row !== null && row.querySelector(".meridian-command-discovery__binding") !== null) {
      return;
    }
    await pressOnList(list, "ArrowDown");
  }
  throw new Error("every row in this list is a console row, so no provider row was reached");
}
