// The discovery surface, driven through the whole composer: when it opens, what it
// offers, and what a selection does to the line.
//
// Mounted as `MessageComposer` rather than as the popover alone, because the claim
// is about a composition. A test that rendered the popover over a textarea of its
// own would prove the popover works against a textarea and nothing about the
// composer.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { consoleCommands } from "../../../console/frame/command-surface.js";
import {
  EMPTY_STATE_SENTENCE,
  type RecordedCall,
  TEST_COMMAND_ID,
  UNMATCHED_PREFIX,
  agentPane,
  bridgeHoldingTheEnumeration,
  composerAgentIds,
  mountComposer,
  optionNames,
  recordingBridge,
  refusingEnumerationBridge,
  registeredIds,
  typeIntoLine,
} from "./provider-command-discovery.test-support.js";

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
