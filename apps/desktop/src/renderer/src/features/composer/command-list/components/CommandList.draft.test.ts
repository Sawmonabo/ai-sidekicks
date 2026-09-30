// The command list against a draft written from somewhere else. The composer's line is a view
// of a draft it does not own, so a list that only tracked keystrokes would be wrong about every
// restore and rebind.

import { describe, expect, it } from "vitest";
import { UNMATCHED_PREFIX, mountComposer, typeIntoLine } from "../command-list.test-support.js";
import { recordingBridge } from "../provider-command-enumeration.test-support.js";

describe("CommandList — the list follows every write to the draft", () => {
  /** Whether the discovery popover is on screen at all. */
  function isPopoverOpen(container: HTMLElement): boolean {
    return container.querySelector(".meridian-command-discovery") !== null;
  }

  it("closes when a write replaces the line with ordinary text", async () => {
    // The list subscribed to the line's native `input` event, which fires for typing only, so
    // a draft-store write left the popover open over a line that had stopped being a command.
    const mounted = await mountComposer({ bridge: recordingBridge([]), focusedPane: undefined });
    await typeIntoLine(mounted.line, UNMATCHED_PREFIX);
    expect(isPopoverOpen(mounted.container)).toBe(true);

    await mounted.writeDraft("ship the parser fix");

    expect(mounted.line.value).toBe("ship the parser fix");
    expect(isPopoverOpen(mounted.container)).toBe(false);
  });

  it("opens when a write hands back a slash line", async () => {
    // The other direction: the write brings the command line back and the list must follow.
    const mounted = await mountComposer({ bridge: recordingBridge([]), focusedPane: undefined });
    await mounted.writeDraft("ship the parser fix");
    expect(isPopoverOpen(mounted.container)).toBe(false);

    await mounted.writeDraft(UNMATCHED_PREFIX);

    expect(mounted.line.value).toBe(UNMATCHED_PREFIX);
    expect(isPopoverOpen(mounted.container)).toBe(true);
  });

  it("closes when a write empties the line", async () => {
    // A draft cleared from elsewhere, with no keystroke in the textarea, must not
    // leave the popover standing over an empty line.
    const mounted = await mountComposer({ bridge: recordingBridge([]), focusedPane: undefined });
    await typeIntoLine(mounted.line, "/");
    expect(isPopoverOpen(mounted.container)).toBe(true);

    await mounted.writeDraft("");

    expect(mounted.line.value).toBe("");
    expect(isPopoverOpen(mounted.container)).toBe(false);
  });

  it("negative control: typing still opens and closes it", async () => {
    // Without this, a hook that stopped reading the line altogether would pass above.
    const mounted = await mountComposer({ bridge: recordingBridge([]), focusedPane: undefined });

    await typeIntoLine(mounted.line, "/");
    expect(isPopoverOpen(mounted.container)).toBe(true);

    await typeIntoLine(mounted.line, "ordinary prose");
    expect(isPopoverOpen(mounted.container)).toBe(false);
  });
});
