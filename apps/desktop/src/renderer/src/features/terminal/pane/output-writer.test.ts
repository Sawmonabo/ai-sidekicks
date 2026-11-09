// The output writer against the real emulator: frames land in order with a character split
// across two frames drawn whole, a drop's fresh scrollback redraws so no earlier byte shows twice,
// and the backlog says when the pane is behind and when it has caught up.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  TerminalId,
  TerminalOutputChange,
  TerminalOutputFrame,
} from "@ai-sidekicks/contracts/terminal";

import { disposeLiveEmulators, mountedAdapter } from "../emulator/xterm/adapter.test-support.js";
import { OUTPUT_BEHIND_BYTES, ShellOutputWriter } from "./output-writer.js";

afterEach(disposeLiveEmulators);

const SHELL = {
  sessionId: "019b7b30-0280-79a4-8110-cca0117a0135" as SessionId,
  terminalId: "terminal-1" as TerminalId,
};

function outputOf(data: Uint8Array, cursor: number): TerminalOutputChange {
  return { kind: "output", ...SHELL, data, cursor };
}

function scrollbackOf(text: string, cursor: number): TerminalOutputChange {
  const data = new TextEncoder().encode(text);
  return {
    kind: "scrollback",
    ...SHELL,
    data,
    columns: 80,
    rows: 24,
    holder: null,
    leaseVersion: 0,
    cursor,
  };
}

function frameOf(
  ...changes: [TerminalOutputChange, ...TerminalOutputChange[]]
): TerminalOutputFrame {
  return { changes };
}

describe("the shell's output writer", () => {
  it("writes frames in order and draws a character split across two frames whole", async () => {
    const { adapter } = mountedAdapter();
    const writer = new ShellOutputWriter(adapter, () => undefined);
    const bytes = new TextEncoder().encode("one café two\n");
    // The split falls inside `é`, whose two bytes sit at 7 and 8.
    writer.apply(frameOf(scrollbackOf("window\n", 7)));
    writer.apply(frameOf(outputOf(bytes.subarray(0, 8), 15)));
    writer.apply(frameOf(outputOf(bytes.subarray(8), 20)));

    await vi.waitFor(() => {
      expect(adapter.serialize()).toContain("one café two");
    });
    expect(adapter.serialize().indexOf("window")).toBeLessThan(
      adapter.serialize().indexOf("one café two"),
    );
  });

  it("redraws from a drop's fresh scrollback, so no earlier byte shows twice", async () => {
    const { adapter } = mountedAdapter();
    const writer = new ShellOutputWriter(adapter, () => undefined);
    writer.apply(frameOf(outputOf(new TextEncoder().encode("first line\n"), 11)));
    // The window covers what was already drawn and what this pane missed while behind.
    writer.apply({
      dropped: true,
      changes: [
        scrollbackOf("first line\nmissed line\n", 23),
        outputOf(new TextEncoder().encode("after the drop\n"), 38),
      ],
    });

    await vi.waitFor(() => {
      expect(adapter.serialize()).toContain("after the drop");
    });
    const drawn = adapter.serialize();
    expect(drawn.split("first line")).toHaveLength(2);
    expect(drawn).toContain("missed line");
  });

  it("says it is behind past the high mark, caught up once parsed, and caught up on close", async () => {
    const { adapter } = mountedAdapter();
    const behindChanges: boolean[] = [];
    const writer = new ShellOutputWriter(adapter, (isBehind) => {
      behindChanges.push(isBehind);
    });
    const burst = new TextEncoder().encode("x".repeat(OUTPUT_BEHIND_BYTES + 1));
    writer.apply(frameOf(outputOf(burst, burst.length)));
    expect(behindChanges).toStrictEqual([true]);

    await vi.waitFor(() => {
      expect(behindChanges).toStrictEqual([true, false]);
    });

    writer.apply(frameOf(outputOf(burst, burst.length * 2)));
    writer.close();
    expect(behindChanges).toStrictEqual([true, false, true, false]);
  });
});
