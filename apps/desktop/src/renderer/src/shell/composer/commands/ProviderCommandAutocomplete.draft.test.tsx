// The discovery surface against a draft that is written from somewhere else.
//
// Its own file because the claim is the inverse of the one next door: those cases
// type into the line and watch the surface follow, and these write the draft through
// the store and assert the surface follows THAT — the composer's line is a view of a
// draft it does not own, and a surface that only tracked keystrokes would be right
// about the common case and wrong about every recall, restore, and rebind.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { consoleCommands } from "../../../console/frame/command-surface.js";
import {
  type MountedComposer,
  QUEUE_CREATED,
  TEST_COMMAND_ID,
  UNMATCHED_PREFIX,
  composerBridgeAnswering,
  mountComposer,
  recordingBridge,
  registeredIds,
  typeIntoLine,
} from "./provider-command-discovery.test-support.js";

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
